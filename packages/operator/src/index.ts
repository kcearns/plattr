import * as k8s from '@kubernetes/client-node';
import { reconcileDatabase, cleanupDatabase } from './reconcilers/database';
import { reconcileStorage, cleanupStorage } from './reconcilers/storage';
import { reconcileRedis, cleanupRedis } from './reconcilers/redis';
import { reconcileOpenSearch, cleanupOpenSearch } from './reconcilers/opensearch';
import { reconcileWorkload, cleanupWorkload } from './reconcilers/workload';
import { reconcilePreview, cleanupPreview } from './reconcilers/preview';
import { reconcileAuth, cleanupAuth } from './reconcilers/auth';
import { updateApplicationStatus } from './reconcilers/status';
import { startTTLController } from './controllers/ttl';
import { withRetry } from './lib/retry';
import { getIsLeader, startLeaderElection } from './lib/leader';
import {
  startMetricsServer,
  reconcileCounter,
  provisioningDuration,
  previewEnvironmentsActive,
} from './metrics';

const GROUP = 'platform.internal';
const VERSION = 'v1alpha1';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

// Track last reconciled generation per resource to avoid re-reconciling on status-only changes
const reconciledGenerations = new Map<string, number>();

interface ApplicationSpec {
  repository: string;
  branch?: string;
  framework: string;
  environment: string;
  imageRef?: string;
  database?: { enabled: boolean; schemaName?: string; migrations?: { path?: string; engine?: string } };
  storage?: { enabled: boolean; buckets?: Array<{ name: string; public: boolean; maxFileSize?: string }> };
  auth?: { enabled: boolean; providers?: string[] };
  redis?: { enabled: boolean };
  search?: { enabled: boolean };
  scaling?: { min?: number; max?: number; targetCPU?: number };
  domain?: string;
}

interface PreviewSpec {
  applicationRef: string;
  pullRequest: number;
  branch: string;
  ttl?: string;
}

// ─── Reconciliation Logic ───────────────────────────────────────────

async function reconcileApplication(name: string, namespace: string, spec: ApplicationSpec): Promise<void> {
  const { framework, environment, database, storage } = spec;

  console.log(`[RECONCILE] Application "${name}" in "${namespace}"`);
  console.log(`  Framework: ${framework}`);
  console.log(`  Environment: ${environment}`);

  // --- Database ---
  if (database?.enabled) {
    const schemaName = database.schemaName || name.replace(/-/g, '_');
    const dbResult = await reconcileDatabase(name, schemaName, namespace, environment);
    if (!dbResult.ready) {
      console.error(`  Database provisioning failed: ${dbResult.error}`);
      return;
    }
    console.log(`  Database: ready`);
  }

  // --- Storage ---
  if (storage?.enabled && storage.buckets?.length) {
    const storageResult = await reconcileStorage(name, storage.buckets, namespace, environment);
    if (!storageResult.ready) {
      console.error(`  Storage provisioning failed: ${storageResult.error}`);
      return;
    }
    console.log(`  Storage: ready`);
  }

  // --- Auth ---
  const baseDomain = process.env.BASE_DOMAIN || 'platform.company.dev';

  let domain = spec.domain;
  if (!domain) {
    if (environment === 'production') {
      domain = `${name}.${baseDomain}`;
    } else {
      domain = `${name}.${environment}.${baseDomain}`;
    }
  }

  if (spec.auth?.enabled) {
    const authResult = await reconcileAuth(
      name,
      spec.auth.providers || [],
      namespace,
      domain,
    );
    if (!authResult.ready) {
      console.error(`  Auth provisioning failed: ${authResult.error}`);
      // Don't block — auth failure shouldn't prevent app deployment
    } else {
      console.log(`  Auth: ready`);
    }
  }

  // --- Redis ---
  if (spec.redis?.enabled) {
    const redisResult = await reconcileRedis(name, namespace, environment);
    if (!redisResult.ready) {
      console.error(`  Redis provisioning failed: ${redisResult.error}`);
    } else {
      console.log(`  Redis: ready`);
    }
  }

  // --- OpenSearch ---
  if (spec.search?.enabled) {
    const searchResult = await reconcileOpenSearch(name, namespace, environment);
    if (!searchResult.ready) {
      console.error(`  OpenSearch provisioning failed: ${searchResult.error}`);
    } else {
      console.log(`  OpenSearch: ready`);
    }
  }

  // --- Workload ---
  await reconcileWorkload({
    name,
    namespace,
    imageRef: spec.imageRef,
    framework,
    environment,
    database: spec.database,
    storage: spec.storage,
    auth: spec.auth,
    redis: spec.redis,
    search: spec.search,
    scaling: {
      min: spec.scaling?.min ?? 2,
      max: spec.scaling?.max ?? 20,
      targetCPU: spec.scaling?.targetCPU ?? 70,
    },
    domain,
  });

  // Status reconciler checks actual state and derives the phase
  await updateApplicationStatus(name, namespace, spec);

  console.log(`[RECONCILE] "${name}" reconciliation complete`);
}

async function cleanupApplication(name: string, namespace: string, spec: ApplicationSpec | undefined): Promise<void> {
  console.log(`[CLEANUP] Application "${name}" in "${namespace}"`);
  const environment = spec?.environment || 'production';

  // Clean up auth
  if (spec?.auth?.enabled) {
    await cleanupAuth(name, namespace);
  }

  // Clean up Redis
  if (spec?.redis?.enabled) {
    await cleanupRedis(name, namespace);
  }

  // Clean up OpenSearch
  if (spec?.search?.enabled) {
    await cleanupOpenSearch(name, namespace);
  }

  // Clean up workload resources first (stop the app)
  await cleanupWorkload(name, namespace);

  // Then clean up storage
  if (spec?.storage?.enabled && spec?.storage?.buckets?.length) {
    await cleanupStorage(name, spec.storage.buckets, namespace, environment);
  }

  // Then clean up database
  if (spec?.database?.enabled) {
    const schemaName = spec.database.schemaName || name.replace(/-/g, '_');
    await cleanupDatabase(name, schemaName, namespace, environment);
  }
}

// ─── Event Handlers with Retry ──────────────────────────────────────

async function handleAppEvent(type: string, obj: any): Promise<void> {
  if (!getIsLeader()) return;

  const name = obj.metadata?.name || 'unknown';
  const namespace = obj.metadata?.namespace || 'default';
  const spec = obj.spec as ApplicationSpec | undefined;
  const generation = obj.metadata?.generation || 0;

  if (type === 'ADDED' || type === 'MODIFIED') {
    const key = `${namespace}/${name}`;
    const lastGen = reconciledGenerations.get(key);
    if (lastGen !== undefined && lastGen >= generation) {
      return;
    }
    reconciledGenerations.set(key, generation);

    console.log(`\n--- Application ${type}: ${name} ---`);
    if (spec?.environment === 'local') {
      console.log('  Skipping local environment (handled by Dagger)');
      return;
    }

    if (!spec) return;

    const timer = provisioningDuration.startTimer({ app: name, resource_type: 'application' });

    try {
      await withRetry(() => reconcileApplication(name, namespace, spec), {
        maxRetries: 3,
        onRetry: (attempt, err) => {
          console.warn(`  [RETRY] Reconcile "${name}" attempt ${attempt}: ${err.message}`);
          reconcileCounter.inc({ app: name, resource_type: 'application', result: 'retry' });
        },
      });
    } catch (err: any) {
      console.error(`[ERROR] Final reconcile failure for "${name}": ${err.message}`);
      reconcileCounter.inc({ app: name, resource_type: 'application', result: 'error' });
    } finally {
      timer();
    }
  } else if (type === 'DELETED') {
    reconciledGenerations.delete(`${namespace}/${name}`);
    console.log(`\n--- Application DELETED: ${name} ---`);

    try {
      await withRetry(() => cleanupApplication(name, namespace, spec), { maxRetries: 2 });
    } catch (err: any) {
      console.error(`[ERROR] Cleanup failure for "${name}": ${err.message}`);
    }
  }
}

async function handlePreviewEvent(type: string, obj: any): Promise<void> {
  if (!getIsLeader()) return;

  const name = obj.metadata?.name || 'unknown';
  const namespace = obj.metadata?.namespace || 'default';
  const spec = obj.spec as PreviewSpec | undefined;
  const generation = obj.metadata?.generation || 0;

  if (type === 'ADDED' || type === 'MODIFIED') {
    const key = `preview/${namespace}/${name}`;
    const lastGen = reconciledGenerations.get(key);
    if (lastGen !== undefined && lastGen >= generation) {
      return;
    }
    reconciledGenerations.set(key, generation);
    console.log(`\n--- PreviewEnvironment ${type}: ${name} ---`);
    if (spec) {
      try {
        await withRetry(() => reconcilePreview(name, namespace, spec), { maxRetries: 3 });
        previewEnvironmentsActive.inc();
      } catch (err: any) {
        console.error(`[ERROR] Preview reconcile failure for "${name}": ${err.message}`);
      }
    }
  } else if (type === 'DELETED') {
    reconciledGenerations.delete(`preview/${namespace}/${name}`);
    console.log(`\n--- PreviewEnvironment DELETED: ${name} ---`);
    if (spec) {
      try {
        await withRetry(() => cleanupPreview(name, namespace, spec), { maxRetries: 2 });
      } catch (err: any) {
        console.error(`[ERROR] Preview cleanup failure for "${name}": ${err.message}`);
      }
      previewEnvironmentsActive.dec();
    }
  }
}

// ─── Informer Setup ─────────────────────────────────────────────────

function makeListFn(plural: string) {
  return async () => {
    const res = await customApi.listClusterCustomObject(GROUP, VERSION, plural) as any;
    return res;
  };
}

const appInformer = k8s.makeInformer(
  kc,
  `/apis/${GROUP}/${VERSION}/applications`,
  makeListFn('applications') as any,
);

appInformer.on('add', (obj: any) => handleAppEvent('ADDED', obj));
appInformer.on('update', (obj: any) => handleAppEvent('MODIFIED', obj));
appInformer.on('delete', (obj: any) => handleAppEvent('DELETED', obj));
appInformer.on('error', (err: any) => {
  console.error('[INFORMER] Application informer error:', err);
  // Informer auto-reconnects — restart after a delay
  setTimeout(() => appInformer.start(), 5000);
});

const previewInformer = k8s.makeInformer(
  kc,
  `/apis/${GROUP}/${VERSION}/previewenvironments`,
  makeListFn('previewenvironments') as any,
);

previewInformer.on('add', (obj: any) => handlePreviewEvent('ADDED', obj));
previewInformer.on('update', (obj: any) => handlePreviewEvent('MODIFIED', obj));
previewInformer.on('delete', (obj: any) => handlePreviewEvent('DELETED', obj));
previewInformer.on('error', (err: any) => {
  console.error('[INFORMER] PreviewEnvironment informer error:', err);
  setTimeout(() => previewInformer.start(), 5000);
});

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=============================================');
  console.log('  Plattr Operator v0.2.0');
  console.log('=============================================');

  // Start metrics server
  startMetricsServer(9090);

  // Start leader election (if enabled)
  if (process.env.LEADER_ELECTION === 'true') {
    startLeaderElection();
  }

  // Start informers
  await appInformer.start();
  await previewInformer.start();

  // Start TTL controller
  startTTLController();

  console.log('Operator is running. Watching for resources...');
}

main().catch((err: Error) => {
  console.error('[OPERATOR] Fatal error:', err.message);
  process.exit(1);
});
