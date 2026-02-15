import * as k8s from '@kubernetes/client-node';
import { reconcileDatabase, cleanupDatabase } from './database';
import { reconcileStorage, cleanupStorage } from './storage';
import { reconcileWorkload, cleanupWorkload } from './workload';

const GROUP = 'platform.internal';
const VERSION = 'v1alpha1';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

interface PreviewSpec {
  applicationRef: string;
  pullRequest: number;
  branch: string;
  ttl?: string;
}

interface ApplicationSpec {
  repository: string;
  framework: string;
  environment: string;
  imageRef?: string;
  database?: { enabled: boolean; schemaName?: string };
  storage?: { enabled: boolean; buckets?: Array<{ name: string; public: boolean }> };
  scaling?: { min?: number; max?: number; targetCPU?: number };
  domain?: string;
}

export function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)(m|h|d)$/);
  if (!match) return 72 * 60 * 60 * 1000;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 72 * 60 * 60 * 1000;
  }
}

export async function reconcilePreview(name: string, namespace: string, spec: PreviewSpec): Promise<void> {
  const { applicationRef, pullRequest, branch, ttl = '72h' } = spec;

  console.log(`[PREVIEW] Provisioning PR #${pullRequest} for "${applicationRef}"`);

  // Compute preview-specific names
  const previewNamespace = `preview-${applicationRef}-pr-${pullRequest}`;
  const previewName = `${applicationRef}-pr${pullRequest}`;
  const previewSchema = `preview_${applicationRef.replace(/-/g, '_')}_pr${pullRequest}`;

  // Create namespace
  const nsBody: k8s.V1Namespace = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: previewNamespace,
      labels: {
        'platform.internal/type': 'preview',
        'platform.internal/app': applicationRef,
        'platform.internal/pr': String(pullRequest),
      },
    },
  };

  try {
    await coreApi.createNamespace(nsBody);
    console.log(`[PREVIEW] Namespace "${previewNamespace}" created`);
  } catch (err: any) {
    if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
      console.log(`[PREVIEW] Namespace "${previewNamespace}" already exists`);
    } else {
      throw err;
    }
  }

  // Fetch parent Application CRD
  let parentSpec: ApplicationSpec;
  try {
    const result = await customApi.getNamespacedCustomObject(
      GROUP, VERSION, 'default', 'applications', applicationRef,
    ) as any;
    // v0.22.3: response may be the object directly or wrapped in .body
    const parent = result.body || result;
    parentSpec = parent.spec;
    if (!parentSpec) {
      console.error(`[PREVIEW] Parent application "${applicationRef}" has no spec`);
      return;
    }
  } catch (err: any) {
    console.error(`[PREVIEW] Parent application "${applicationRef}" not found`);
    return;
  }

  // Provision database (if parent has it enabled)
  if (parentSpec.database?.enabled) {
    const dbResult = await reconcileDatabase(previewName, previewSchema, previewNamespace, 'preview');
    if (!dbResult.ready) {
      console.error(`[PREVIEW] Database provisioning failed: ${dbResult.error}`);
      return;
    }
  }

  // Provision storage (if parent has it enabled)
  if (parentSpec.storage?.enabled && parentSpec.storage.buckets?.length) {
    const storageResult = await reconcileStorage(previewName, parentSpec.storage.buckets, previewNamespace, 'preview');
    if (!storageResult.ready) {
      console.error(`[PREVIEW] Storage provisioning failed: ${storageResult.error}`);
      return;
    }
  }

  // Deploy workload
  const baseDomain = process.env.BASE_DOMAIN || 'platform.company.dev';
  const previewDomain = `pr-${pullRequest}.${applicationRef}.preview.${baseDomain}`;

  await reconcileWorkload({
    name: previewName,
    namespace: previewNamespace,
    imageRef: parentSpec.imageRef,
    framework: parentSpec.framework,
    environment: 'preview',
    database: parentSpec.database,
    storage: parentSpec.storage,
    scaling: { min: 1, max: 2, targetCPU: 80 },
    domain: previewDomain,
  });

  // Update PreviewEnvironment status
  const expiresAt = new Date(Date.now() + parseTTL(ttl)).toISOString();
  try {
    await customApi.patchNamespacedCustomObjectStatus(
      GROUP, VERSION, namespace, 'previewenvironments', name,
      [{ op: 'replace', path: '/status', value: {
        phase: 'Running',
        url: `https://${previewDomain}`,
        expiresAt,
      }}],
      undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } },
    );
  } catch (err: any) {
    console.error(`[PREVIEW] Failed to update status: ${err.message}`);
  }

  console.log(`[PREVIEW] PR #${pullRequest} ready at https://${previewDomain}`);
}

export async function cleanupPreview(name: string, namespace: string, spec: PreviewSpec): Promise<void> {
  const { applicationRef, pullRequest } = spec;

  console.log(`[PREVIEW] Cleaning up PR #${pullRequest}`);

  const previewNamespace = `preview-${applicationRef}-pr-${pullRequest}`;
  const previewName = `${applicationRef}-pr${pullRequest}`;
  const previewSchema = `preview_${applicationRef.replace(/-/g, '_')}_pr${pullRequest}`;

  // Clean up database
  await cleanupDatabase(previewName, previewSchema, previewNamespace, 'preview');

  // Clean up storage (fetch parent to get bucket list)
  try {
    const result = await customApi.getNamespacedCustomObject(
      GROUP, VERSION, 'default', 'applications', applicationRef,
    ) as any;
    const parent = result.body || result;
    const parentSpec: ApplicationSpec = parent.spec;
    if (parentSpec?.storage?.enabled && parentSpec.storage.buckets?.length) {
      await cleanupStorage(previewName, parentSpec.storage.buckets, previewNamespace, 'preview');
    }
  } catch (err: any) {
    console.warn(`[PREVIEW] Could not fetch parent "${applicationRef}" for storage cleanup — orphaned buckets may need manual cleanup`);
  }

  // Delete namespace (cascades all K8s resources)
  try {
    await coreApi.deleteNamespace(previewNamespace);
    console.log(`[PREVIEW] Namespace "${previewNamespace}" deleted`);
  } catch (err: any) {
    if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
      console.log(`[PREVIEW] Namespace "${previewNamespace}" already gone`);
    } else {
      console.error(`[PREVIEW] Error deleting namespace: ${err.message}`);
    }
  }
}
