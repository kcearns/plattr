import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

/**
 * Reconcile Redis access for an application.
 *
 * - **Managed mode** (REDIS_ENDPOINT env var set): ElastiCache is pre-provisioned
 *   by CDK. Creates a ConfigMap pointing to the managed endpoint.
 * - **Container mode** (no REDIS_ENDPOINT): Redis runs as a pod in plattr-system.
 *   Creates a ConfigMap pointing to the in-cluster service.
 */
export async function reconcileRedis(
  appName: string,
  namespace: string,
  environment: string,
): Promise<{ ready: boolean; error?: string }> {
  try {
    const managedEndpoint = process.env.REDIS_ENDPOINT;
    const redisHost = managedEndpoint || 'redis.plattr-system';
    const redisPort = '6379';
    const redisUrl = `redis://${redisHost}:${redisPort}`;

    console.log(`  [REDIS] Mode: ${managedEndpoint ? 'managed' : 'container'}`);
    console.log(`  [REDIS] URL: ${redisUrl}`);

    const configMapName = `${appName}-redis`;
    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configMapName,
        namespace,
        labels: {
          'platform.internal/app': appName,
          'platform.internal/managed-by': 'plattr-operator',
        },
      },
      data: {
        REDIS_URL: redisUrl,
        REDIS_HOST: redisHost,
        REDIS_PORT: redisPort,
      },
    };

    try {
      await coreApi.createNamespacedConfigMap(namespace, configMap);
      console.log(`  [REDIS] ConfigMap "${configMapName}" created`);
    } catch (err: any) {
      if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
        await coreApi.replaceNamespacedConfigMap(configMapName, namespace, configMap);
        console.log(`  [REDIS] ConfigMap "${configMapName}" updated (already existed)`);
      } else {
        throw err;
      }
    }

    return { ready: true };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [REDIS] Error: ${message}`);
    return { ready: false, error: message };
  }
}

export async function cleanupRedis(
  appName: string,
  namespace: string,
): Promise<void> {
  const configMapName = `${appName}-redis`;
  try {
    await coreApi.deleteNamespacedConfigMap(configMapName, namespace);
    console.log(`  [REDIS] ConfigMap "${configMapName}" deleted`);
  } catch (err: any) {
    if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
      console.log(`  [REDIS] ConfigMap "${configMapName}" already gone`);
    } else {
      console.error(`  [REDIS] Error deleting ConfigMap: ${(err as Error).message}`);
    }
  }
}
