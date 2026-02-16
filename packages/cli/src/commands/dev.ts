import { spawn, ChildProcess } from 'child_process';
import { loadConfig, getDaggerModule, AppConfig } from '../lib/config';

/**
 * Build the environment variables map for the native dev server
 * based on which features are enabled in plattr.yaml.
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
 * Detect the framework dev command from plattr.yaml config.
 */
function getDevCommand(config: AppConfig, port: number): { cmd: string; args: string[] } {
  const framework = config.framework || 'nextjs';

  switch (framework) {
    case 'nextjs':
      return { cmd: 'npx', args: ['next', 'dev', '--port', String(port)] };
    case 'rails':
      return { cmd: 'bin/rails', args: ['server', '-p', String(port)] };
    default:
      return { cmd: 'npx', args: ['next', 'dev', '--port', String(port)] };
  }
}

/**
 * Compute the port list for `dagger ... up --ports=...` based on enabled features.
 */
function getServicePorts(config: AppConfig): string {
  const ports: string[] = [];

  if (config.database?.enabled) {
    ports.push('5432:5432'); // Postgres
    ports.push('3001:3001'); // PostgREST
  }
  if (config.storage?.enabled) {
    ports.push('9000:9000'); // MinIO S3
    ports.push('9001:9001'); // MinIO Console
  }
  if (config.auth?.enabled) {
    ports.push('8080:8080'); // Keycloak
  }

  return ports.join(',');
}

export function devCommand(port?: number) {
  const config = loadConfig();
  const appPort = port || config.local?.port || 3000;
  const framework = config.framework || 'nextjs';

  console.log(`Starting local dev environment for "${config.name}"...`);
  console.log(`Framework: ${framework} | App port: ${appPort}`);

  const servicePorts = getServicePorts(config);
  if (!servicePorts) {
    console.log('No infrastructure services enabled — starting app only.\n');
    startApp(config, appPort, {});
    return;
  }

  console.log(`Infrastructure services starting in background...\n`);

  // Start Dagger services in the background
  const daggerArgs = [
    'call',
    `--mod=${getDaggerModule()}`,
    'dev',
    '--source=.',
    '--infra-only',
    'up',
    `--ports=${servicePorts}`,
  ];

  const daggerProc = spawn('dagger', daggerArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  let daggerReady = false;
  let appProc: ChildProcess | null = null;

  // Cleanup function
  const cleanup = () => {
    console.log('\n[PLATTR] Shutting down...');
    if (appProc && !appProc.killed) {
      appProc.kill('SIGTERM');
    }
    if (daggerProc && !daggerProc.killed) {
      daggerProc.kill('SIGTERM');
    }
    // Give processes a moment to exit, then force kill
    setTimeout(() => {
      if (appProc && !appProc.killed) appProc.kill('SIGKILL');
      if (daggerProc && !daggerProc.killed) daggerProc.kill('SIGKILL');
      process.exit(0);
    }, 3000);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Watch Dagger stdout/stderr for readiness
  let daggerOutput = '';

  const checkReady = (data: Buffer) => {
    const text = data.toString();
    daggerOutput += text;

    // Dagger `up` prints port mappings when services are ready
    if (!daggerReady && daggerOutput.includes('Infrastructure services ready')) {
      daggerReady = true;
      console.log('[PLATTR] Infrastructure services are ready.');
      // Give a brief moment for port forwarding to stabilize
      setTimeout(() => {
        const envVars = buildEnvVars(config);
        startApp(config, appPort, envVars);
      }, 1000);
    }
  };

  if (daggerProc.stdout) daggerProc.stdout.on('data', checkReady);
  if (daggerProc.stderr) {
    daggerProc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      // Pass through Dagger progress to stderr
      process.stderr.write(text);
      // Also check stderr for readiness signals
      checkReady(data);
    });
  }

  daggerProc.on('exit', (code) => {
    if (!daggerReady) {
      console.error(`[PLATTR] Dagger services failed to start (exit code ${code}).`);
      process.exit(1);
    }
  });

  function startApp(cfg: AppConfig, appPort: number, envVars: Record<string, string>) {
    const { cmd, args } = getDevCommand(cfg, appPort);
    const env = { ...process.env, ...envVars };

    console.log(`[PLATTR] Starting ${framework} dev server on port ${appPort}...`);

    // Print env vars being injected
    const envKeys = Object.keys(envVars);
    if (envKeys.length > 0) {
      console.log(`[PLATTR] Environment: ${envKeys.join(', ')}\n`);
    }

    appProc = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env,
    });

    appProc.on('exit', (code) => {
      console.log(`[PLATTR] Dev server exited (code ${code}).`);
      if (daggerProc && !daggerProc.killed) {
        daggerProc.kill('SIGTERM');
      }
      process.exit(code || 0);
    });
  }
}
