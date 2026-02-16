import { getDaggerModule } from '../lib/config';
import { run } from '../lib/exec';

export function buildCommand() {
  console.log('Building production image...\n');
  run(`dagger call --mod=${getDaggerModule()} build --source=.`);
}
