import * as k8s from '@kubernetes/client-node';
import {
  applicationPhaseGauge,
  reconcileCounter,
  phaseToNumber,
} from '../metrics';

const GROUP = 'platform.internal';
const VERSION = 'v1alpha1';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface AppSpec {
  environment: string;
  database?: { enabled: boolean };
  storage?: { enabled: boolean };
  auth?: { enabled: boolean };
  domain?: string;
}

export async function updateApplicationStatus(
  appName: string,
  namespace: string,
  spec: AppSpec,
): Promise<void> {
  const conditions: Condition[] = [];
  const environment = spec.environment;

  // --- Database check ---
  if (spec.database?.enabled) {
    try {
      await coreApi.readNamespacedSecret(`${appName}-db`, namespace);
      conditions.push({
        type: 'DatabaseReady',
        status: 'True',
        reason: 'SecretFound',
        lastTransitionTime: new Date().toISOString(),
      });
    } catch (err: any) {
      const code = err?.response?.statusCode || err?.statusCode || err?.code;
      if (code === 404) {
        conditions.push({
          type: 'DatabaseReady',
          status: 'False',
          reason: 'SecretNotFound',
          lastTransitionTime: new Date().toISOString(),
        });
      }
    }
  }

  // --- Storage check ---
  if (spec.storage?.enabled) {
    try {
      await coreApi.readNamespacedConfigMap(`${appName}-storage`, namespace);
      conditions.push({
        type: 'StorageReady',
        status: 'True',
        reason: 'ConfigMapFound',
        lastTransitionTime: new Date().toISOString(),
      });
    } catch (err: any) {
      const code = err?.response?.statusCode || err?.statusCode || err?.code;
      if (code === 404) {
        conditions.push({
          type: 'StorageReady',
          status: 'False',
          reason: 'ConfigMapNotFound',
          lastTransitionTime: new Date().toISOString(),
        });
      }
    }
  }

  // --- Auth check ---
  if (spec.auth?.enabled) {
    try {
      await coreApi.readNamespacedConfigMap(`${appName}-auth`, namespace);
      conditions.push({
        type: 'AuthReady',
        status: 'True',
        reason: 'ConfigMapFound',
        lastTransitionTime: new Date().toISOString(),
      });
    } catch (err: any) {
      const code = err?.response?.statusCode || err?.statusCode || err?.code;
      if (code === 404) {
        conditions.push({
          type: 'AuthReady',
          status: 'False',
          reason: 'ConfigMapNotFound',
          message: `ConfigMap "${appName}-auth" not found`,
          lastTransitionTime: new Date().toISOString(),
        });
      }
    }
  }

  // --- Deployment check ---
  try {
    const res = await appsApi.readNamespacedDeployment(appName, namespace) as any;
    const deploy = res.body || res;
    const desired = deploy.spec?.replicas || 0;
    const ready = deploy.status?.readyReplicas || 0;

    if (ready >= desired && desired > 0) {
      conditions.push({
        type: 'DeploymentReady',
        status: 'True',
        reason: 'ReplicasReady',
        message: `${ready}/${desired} replicas ready`,
        lastTransitionTime: new Date().toISOString(),
      });
    } else {
      conditions.push({
        type: 'DeploymentReady',
        status: 'False',
        reason: 'ReplicasNotReady',
        message: `${ready}/${desired} replicas ready`,
        lastTransitionTime: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    const code = err?.response?.statusCode || err?.statusCode || err?.code;
    if (code === 404) {
      conditions.push({
        type: 'DeploymentReady',
        status: 'Unknown',
        reason: 'DeploymentNotFound',
        lastTransitionTime: new Date().toISOString(),
      });
    }
  }

  // --- Derive phase ---
  const allTrue = conditions.every(c => c.status === 'True');
  const anyFalse = conditions.some(c => c.status === 'False');
  let phase: string;

  if (allTrue) {
    phase = 'Running';
  } else if (anyFalse) {
    // Check if it's a hard failure (missing resources) vs just scaling
    const hardFailure = conditions.some(
      c => c.status === 'False' && (c.reason === 'SecretNotFound' || c.reason === 'ConfigMapNotFound'),
    );
    phase = hardFailure ? 'Failed' : 'Provisioning';
  } else {
    phase = 'Provisioning';
  }

  // Compute URL
  const baseDomain = process.env.BASE_DOMAIN || 'platform.company.dev';
  let domain = spec.domain;
  if (!domain) {
    domain = environment === 'production'
      ? `${appName}.${baseDomain}`
      : `${appName}.${environment}.${baseDomain}`;
  }

  // --- Patch status ---
  const status: any = {
    phase,
    conditions,
    url: `https://${domain}`,
  };

  try {
    await customApi.patchNamespacedCustomObjectStatus(
      GROUP, VERSION, namespace, 'applications', appName,
      [{ op: 'replace', path: '/status', value: status }],
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } },
    );
    console.log(`  Status updated to ${phase}`);
  } catch (err: any) {
    console.error(`  Failed to update status: ${err.message}`);
  }

  // --- Update metrics ---
  applicationPhaseGauge.set({ app: appName, environment }, phaseToNumber(phase));
  reconcileCounter.inc({ app: appName, resource_type: 'application', result: 'success' });
}
