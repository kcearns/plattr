import * as k8s from '@kubernetes/client-node';
import { cleanupPreview } from '../reconcilers/preview';

const GROUP = 'platform.internal';
const VERSION = 'v1alpha1';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

async function ttlSweep(): Promise<void> {
  try {
    const res = await customApi.listNamespacedCustomObject(
      GROUP, VERSION, 'default', 'previewenvironments',
    ) as any;

    // v0.22.3: response may be wrapped in .body
    const data = res.body || res;
    const items = data.items || [];
    const now = Date.now();
    console.log(`[TTL] Sweep: checking ${items.length} preview(s)`);

    for (const item of items) {
      const name = item.metadata?.name;
      const namespace = item.metadata?.namespace || 'default';
      const expiresAt = item.status?.expiresAt;

      if (!expiresAt) continue;

      const expiryTime = new Date(expiresAt).getTime();
      if (isNaN(expiryTime)) continue;

      if (expiryTime <= now) {
        console.log(`[TTL] Preview "${name}" expired at ${expiresAt}`);

        // Clean up all preview resources
        await cleanupPreview(name, namespace, item.spec);

        // Delete the PreviewEnvironment CR itself
        try {
          await customApi.deleteNamespacedCustomObject(
            GROUP, VERSION, namespace, 'previewenvironments', name,
          );
          console.log(`[TTL] PreviewEnvironment "${name}" deleted`);
        } catch (err: any) {
          if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
            console.log(`[TTL] PreviewEnvironment "${name}" already gone`);
          } else {
            console.error(`[TTL] Error deleting PreviewEnvironment "${name}": ${err.message}`);
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[TTL] Sweep error: ${err.message}`);
  }
}

export function startTTLController(intervalMs: number = 5 * 60 * 1000): void {
  console.log(`[TTL] Starting TTL controller (interval: ${intervalMs / 1000}s)`);
  ttlSweep();
  setInterval(ttlSweep, intervalMs);
}
