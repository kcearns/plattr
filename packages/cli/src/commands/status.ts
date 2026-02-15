import { loadConfig } from '../lib/config';
import { runQuiet } from '../lib/exec';
import { resolveEnv } from '../lib/kube';

export function statusCommand(env: string = 'production', prNumber?: number) {
  const config = loadConfig();
  const { namespace, resourceName } = resolveEnv(config.name, env, prNumber);

  try {
    const output = runQuiet(
      `kubectl get application ${resourceName} -n ${namespace} -o json`,
    );
    const app = JSON.parse(output);
    const phase = app.status?.phase || 'Unknown';
    const url = app.status?.url || 'N/A';
    const conditions = app.status?.conditions || [];

    console.log(`Application: ${config.name}`);
    console.log(`Environment: ${env}`);
    console.log(`Phase: ${phase}`);
    console.log(`URL: ${url}`);

    if (conditions.length > 0) {
      console.log(`\nConditions:`);
      for (const c of conditions) {
        const icon = c.status === 'True' ? '✅' : c.status === 'False' ? '❌' : '⏳';
        const detail = c.message ? ` — ${c.message}` : '';
        console.log(`  ${icon} ${c.type}${detail}`);
      }
    }
  } catch {
    console.error(`Application "${config.name}" not found in ${env} environment.`);
    console.error('Make sure your kubeconfig is configured and the app has been deployed.');
    process.exit(1);
  }
}
