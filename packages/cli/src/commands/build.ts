import { run } from '../lib/exec';

export function buildCommand() {
  console.log('Building production image...\n');
  run('dagger call build --source=.');
}
