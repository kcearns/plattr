import { loadConfig, getDaggerModule } from '../lib/config';
import { run } from '../lib/exec';

export function devCommand(port?: number) {
  const config = loadConfig();
  const p = port || config.local?.port || 3000;

  console.log(`Starting local dev environment for "${config.name}" on port ${p}...`);
  console.log('Services: App (hot reload) + PostgreSQL + MinIO + PostgREST\n');

  const ports = `${p}:${p},5432:5432,9000:9000,9001:9001,3001:3001,8080:8080`;
  run(`dagger call --mod=${getDaggerModule()} dev --source=. up --ports=${ports}`);
}
