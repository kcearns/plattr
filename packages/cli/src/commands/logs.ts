import { loadConfig } from '../lib/config';
import { run } from '../lib/exec';
import { resolveEnv } from '../lib/kube';

export function logsCommand(options: {
  env?: string;
  follow?: boolean;
  tail?: number;
  pr?: number;
}) {
  const config = loadConfig();
  const env = options.env || 'production';
  const { namespace, resourceName } = resolveEnv(config.name, env, options.pr);

  const flags: string[] = [];
  if (options.follow) flags.push('-f');
  if (options.tail) flags.push(`--tail=${options.tail}`);

  // Use label selector to get all pods for this app
  const selector = `app.kubernetes.io/name=${resourceName}`;
  console.log(`Streaming logs for "${config.name}" in ${env}...\n`);

  run(`kubectl logs -n ${namespace} -l ${selector} ${flags.join(' ')} --all-containers`);
}
