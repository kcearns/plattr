import { Pool } from 'pg';
import * as k8s from '@kubernetes/client-node';
import { randomBytes } from 'crypto';
import { generateInitSQL, generateCleanupSQL } from '@plattr/shared';
import { withRetry } from '../lib/retry';
import { getDbAdminUrl } from '../lib/secrets-manager';

let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (!pool) {
    const dbUrl = await getDbAdminUrl();
    pool = new Pool({
      connectionString: dbUrl,
      max: 5,
    });
  }
  return pool;
}

function prefixedNames(appName: string, schemaName: string, environment: string): {
  prefixedApp: string;
  prefixedSchema: string;
} {
  if (environment === 'preview') {
    // Preview names are pre-computed by the preview reconciler (already include PR number)
    const sanitizedApp = appName.replace(/-/g, '_');
    return { prefixedApp: sanitizedApp, prefixedSchema: schemaName };
  }
  const prefix = environment === 'production' ? 'prod' : environment;
  const sanitizedApp = appName.replace(/-/g, '_');
  return {
    prefixedApp: `${prefix}_${sanitizedApp}`,
    prefixedSchema: `${prefix}_${schemaName}`,
  };
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

export async function reconcileDatabase(
  appName: string,
  schemaName: string,
  namespace: string,
  environment: string,
): Promise<{ ready: boolean; error?: string }> {
  try {
    const pg = await getPool();
    const password = randomBytes(32).toString('hex');
    const { prefixedApp, prefixedSchema } = prefixedNames(appName, schemaName, environment);

    console.log(`  [DB] Running init SQL for schema "${prefixedSchema}"...`);
    await withRetry(async () => {
      const sql = generateInitSQL(prefixedApp, prefixedSchema, password);
      await pg.query(sql);
    }, { maxRetries: 3 });
    console.log(`  [DB] Schema and roles created successfully`);

    const dbHost = process.env.DB_HOST || 'localhost';
    const dbName = process.env.DB_NAME || 'plattr';

    const secretName = `${appName}-db`;
    const secretData: Record<string, string> = {
      DATABASE_URL: `postgresql://${prefixedApp}_app:${password}@${dbHost}:5432/${dbName}?search_path=${prefixedSchema}`,
      DB_HOST: dbHost,
      DB_NAME: dbName,
      DB_USER: `${prefixedApp}_app`,
      DB_PASSWORD: password,
      DB_SCHEMA: prefixedSchema,
    };

    const secret: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace,
        labels: {
          'platform.internal/app': appName,
          'platform.internal/managed-by': 'plattr-operator',
        },
      },
      stringData: secretData,
    };

    try {
      await coreApi.createNamespacedSecret(namespace, secret);
      console.log(`  [DB] Secret "${secretName}" created`);
    } catch (err: any) {
      if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
        await coreApi.replaceNamespacedSecret(secretName, namespace, secret);
        console.log(`  [DB] Secret "${secretName}" updated (already existed)`);
      } else {
        throw err;
      }
    }

    return { ready: true };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [DB] Error: ${message}`);
    return { ready: false, error: message };
  }
}

export async function cleanupDatabase(
  appName: string,
  schemaName: string,
  namespace: string,
  environment: string,
): Promise<void> {
  try {
    const pg = await getPool();
    const { prefixedApp, prefixedSchema } = prefixedNames(appName, schemaName, environment);

    console.log(`  [DB] Running cleanup SQL for "${prefixedSchema}"...`);
    const sql = generateCleanupSQL(prefixedApp, prefixedSchema);
    await pg.query(sql);
    console.log(`  [DB] Roles revoked and dropped`);

    const secretName = `${appName}-db`;
    try {
      await coreApi.deleteNamespacedSecret(secretName, namespace);
      console.log(`  [DB] Secret "${secretName}" deleted`);
    } catch (err: any) {
      if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
        console.log(`  [DB] Secret "${secretName}" already gone`);
      } else {
        throw err;
      }
    }
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [DB] Cleanup error: ${message}`);
  }
}
