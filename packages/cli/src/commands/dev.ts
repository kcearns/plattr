import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { loadConfig, type AppConfig } from '../lib/config';
import { getStateDir, killAllPids, appendPids, mergeEnvFile } from '../lib/state';

const NAMESPACE = 'plattr-local';
const CLUSTER_NAME = 'plattr';
const REGISTRY_NAME = 'plattr-registry';
const REGISTRY_PORT = 5050;

/**
 * Resolve the path to the bundled local infrastructure manifests.
 * Works from both dist/commands/ (compiled) and src/commands/ (tsx dev).
 */
function getManifestsPath(): string {
  // Compiled: dist/commands/ -> dist/manifests/local
  const compiled = join(__dirname, '..', 'manifests', 'local');
  if (existsSync(compiled)) return compiled;

  // Dev (tsx): src/commands/ -> ../../manifests/local (package root)
  const dev = join(__dirname, '..', '..', 'manifests', 'local');
  if (existsSync(dev)) return dev;

  console.error('Could not find infrastructure manifests. Ensure manifests/local/ exists in the CLI package.');
  process.exit(1);
}

/**
 * Check if a CLI tool is available.
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the Kind cluster exists.
 */
function clusterExists(): boolean {
  try {
    const clusters = execSync('kind get clusters', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return clusters.split('\n').includes(CLUSTER_NAME);
  } catch {
    return false;
  }
}

/**
 * Check if a Docker container is running by name.
 */
function containerRunning(name: string): boolean {
  try {
    const state = execSync(`docker inspect -f '{{.State.Running}}' ${name}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return state === 'true';
  } catch {
    return false;
  }
}

/**
 * Ensure the local container registry is running.
 */
function ensureRegistry(): void {
  if (containerRunning(REGISTRY_NAME)) return;

  // Container may exist but be stopped
  try {
    execSync(`docker start ${REGISTRY_NAME}`, { stdio: 'pipe' });
    return;
  } catch {
    // Doesn't exist yet
  }

  console.log('Starting local container registry...');
  execSync(
    `docker run -d --name ${REGISTRY_NAME} --restart always -p ${REGISTRY_PORT}:5000 registry:2`,
    { stdio: 'inherit' },
  );
}

/**
 * Connect the registry to the Kind network and configure containerd
 * on each node to resolve localhost:REGISTRY_PORT via the registry container.
 */
function connectRegistryToKind(): void {
  // Connect registry container to the Kind Docker network
  execSync(`docker network connect kind ${REGISTRY_NAME} 2>/dev/null || true`, { stdio: 'pipe' });

  // Configure containerd on each node to use the registry
  const nodes = execSync(`kind get nodes --name ${CLUSTER_NAME}`, {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim().split('\n').filter(Boolean);

  const registryDir = `/etc/containerd/certs.d/localhost:${REGISTRY_PORT}`;
  const hostsToml = `[host."http://${REGISTRY_NAME}:5000"]`;

  for (const node of nodes) {
    execSync(`docker exec ${node} mkdir -p ${registryDir}`, { stdio: 'pipe' });
    execSync(`docker exec -i ${node} sh -c 'cat > ${registryDir}/hosts.toml' <<'EOF'\n${hostsToml}\nEOF`, { stdio: 'pipe' });
    execSync(`docker exec ${node} systemctl restart containerd`, { stdio: 'pipe' });
  }

  // Wait briefly for containerd to restart and kubelet to reconnect
  execSync('sleep 3');

  // Apply the registry ConfigMap so K8s tooling knows about it
  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHost: "localhost:${REGISTRY_PORT}"`;

  execSync(`cat <<'EOF' | kubectl apply -f -\n${configMap}\nEOF`, { stdio: 'pipe' });
}

/**
 * Ensure the Kind cluster is created and kubectl context is set.
 */
function ensureCluster(): void {
  if (!commandExists('kind')) {
    console.error('Kind is required for local development. Install: https://kind.sigs.k8s.io/docs/user/quick-start/#installation');
    process.exit(1);
  }

  if (!commandExists('kubectl')) {
    console.error('kubectl is required for local development. Install: https://kubernetes.io/docs/tasks/tools/');
    process.exit(1);
  }

  // Ensure registry is running before creating the cluster
  ensureRegistry();

  if (!clusterExists()) {
    console.log('Creating local Plattr cluster...');
    execSync(`kind create cluster --name ${CLUSTER_NAME}`, { stdio: 'inherit' });

    // Connect registry to Kind and configure containerd on nodes
    connectRegistryToKind();
  }

  // Ensure kubectl context is set
  execSync(`kubectl cluster-info --context kind-${CLUSTER_NAME}`, { stdio: 'pipe' });
}

/**
 * Apply infrastructure manifests selectively based on config.
 * Namespace is always created first, then only enabled services are applied.
 */
function applyManifests(config: AppConfig): void {
  const manifestsPath = getManifestsPath();

  // Ensure namespace exists first
  execSync(
    `kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`,
    { stdio: 'inherit' },
  );

  // Always apply postgres
  execSync(`kubectl apply -f ${manifestsPath}/postgres.yaml`, { stdio: 'inherit' });

  // Conditionally apply optional services
  if (config.database?.enabled) {
    execSync(`kubectl apply -f ${manifestsPath}/postgrest.yaml`, { stdio: 'inherit' });
  }
  if (config.storage?.enabled) {
    execSync(`kubectl apply -f ${manifestsPath}/minio.yaml`, { stdio: 'inherit' });
  }
  if (config.auth?.enabled) {
    execSync(`kubectl apply -f ${manifestsPath}/keycloak.yaml`, { stdio: 'inherit' });
  }
}

/**
 * Wait for a deployment to be ready.
 */
function waitForDeployment(name: string, timeoutSeconds = 60): void {
  console.log(`  Waiting for ${name}...`);
  execSync(
    `kubectl rollout status deployment/${name} -n ${NAMESPACE} --timeout=${timeoutSeconds}s`,
    { stdio: 'inherit' },
  );
}

/**
 * Patch PostgREST env vars for the app's schema and anon role.
 */
function patchPostgrest(schemaName: string, anonRole: string): void {
  execSync(
    `kubectl set env deployment/plattr-postgrest -n ${NAMESPACE} PGRST_DB_SCHEMAS=${schemaName} PGRST_DB_ANON_ROLE=${anonRole}`,
    { stdio: 'pipe' },
  );
}

/**
 * Create the app schema if it doesn't exist.
 */
function ensureSchema(schemaName: string): void {
  execSync(
    `kubectl exec deploy/plattr-pg -n ${NAMESPACE} -- psql -U plattr -c "CREATE SCHEMA IF NOT EXISTS ${schemaName}"`,
    { stdio: 'pipe' },
  );
}

/**
 * Create the PostgREST anon role and grant schema usage.
 */
function ensureAnonRole(appName: string, schemaName: string): void {
  const anonRole = `${appName.replace(/-/g, '_')}_anon`;

  // Check if role exists (returns empty string if not)
  const result = execSync(
    `kubectl exec deploy/plattr-pg -n ${NAMESPACE} -- psql -U plattr -c "SELECT 1 FROM pg_roles WHERE rolname = '${anonRole}'" -tA`,
    { encoding: 'utf-8', stdio: 'pipe' },
  ).trim();

  if (!result) {
    execSync(
      `kubectl exec deploy/plattr-pg -n ${NAMESPACE} -- psql -U plattr -c "CREATE ROLE ${anonRole} NOLOGIN"`,
      { stdio: 'pipe' },
    );
  }

  execSync(
    `kubectl exec deploy/plattr-pg -n ${NAMESPACE} -- psql -U plattr -c "GRANT USAGE ON SCHEMA ${schemaName} TO ${anonRole}"`,
    { stdio: 'pipe' },
  );
}

/**
 * Create MinIO buckets for each bucket in config.
 */
function ensureBuckets(appName: string, buckets: Array<{ name: string; public: boolean }>): void {
  // Set up mc alias
  execSync(
    `kubectl exec deploy/plattr-minio -n ${NAMESPACE} -- mc alias set local http://localhost:9000 minioadmin minioadmin`,
    { stdio: 'pipe' },
  );

  for (const bucket of buckets) {
    const bucketName = `${appName}-${bucket.name}`;
    execSync(
      `kubectl exec deploy/plattr-minio -n ${NAMESPACE} -- mc mb --ignore-existing local/${bucketName}`,
      { stdio: 'pipe' },
    );
  }
}

/**
 * Build environment variables for localhost dev.
 */
function buildEnvVars(config: AppConfig): Record<string, string> {
  const appName = config.name;
  const schemaName = config.database?.schemaName || appName.replace(/-/g, '_');
  const envVars: Record<string, string> = {};

  if (config.database?.enabled) {
    envVars.DATABASE_URL = `postgresql://plattr:localdev@127.0.0.1:5432/plattr?search_path=${schemaName}`;
    envVars.POSTGREST_URL = 'http://127.0.0.1:3001';
  }

  if (config.storage?.enabled) {
    envVars.S3_ENDPOINT = 'http://127.0.0.1:9000';
    envVars.S3_ACCESS_KEY = 'minioadmin';
    envVars.S3_SECRET_KEY = 'minioadmin';
    envVars.S3_REGION = 'us-east-1';

    const buckets = config.storage.buckets || [];
    for (const bucket of buckets) {
      const envKey = `S3_BUCKET_${bucket.name.toUpperCase().replace(/-/g, '_')}`;
      envVars[envKey] = `${appName}-${bucket.name}`;
    }
  }

  if (config.auth?.enabled) {
    envVars.AUTH_ISSUER_URL = `http://127.0.0.1:8080/realms/${appName}`;
    envVars.AUTH_CLIENT_ID = `${appName}-app`;
  }

  // Apply local.env overrides
  if (config.local?.env) {
    for (const [key, value] of Object.entries(config.local.env)) {
      envVars[key] = value;
    }
  }

  return envVars;
}

/**
 * Start kubectl port-forward processes detached from the parent.
 * Returns the PIDs so they can be written to a file.
 */
function startPortForwards(config: AppConfig): number[] {
  const pids: number[] = [];

  const forward = (svc: string, ports: string) => {
    const proc = spawn('kubectl', ['port-forward', `svc/${svc}`, ports, '-n', NAMESPACE], {
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    if (proc.pid) pids.push(proc.pid);
  };

  // Always forward Postgres
  forward('plattr-pg', '5432:5432');

  if (config.database?.enabled) {
    forward('plattr-postgrest', '3001:3001');
  }

  if (config.storage?.enabled) {
    forward('plattr-minio', '9000:9000');
    forward('plattr-minio-console', '9001:9001');
  }

  if (config.auth?.enabled) {
    forward('plattr-keycloak', '8080:8080');
  }

  return pids;
}

/**
 * Print service URLs.
 */
function printServiceUrls(config: AppConfig): void {
  const schemaName = config.database?.schemaName || config.name.replace(/-/g, '_');

  console.log('\n  Service URLs:');
  console.log(`    PostgreSQL: postgresql://plattr:localdev@127.0.0.1:5432/plattr (schema: ${schemaName})`);

  if (config.database?.enabled) {
    console.log(`    PostgREST:  http://127.0.0.1:3001`);
  }
  if (config.storage?.enabled) {
    console.log(`    MinIO S3:   http://127.0.0.1:9000`);
    console.log(`    MinIO UI:   http://127.0.0.1:9001`);
  }
  if (config.auth?.enabled) {
    console.log(`    Keycloak:   http://127.0.0.1:8080`);
  }
}

export function devCommand(port?: number) {
  const config = loadConfig();
  const appPort = port || config.local?.port || 3000;
  const framework = config.framework || 'nextjs';
  const appName = config.name;
  const schemaName = config.database?.schemaName || appName.replace(/-/g, '_');
  const anonRole = `${appName.replace(/-/g, '_')}_anon`;

  // Ensure .plattr state directory exists
  getStateDir();

  console.log(`Starting local dev environment for "${appName}"...`);
  console.log(`Framework: ${framework}`);

  // 1. Ensure Kind cluster
  ensureCluster();

  // 2. Apply infrastructure manifests (only enabled services)
  console.log('\nApplying infrastructure manifests...');
  applyManifests(config);

  // 3. Wait for Postgres
  console.log('\nWaiting for infrastructure...');
  waitForDeployment('plattr-pg');

  // Wait for Postgres to actually accept connections
  console.log('  Waiting for Postgres to accept connections...');
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try {
      execSync(`kubectl exec deploy/plattr-pg -n ${NAMESPACE} -- pg_isready -U plattr`, { stdio: 'ignore' });
      ready = true;
      break;
    } catch {
      execSync('sleep 2');
    }
  }
  if (!ready) {
    throw new Error('Postgres failed to start after 30 seconds');
  }

  // Wait for other enabled services
  if (config.database?.enabled) {
    // Set up schema and role before PostgREST starts
    console.log('\n  Setting up database...');
    ensureSchema(schemaName);
    ensureAnonRole(appName, schemaName);

    // Patch PostgREST with app-specific config and wait
    patchPostgrest(schemaName, anonRole);
    waitForDeployment('plattr-postgrest');
  }

  if (config.storage?.enabled) {
    waitForDeployment('plattr-minio');

    // Create buckets
    const buckets = config.storage.buckets || [];
    if (buckets.length > 0) {
      console.log('\n  Creating storage buckets...');
      ensureBuckets(appName, buckets);
    }
  }

  if (config.auth?.enabled) {
    waitForDeployment('plattr-keycloak', 120);
  }

  console.log('\n[PLATTR] Infrastructure is ready.');

  // 4. Kill any leftover port-forwards from a previous run
  killAllPids(appName);

  // 5. Start detached port-forwards
  const pids = startPortForwards(config);

  // Write PIDs so "plattr infra stop" can clean them up
  appendPids(appName, pids);

  // Brief pause for port-forwards to bind
  execSync('sleep 1');

  // 6. Build env vars
  const envVars = buildEnvVars(config);

  // 7. Merge env vars into env file for easy sourcing
  mergeEnvFile(appName, envVars);

  // 8. Print service URLs
  printServiceUrls(config);

  // 9. Print export commands
  console.log('\n  Run these in your terminal:\n');
  for (const [key, value] of Object.entries(envVars)) {
    console.log(`    export ${key}="${value}"`);
  }

  console.log(`\n  Or source all at once: source .plattr/${appName}.env`);

  // 10. Print dev server hints
  console.log('\n  Then start your dev server:');
  console.log('    npx next dev        # Next.js');
  console.log('    bin/rails server    # Rails');

  console.log(`\n  Tip: Run plattr deploy local to test the production container in your local cluster.`);
  console.log('  Run plattr infra stop to stop port-forwards and save resources.\n');
}
