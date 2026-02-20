import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);

interface WorkloadSpec {
  name: string;
  namespace: string;
  imageRef?: string;
  framework: string;
  environment: string;
  database?: { enabled: boolean; schemaName?: string };
  storage?: { enabled: boolean };
  auth?: { enabled: boolean };
  redis?: { enabled: boolean };
  search?: { enabled: boolean };
  scaling: { min: number; max: number; targetCPU: number };
  domain: string;
}

async function upsert<T>(
  createFn: () => Promise<T>,
  replaceFn: () => Promise<T>,
  resourceName: string,
): Promise<void> {
  try {
    await createFn();
    console.log(`  [WORKLOAD] ${resourceName} created`);
  } catch (err: any) {
    if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
      await replaceFn();
      console.log(`  [WORKLOAD] ${resourceName} updated`);
    } else {
      throw err;
    }
  }
}

export async function reconcileWorkload(spec: WorkloadSpec): Promise<void> {
  const { name, namespace, imageRef, framework, environment, database, storage, auth, redis, search, scaling, domain } = spec;

  const labels: Record<string, string> = {
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/managed-by': 'plattr-operator',
    'platform.internal/environment': environment,
  };

  const image = imageRef || 'nginx:alpine';

  // --- ServiceAccount ---
  const serviceAccount: k8s.V1ServiceAccount = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name, namespace, labels,
      annotations: {},
    },
  };

  await upsert(
    () => coreApi.createNamespacedServiceAccount(namespace, serviceAccount),
    () => coreApi.replaceNamespacedServiceAccount(name, namespace, serviceAccount),
    `ServiceAccount/${name}`,
  );

  // --- Deployment ---
  const envFrom: k8s.V1EnvFromSource[] = [];
  if (database?.enabled) {
    envFrom.push({ secretRef: { name: `${name}-db` } });
  }
  if (storage?.enabled) {
    envFrom.push({ configMapRef: { name: `${name}-storage` } });
  }
  if (auth?.enabled) {
    envFrom.push({ configMapRef: { name: `${name}-auth`, optional: true } });
  }
  if (redis?.enabled) {
    envFrom.push({ configMapRef: { name: `${name}-redis` } });
  }
  if (search?.enabled) {
    envFrom.push({ configMapRef: { name: `${name}-search` } });
  }

  // App container env vars
  const appEnv: k8s.V1EnvVar[] = [];
  if (database?.enabled) {
    // If PostgREST sidecar is running, tell the app where to find it
    appEnv.push({ name: 'POSTGREST_URL', value: `https://${domain}/api/rest` });
    appEnv.push({ name: 'POSTGREST_INTERNAL_URL', value: 'http://localhost:3001' });
  }

  // Build containers list
  const containers: k8s.V1Container[] = [
    {
      name: 'app',
      image,
      ports: [{ containerPort: 3000 }],
      envFrom: envFrom.length > 0 ? envFrom : undefined,
      env: appEnv.length > 0 ? appEnv : undefined,
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1000m', memory: '512Mi' },
      },
      readinessProbe: {
        httpGet: { path: '/healthz', port: 3000 as any },
        initialDelaySeconds: 5,
        periodSeconds: 10,
      },
      livenessProbe: {
        httpGet: { path: '/healthz', port: 3000 as any },
        initialDelaySeconds: 15,
        periodSeconds: 20,
      },
    },
  ];

  // Add PostgREST sidecar when database is enabled
  if (database?.enabled) {
    const envPrefix = environment === 'production' ? 'prod' : environment;
    const prefixedSchema = environment === 'preview'
      ? name.replace(/-/g, '_')  // preview names already include PR number
      : `${envPrefix}_${(database.schemaName || name).replace(/-/g, '_')}`;
    const prefixedApp = environment === 'preview'
      ? name.replace(/-/g, '_')
      : `${envPrefix}_${name.replace(/-/g, '_')}`;

    containers.push({
      name: 'postgrest',
      image: 'postgrest/postgrest:v12.2.3',
      ports: [{ containerPort: 3001 }],
      env: [
        {
          name: 'PGRST_DB_URI',
          valueFrom: { secretKeyRef: { name: `${name}-db`, key: 'DATABASE_URL' } },
        },
        { name: 'PGRST_DB_SCHEMAS', value: prefixedSchema },
        { name: 'PGRST_DB_ANON_ROLE', value: `${prefixedApp}_anon` },
        { name: 'PGRST_SERVER_PORT', value: '3001' },
        // Auto-reload schema cache when tables change
        { name: 'PGRST_DB_CHANNEL_ENABLED', value: 'true' },
      ],
      resources: {
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '128Mi' },
      },
      readinessProbe: {
        httpGet: { path: '/', port: 3001 as any },
        initialDelaySeconds: 3,
        periodSeconds: 10,
      },
      livenessProbe: {
        httpGet: { path: '/', port: 3001 as any },
        initialDelaySeconds: 5,
        periodSeconds: 20,
      },
    } as any);
  }

  const deployment: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels },
    spec: {
      replicas: scaling.min,
      selector: { matchLabels: { 'app.kubernetes.io/name': name } },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: name,
          containers,
        },
      },
    },
  };

  await upsert(
    () => appsApi.createNamespacedDeployment(namespace, deployment),
    () => appsApi.replaceNamespacedDeployment(name, namespace, deployment),
    `Deployment/${name}`,
  );

  // --- Service ---
  const servicePorts: k8s.V1ServicePort[] = [
    { name: 'http', port: 80, targetPort: 3000 as any, protocol: 'TCP' },
  ];
  if (database?.enabled) {
    servicePorts.push({ name: 'postgrest', port: 3001, targetPort: 3001 as any, protocol: 'TCP' });
  }

  const service: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels },
    spec: {
      selector: { 'app.kubernetes.io/name': name },
      ports: servicePorts,
    },
  };

  await upsert(
    () => coreApi.createNamespacedService(namespace, service),
    () => coreApi.replaceNamespacedService(name, namespace, service),
    `Service/${name}`,
  );

  // --- Ingress (main app) ---
  const ingress: k8s.V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name, namespace, labels,
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        'external-dns.alpha.kubernetes.io/hostname': domain,
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [
        {
          hosts: [domain],
          secretName: `${name}-tls`,
        },
      ],
      rules: [
        {
          host: domain,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name,
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };

  await upsert(
    () => networkingApi.createNamespacedIngress(namespace, ingress),
    () => networkingApi.replaceNamespacedIngress(name, namespace, ingress),
    `Ingress/${name}`,
  );

  // --- Ingress (PostgREST API) — separate Ingress with rewrite ---
  if (database?.enabled) {
    const postgrestIngress: k8s.V1Ingress = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `${name}-api`,
        namespace,
        labels,
        annotations: {
          'nginx.ingress.kubernetes.io/rewrite-target': '/$2',
          'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        },
      },
      spec: {
        ingressClassName: 'nginx',
        tls: [{ hosts: [domain], secretName: `${name}-tls` }],
        rules: [{
          host: domain,
          http: {
            paths: [{
              path: '/api/rest(/|$)(.*)',
              pathType: 'ImplementationSpecific',
              backend: { service: { name, port: { number: 3001 } } },
            }],
          },
        }],
      },
    };

    await upsert(
      () => networkingApi.createNamespacedIngress(namespace, postgrestIngress),
      () => networkingApi.replaceNamespacedIngress(`${name}-api`, namespace, postgrestIngress),
      `Ingress/${name}-api`,
    );
  }

  // --- HPA ---
  const hpa: k8s.V2HorizontalPodAutoscaler = {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name, namespace, labels },
    spec: {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name,
      },
      minReplicas: scaling.min,
      maxReplicas: scaling.max,
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: {
              type: 'Utilization',
              averageUtilization: scaling.targetCPU,
            },
          },
        },
      ],
    },
  };

  await upsert(
    () => autoscalingApi.createNamespacedHorizontalPodAutoscaler(namespace, hpa),
    () => autoscalingApi.replaceNamespacedHorizontalPodAutoscaler(name, namespace, hpa),
    `HPA/${name}`,
  );
}

export async function cleanupWorkload(name: string, namespace: string): Promise<void> {
  const resources = [
    { fn: () => autoscalingApi.deleteNamespacedHorizontalPodAutoscaler(name, namespace), type: 'HPA' },
    { fn: () => networkingApi.deleteNamespacedIngress(`${name}-api`, namespace), type: 'Ingress (API)' },
    { fn: () => networkingApi.deleteNamespacedIngress(name, namespace), type: 'Ingress' },
    { fn: () => coreApi.deleteNamespacedService(name, namespace), type: 'Service' },
    { fn: () => appsApi.deleteNamespacedDeployment(name, namespace), type: 'Deployment' },
    { fn: () => coreApi.deleteNamespacedServiceAccount(name, namespace), type: 'ServiceAccount' },
  ];

  for (const { fn, type } of resources) {
    try {
      await fn();
      console.log(`  [WORKLOAD] ${type}/${name} deleted`);
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
        console.log(`  [WORKLOAD] ${type}/${name} already gone`);
      } else {
        console.error(`  [WORKLOAD] Error deleting ${type}/${name}: ${err.message}`);
      }
    }
  }
}
