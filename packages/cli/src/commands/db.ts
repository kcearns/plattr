import { loadConfig } from '../lib/config';
import { run } from '../lib/exec';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

function checkPsql(): void {
  try {
    execSync('which psql', { stdio: 'pipe' });
  } catch {
    console.error('psql is required for db shell. Install it: sudo pacman -S postgresql');
    process.exit(1);
  }
}

function checkLocalDb(): void {
  try {
    execSync('ss -tln sport = :5432 | grep -q 5432', { stdio: 'pipe', shell: '/bin/bash' });
  } catch {
    console.error('No database running. Start your environment first with: plattr dev');
    process.exit(1);
  }
}

function getLocalDbUrl(): { appName: string; schemaName: string; url: string } {
  const config = loadConfig();
  const appName = config.name;
  const schemaName = appName.replace(/-/g, '_');
  const url = `postgresql://postgres:devpass@localhost:5432/platform?options=--search_path%3D${schemaName}`;
  return { appName, schemaName, url };
}

export function dbShellCommand() {
  checkPsql();
  checkLocalDb();

  const { url } = getLocalDbUrl();
  console.log('Opening database shell...\n');
  run(`psql "${url}"`, { stdio: 'inherit' });
}

export function dbMigrateCommand(engine?: string) {
  checkLocalDb();

  const { appName, schemaName, url } = getLocalDbUrl();
  console.log('Running database migrations...\n');

  if (engine === 'prisma' || (!engine && existsSync('prisma/schema.prisma'))) {
    run(`npx prisma migrate deploy`, {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    });
  } else if (engine === 'knex' || (!engine && existsSync('knexfile.js')) || (!engine && existsSync('knexfile.ts'))) {
    run(`npx knex migrate:latest`, {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    });
  } else if (existsSync('db/migrations')) {
    // Raw SQL migrations — run .sql files in order
    const { readdirSync } = require('fs');
    const files = readdirSync('db/migrations')
      .filter((f: string) => f.endsWith('.sql'))
      .sort();
    checkPsql();
    for (const file of files) {
      console.log(`  Applying ${file}...`);
      run(`psql "${url}" -f db/migrations/${file}`, { stdio: 'inherit' });
    }
  } else {
    console.error('No migration engine detected. Use --engine=prisma|knex or place SQL files in db/migrations/');
    process.exit(1);
  }
}

export function dbSeedCommand(seedFile?: string) {
  checkPsql();
  checkLocalDb();

  const { url } = getLocalDbUrl();
  const file = seedFile || 'db/seeds.sql';

  if (!existsSync(file)) {
    console.error(`Seed file not found: ${file}`);
    process.exit(1);
  }

  console.log(`Seeding database from ${file}...\n`);
  run(`psql "${url}" -f ${file}`, { stdio: 'inherit' });
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
