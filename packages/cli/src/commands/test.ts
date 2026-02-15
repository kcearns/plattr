import { run } from '../lib/exec';

export function testCommand() {
  console.log('Running tests with full infrastructure...\n');
  run('dagger call test --source=.');
}
