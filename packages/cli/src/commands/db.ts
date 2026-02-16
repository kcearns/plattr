import { loadConfig, getDaggerModule } from '../lib/config';
import { run } from '../lib/exec';

export function dbMigrateCommand(engine?: string) {
  console.log('Running database migrations...\n');
  const engineArg = engine ? ` --engine=${engine}` : '';
  run(`dagger call --mod=${getDaggerModule()} migrate --source=.${engineArg}`);
}

export function dbShellCommand() {
  console.log('Opening database shell...\n');
  run(`dagger call --mod=${getDaggerModule()} db-shell --source=. terminal`);
}

export function dbSeedCommand(seedFile?: string) {
  const fileArg = seedFile ? ` --seed-file=${seedFile}` : '';
  console.log('Seeding database...\n');
  run(`dagger call --mod=${getDaggerModule()} seed --source=.${fileArg}`);
}

export function dbConnectCommand(env: string, appName: string) {
  // Remote DB connection via kubectl — read DATABASE_URL from the Secret
  const namespace = env === 'production' ? 'production' : env;
  console.log(`Connecting to ${env} database for "${appName}"...\n`);

  try {
    const secretJson = run(
      `kubectl get secret ${appName}-db -n ${namespace} -o json`,
      { stdio: 'pipe' },
    ) as unknown as string;
    const secret = JSON.parse(secretJson);
    const dbUrl = Buffer.from(secret.data.DATABASE_URL, 'base64').toString();

    console.log(`Connecting to: ${dbUrl.replace(/:([^:@]+)@/, ':****@')}`);
    console.log('Use \\q to exit.\n');

    run(`psql "${dbUrl}"`, { stdio: 'inherit' });
  } catch (err: any) {
    console.error(`Failed to connect to ${env} database: ${err.message}`);
    console.error('Make sure you have access to the cluster and the app exists in this environment.');
    process.exit(1);
  }
}
