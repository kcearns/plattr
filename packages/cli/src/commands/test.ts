import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { loadConfig, getDaggerModule } from '../lib/config';
import { run } from '../lib/exec';
import { readEnvFile } from '../lib/state';

/**
 * Check if the plattr-pg deployment has a ready replica in the Kind cluster.
 */
export function infraRunning(): boolean {
  try {
    const replicas = execSync(
      'kubectl get deploy plattr-pg -n plattr-local -o jsonpath="{.status.readyReplicas}"',
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim().replace(/"/g, '');
    return replicas === '1';
  } catch {
    return false;
  }
}

/**
 * Check if any files matching a glob pattern exist (shallow check).
 */
function hasFiles(dir: string, ext: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const result = execSync(`find ${dir} -name "*.${ext}" -maxdepth 3 -print -quit`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect the test runner for a Node.js / Next.js project.
 * Returns the command to run, or null if nothing found.
 */
function detectNodeTestRunner(): { cmd: string; args: string[] } | null {
  // Vitest
  if (existsSync('vitest.config.ts') || existsSync('vitest.config.js') || existsSync('vitest.config.mts')) {
    return { cmd: 'npx', args: ['vitest', 'run'] };
  }

  // Jest
  if (existsSync('jest.config.ts') || existsSync('jest.config.js') || existsSync('jest.config.mjs')) {
    return { cmd: 'npx', args: ['jest'] };
  }

  // package.json test script
  if (existsSync('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
      const testScript = pkg.scripts?.test;
      if (testScript && !testScript.includes('echo') && !testScript.includes('no test specified')) {
        return { cmd: 'npm', args: ['test'] };
      }
    } catch {}
  }

  // Test files exist but no runner configured
  if (existsSync('__tests__') || hasFiles('.', 'test.ts') || hasFiles('.', 'test.tsx') || hasFiles('.', 'test.js')) {
    console.log('Found test files but no test runner configured. Install one with:\n');
    console.log('  npm install -D vitest\n');
    return null;
  }

  // Nothing found
  return null;
}

/**
 * Detect the test runner for a Rails project.
 */
function detectRailsTestRunner(): { cmd: string; args: string[] } | null {
  if (hasFiles('spec', 'rb')) {
    return { cmd: 'bundle', args: ['exec', 'rspec'] };
  }
  if (hasFiles('test', 'rb')) {
    return { cmd: 'bundle', args: ['exec', 'rails', 'test'] };
  }
  return null;
}

/**
 * Detect the test runner for the given framework.
 */
export function detectTestRunner(framework: string): { cmd: string; args: string[] } | null {
  switch (framework) {
    case 'rails':
      return detectRailsTestRunner();
    case 'nextjs':
    case 'docker':
    case 'static':
    default:
      return detectNodeTestRunner();
  }
}

/**
 * Run detected tests with the given env vars.
 * Returns the exit code, or null if no tests were found.
 */
export function runTests(
  runner: { cmd: string; args: string[] },
  envVars: Record<string, string>,
): number {
  console.log(`Running: ${runner.cmd} ${runner.args.join(' ')}\n`);

  const result = spawnSync(runner.cmd, runner.args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, ...envVars },
  });

  return result.status ?? 1;
}

/**
 * Run local tests against running Kind infrastructure.
 */
export function testCommand() {
  const config = loadConfig();
  const appName = config.name;
  const framework = config.framework || 'nextjs';

  // Load env vars from state file
  const envVars = readEnvFile(appName);
  if (!envVars) {
    console.error('No environment configured. Run plattr dev first.');
    process.exit(1);
  }

  // Check infrastructure is running if database is enabled
  if (config.database?.enabled) {
    if (!infraRunning()) {
      console.error('Infrastructure not running. Run plattr dev first, then run plattr test in another terminal.');
      process.exit(1);
    }
  }

  const runner = detectTestRunner(framework);

  if (!runner) {
    // Print setup instructions based on framework
    if (framework === 'rails') {
      console.log('No tests found. To get started:\n');
      console.log("  Add gem 'rspec-rails' to your Gemfile");
      console.log('  Run: bundle exec rails generate rspec:install\n');
    } else {
      console.log('No tests found. To get started:\n');
      console.log('  npm install -D vitest');
      console.log('  mkdir __tests__');
      console.log('  Create your first test in __tests__/example.test.ts\n');
    }
    process.exit(0);
  }

  const exitCode = runTests(runner, envVars);
  console.log(`\nTests completed (exit code: ${exitCode})`);
  process.exit(exitCode);
}

/**
 * Run Dagger-based ephemeral tests (clean database, clean state every run).
 */
export function testCiCommand() {
  console.log('Running tests with full ephemeral infrastructure...\n');
  run(`dagger call --mod=${getDaggerModule()} test --source=.`);
}
