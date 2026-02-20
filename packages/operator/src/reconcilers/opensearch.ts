import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

function indexPrefix(appName: string, environment: string): string {
  if (environment === 'preview') {
    return appName.replace(/-/g, '_');
  }
  const prefix = environment === 'production' ? 'prod' : environment;
  return `${prefix}_${appName.replace(/-/g, '_')}`;
}

/**
 * Reconcile OpenSearch access for an application.
 *
 * - **Managed mode** (OPENSEARCH_ENDPOINT env var set): OpenSearch Service is
 *   pre-provisioned by CDK. Creates a ConfigMap pointing to the managed endpoint.
 * - **Container mode** (no OPENSEARCH_ENDPOINT): OpenSearch runs as a pod in
 *   plattr-system. Creates a ConfigMap pointing to the in-cluster service.
 */
export async function reconcileOpenSearch(
  appName: string,
  namespace: string,
  environment: string,
): Promise<{ ready: boolean; error?: string }> {
  try {
    const managedEndpoint = process.env.OPENSEARCH_ENDPOINT;
    const opensearchUrl = managedEndpoint
      ? `https://${managedEndpoint}`
      : 'http://opensearch.plattr-system:9200';

    const prefix = indexPrefix(appName, environment);

    console.log(`  [SEARCH] Mode: ${managedEndpoint ? 'managed' : 'container'}`);
    console.log(`  [SEARCH] URL: ${opensearchUrl}`);
    console.log(`  [SEARCH] Index prefix: ${prefix}`);

    const configMapName = `${appName}-search`;
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
        OPENSEARCH_URL: opensearchUrl,
        OPENSEARCH_INDEX_PREFIX: prefix,
      },
    };

    try {
      await coreApi.createNamespacedConfigMap(namespace, configMap);
      console.log(`  [SEARCH] ConfigMap "${configMapName}" created`);
    } catch (err: any) {
      if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
        await coreApi.replaceNamespacedConfigMap(configMapName, namespace, configMap);
        console.log(`  [SEARCH] ConfigMap "${configMapName}" updated (already existed)`);
      } else {
        throw err;
      }
    }

    return { ready: true };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [SEARCH] Error: ${message}`);
    return { ready: false, error: message };
  }
}

export async function cleanupOpenSearch(
  appName: string,
  namespace: string,
): Promise<void> {
  const configMapName = `${appName}-search`;
  try {
    await coreApi.deleteNamespacedConfigMap(configMapName, namespace);
    console.log(`  [SEARCH] ConfigMap "${configMapName}" deleted`);
  } catch (err: any) {
    if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
      console.log(`  [SEARCH] ConfigMap "${configMapName}" already gone`);
    } else {
      console.error(`  [SEARCH] Error deleting ConfigMap: ${(err as Error).message}`);
    }
  }
}
