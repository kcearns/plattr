import { spawn, execSync, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { loadConfig, getDaggerModule, type AppConfig } from '../lib/config';
import { run } from '../lib/exec';
import { appendPids, killAllPids, readEnvFile } from '../lib/state';
import { detectTestRunner, runTests } from './test';

const NAMESPACE = 'plattr-local';
const REGISTRY = 'localhost:5050';

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
 * Check if a Kubernetes resource exists.
 */
function resourceExists(kind: string, name: string): boolean {
  try {
    execSync(`kubectl get ${kind} ${name} -n ${NAMESPACE}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt the user with a yes/no question. Returns true for yes.
 */
function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Build environment variables for in-cluster deployment.
 */
function buildClusterEnvVars(config: AppConfig): Record<string, string> {
  const appName = config.name;
  const schemaName = config.database?.schemaName || appName.replace(/-/g, '_');
  const envVars: Record<string, string> = {};

  if (config.database?.enabled) {
    envVars.DATABASE_URL = `postgresql://plattr:localdev@plattr-pg:5432/plattr?search_path=${schemaName}`;
    envVars.POSTGREST_URL = 'http://plattr-postgrest:3001';
  }

  if (config.storage?.enabled) {
    envVars.S3_ENDPOINT = 'http://plattr-minio:9000';
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
    envVars.AUTH_ISSUER_URL = `http://plattr-keycloak:8080/realms/${appName}`;
    envVars.AUTH_CLIENT_ID = `${appName}-app`;
  }

  return envVars;
}

/**
 * Generate the Kubernetes manifests for the app deployment.
 */
function generateManifests(config: AppConfig, port: number): string {
  const appName = config.name;
  const envVars = buildClusterEnvVars(config);

  const configMapData = Object.entries(envVars)
    .map(([key, value]) => `    ${key}: "${value}"`)
    .join('\n');

  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${appName}-env
  namespace: ${NAMESPACE}
data:
${configMapData}`;

  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${appName}
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${appName}
  template:
    metadata:
      labels:
        app: ${appName}
    spec:
      containers:
        - name: ${appName}
          image: ${REGISTRY}/${appName}:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: ${appName}-env
          readinessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5`;

  const service = `apiVersion: v1
kind: Service
metadata:
  name: ${appName}
  namespace: ${NAMESPACE}
spec:
  selector:
    app: ${appName}
  ports:
    - port: ${port}
      targetPort: 3000`;

  return [configMap, deployment, service].join('\n---\n');
}

/**
 * Run a Trivy security scan against an image.
 * Returns the exit code (0 = clean, 1 = vulnerabilities found).
 */
function runTrivyScan(imageTag: string): number {
  const args = ['image', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', imageTag];

  if (commandExists('trivy')) {
    const result = spawnSync('trivy', args, { stdio: 'inherit' });
    return result.status ?? 1;
  }

  // Fall back to running Trivy via Docker
  const result = spawnSync('docker', [
    'run', '--rm',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    'aquasec/trivy:latest',
    ...args,
  ], { stdio: 'inherit' });
  return result.status ?? 1;
}

export interface DeployLocalOptions {
  port?: number;
  skipTests?: boolean;
  skipScan?: boolean;
  failOnScan?: boolean;
}

export async function deployLocalCommand(options: DeployLocalOptions = {}) {
  const config = loadConfig();
  const appName = config.name;
  const appPort = options.port || config.local?.port || 3000;
  const framework = config.framework || 'nextjs';
  const isRedeployment = resourceExists('deployment', appName);
  const imageTag = `${REGISTRY}/${appName}:latest`;
  const imageTar = `/tmp/plattr-${appName}.tar`;

  let testResult = 'skipped';
  let scanResult = 'skipped';

  console.log(`${isRedeployment ? 'Redeploying' : 'Deploying'} "${appName}" to local cluster...\n`);

  // --- Step 1: Tests ---
  if (!options.skipTests) {
    console.log('--- Tests ---\n');
    const runner = detectTestRunner(framework);
    if (runner) {
      const envVars = readEnvFile(appName);
      if (!envVars) {
        console.error('No environment configured. Run plattr dev first.');
        process.exit(1);
      }
      const exitCode = runTests(runner, envVars);
      if (exitCode !== 0) {
        console.error('\nTests failed. Fix the failures and try again.');
        process.exit(1);
      }
      testResult = 'passed';
    } else {
      console.log('No tests found, skipping.\n');
    }
  }

  // --- Step 2: Build ---
  console.log('--- Build ---\n');
  console.log('Building production image...');
  run(`dagger call --mod=${getDaggerModule()} build --source=. export --path=${imageTar}`);

  // --- Step 3: Push to registry ---
  console.log('\n--- Push ---\n');
  console.log('Pushing image to local registry...');
  const loadOutput = execSync(`docker load -i ${imageTar}`, { encoding: 'utf-8', stdio: 'pipe' });
  const loadedMatch = loadOutput.match(/Loaded image(?: ID)?: (.+)/);
  const loadedRef = loadedMatch ? loadedMatch[1].trim() : '';
  if (!loadedRef) {
    console.error('Failed to determine loaded image reference from docker load output.');
    process.exit(1);
  }
  execSync(`docker tag ${loadedRef} ${imageTag}`, { stdio: 'pipe' });
  run(`docker push ${imageTag}`);

  // --- Step 4: Security scan ---
  if (!options.skipScan) {
    console.log('\n--- Security Scan ---\n');
    const scanExitCode = runTrivyScan(imageTag);
    if (scanExitCode === 0) {
      console.log('\nSecurity scan passed.');
      scanResult = 'passed';
    } else {
      scanResult = 'vulnerabilities found';
      if (options.failOnScan) {
        console.error('\nHIGH/CRITICAL vulnerabilities found. Aborting (--fail-on-scan).');
        process.exit(1);
      }
      const proceed = await confirm('\nHIGH/CRITICAL vulnerabilities found. Deploy anyway? (y/N) ');
      if (!proceed) {
        console.log('Deploy aborted.');
        process.exit(1);
      }
    }
  }

  // --- Step 5: Deploy ---
  console.log('\n--- Deploy ---\n');

  // Ensure namespace exists
  execSync(
    `kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`,
    { stdio: 'inherit' },
  );

  const manifests = generateManifests(config, appPort);
  if (isRedeployment) {
    execSync(`echo '${manifests.replace(/'/g, "'\\''")}' | kubectl apply -f -`, {
      stdio: 'inherit',
    });
    console.log('\nRestarting deployment...');
    run(`kubectl rollout restart deployment/${appName} -n ${NAMESPACE}`);
  } else {
    console.log('Applying Kubernetes manifests...');
    execSync(`echo '${manifests.replace(/'/g, "'\\''")}' | kubectl apply -f -`, {
      stdio: 'inherit',
    });
  }

  console.log('\nWaiting for deployment to be ready...');
  run(`kubectl rollout status deployment/${appName} -n ${NAMESPACE} --timeout=120s`);

  // --- Step 6: Port-forward ---
  const portForward = spawn(
    'kubectl',
    ['port-forward', `svc/${appName}`, `${appPort}:${appPort}`, '-n', NAMESPACE],
    { stdio: 'ignore', detached: true },
  );
  portForward.unref();

  if (portForward.pid) {
    appendPids(appName, [portForward.pid]);
  }

  // --- Summary ---
  console.log('\nPipeline complete:');
  console.log(`  Tests:     ${testResult}`);
  console.log(`  Scan:      ${scanResult}`);
  console.log(`  Image:     ${imageTag}`);
  console.log(`  Deployed:  http://localhost:${appPort}`);
  console.log('\n  Run plattr undeploy local to remove.\n');
}

export function undeployLocalCommand() {
  const config = loadConfig();
  const appName = config.name;

  console.log(`Removing "${appName}" from local cluster...\n`);

  // Kill all tracked PIDs (port-forwards from both dev and deploy)
  killAllPids(appName);

  const resources = [
    `deployment/${appName}`,
    `svc/${appName}`,
    `configmap/${appName}-env`,
  ];

  for (const resource of resources) {
    try {
      execSync(`kubectl delete ${resource} -n ${NAMESPACE}`, { stdio: 'inherit' });
    } catch {
      // Resource may not exist — that's fine
    }
  }

  console.log(`\nRemoved ${appName} from local cluster.`);
}
