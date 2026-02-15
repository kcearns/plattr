import { loadConfig } from '../lib/config';
import { run, runQuiet } from '../lib/exec';

export function previewCommand(prNumber: number, port: number = 3100) {
  const config = loadConfig();
  console.log(`Starting local preview for PR #${prNumber} on port ${port}...\n`);
  run(`dagger call preview --source=. --pr-number=${prNumber} up --ports=${port}:${port}`);
}

export function previewListCommand() {
  try {
    const output = runQuiet('kubectl get previewenvironments -o json');
    const data = JSON.parse(output);
    const items = data.items || [];

    if (items.length === 0) {
      console.log('No active preview environments.');
      return;
    }

    console.log('Active preview environments:\n');
    console.log('  PR    App              Phase     URL                                          Expires');
    console.log('  ──    ───              ─────     ───                                          ───────');
    for (const item of items) {
      const pr = String(item.spec.pullRequest).padEnd(6);
      const app = (item.spec.applicationRef || '').padEnd(17);
      const phase = (item.status?.phase || 'Unknown').padEnd(10);
      const url = (item.status?.url || 'N/A').padEnd(45);
      const expires = item.status?.expiresAt ? new Date(item.status.expiresAt).toLocaleString() : 'N/A';
      console.log(`  ${pr}${app}${phase}${url}${expires}`);
    }
  } catch {
    console.error('Failed to list preview environments. Is your kubeconfig configured?');
    process.exit(1);
  }
}
