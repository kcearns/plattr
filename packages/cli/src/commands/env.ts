import { loadConfig } from '../lib/config';
import { run, runQuiet } from '../lib/exec';
import { resolveEnv } from '../lib/kube';

export function envSetCommand(keyValues: string[], env: string = 'production') {
  const config = loadConfig();
  const { namespace, resourceName } = resolveEnv(config.name, env);

  // Parse KEY=VALUE pairs
  const pairs: Record<string, string> = {};
  for (const kv of keyValues) {
    const eqIdx = kv.indexOf('=');
    if (eqIdx === -1) {
      console.error(`Invalid format: "${kv}". Use KEY=VALUE.`);
      process.exit(1);
    }
    pairs[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
  }

  // Create or update a ConfigMap for user-defined env vars
  const configMapName = `${resourceName}-env`;

  try {
    // Try to get existing
    const existing = runQuiet(
      `kubectl get configmap ${configMapName} -n ${namespace} -o json`,
    );
    const cm = JSON.parse(existing);
    if (!cm.data) cm.data = {};
    Object.assign(cm.data, pairs);
    // Use a temp file approach to avoid shell escaping issues
    const tmpFile = `/tmp/plattr-cm-${Date.now()}.json`;
    require('fs').writeFileSync(tmpFile, JSON.stringify(cm));
    run(`kubectl replace -f ${tmpFile}`, { stdio: 'pipe' });
    require('fs').unlinkSync(tmpFile);
  } catch {
    // Create new
    const literals = Object.entries(pairs).map(([k, v]) => `--from-literal=${k}=${v}`).join(' ');
    run(
      `kubectl create configmap ${configMapName} -n ${namespace} ${literals}`,
      { stdio: 'pipe' },
    );
  }

  for (const [k] of Object.entries(pairs)) {
    console.log(`Set ${k} in ${env}`);
  }

  // Restart the deployment to pick up new env vars
  console.log(`Restarting ${resourceName} to apply changes...`);
  run(`kubectl rollout restart deployment/${resourceName} -n ${namespace}`, { stdio: 'pipe' });
}

export function envListCommand(env: string = 'production') {
  const config = loadConfig();
  const { namespace, resourceName } = resolveEnv(config.name, env);

  console.log(`Environment variables for "${config.name}" in ${env}:\n`);

  // Platform-managed vars (from DB secret and storage ConfigMap)
  console.log('Plattr-managed:');
  try {
    const secret = runQuiet(`kubectl get secret ${resourceName}-db -n ${namespace} -o jsonpath='{.data}'`);
    const data = JSON.parse(secret);
    for (const key of Object.keys(data)) {
      console.log(`  ${key}=****`);
    }
  } catch { /* no DB secret */ }

  try {
    const cm = runQuiet(`kubectl get configmap ${resourceName}-storage -n ${namespace} -o jsonpath='{.data}'`);
    const data = JSON.parse(cm);
    for (const [key, value] of Object.entries(data)) {
      console.log(`  ${key}=${value}`);
    }
  } catch { /* no storage CM */ }

  // User-defined vars
  console.log('\nUser-defined:');
  try {
    const cm = runQuiet(`kubectl get configmap ${resourceName}-env -n ${namespace} -o jsonpath='{.data}'`);
    const data = JSON.parse(cm);
    for (const [key, value] of Object.entries(data)) {
      console.log(`  ${key}=${value}`);
    }
  } catch {
    console.log('  (none)');
  }
}

export function envUnsetCommand(key: string, env: string = 'production') {
  const config = loadConfig();
  const { namespace, resourceName } = resolveEnv(config.name, env);
  const configMapName = `${resourceName}-env`;

  try {
    const existing = runQuiet(`kubectl get configmap ${configMapName} -n ${namespace} -o json`);
    const cm = JSON.parse(existing);
    if (!cm.data || !(key in cm.data)) {
      console.error(`Variable "${key}" not found in ${env}.`);
      process.exit(1);
    }
    delete cm.data[key];
    const tmpFile = `/tmp/plattr-cm-${Date.now()}.json`;
    require('fs').writeFileSync(tmpFile, JSON.stringify(cm));
    run(`kubectl replace -f ${tmpFile}`, { stdio: 'pipe' });
    require('fs').unlinkSync(tmpFile);
    console.log(`Unset ${key} in ${env}`);
    run(`kubectl rollout restart deployment/${resourceName} -n ${namespace}`, { stdio: 'pipe' });
  } catch {
    console.error(`Variable "${key}" not found in ${env}.`);
    process.exit(1);
  }
}
