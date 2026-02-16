#!/usr/bin/env node

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { initCommand } from './commands/init';
import { devCommand } from './commands/dev';
import { testCommand } from './commands/test';
import { buildCommand } from './commands/build';
import { previewCommand, previewListCommand } from './commands/preview';
import { dbMigrateCommand, dbShellCommand, dbSeedCommand, dbConnectCommand } from './commands/db';
import { statusCommand } from './commands/status';
import { logsCommand } from './commands/logs';
import { envSetCommand, envListCommand, envUnsetCommand } from './commands/env';

const PID_DIR = join(homedir(), '.plattr');
const PID_FILE = join(PID_DIR, 'dev.pid');

const program = new Command();

program
  .name('plattr')
  .description('Internal Developer Platform CLI')
  .version('0.1.0');

// --- Init ---
program
  .command('init')
  .description('Initialize a new app for the platform')
  .action(() => initCommand());

// --- Local development ---
program
  .command('dev')
  .description('Start local dev environment')
  .option('-p, --port <port>', 'Port for the app', parseInt)
  .action((options) => devCommand(options.port));

program
  .command('down')
  .description('Stop the local development environment')
  .action(() => {
    let killed = false;

    // 1. Try PID file first
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // check alive
          console.log(`[PLATTR] Stopping dev environment (PID ${pid})...`);
          process.kill(pid, 'SIGTERM');
          killed = true;
        } catch {
          console.log(`[PLATTR] Stale PID file (process ${pid} not running).`);
        }
      }
      unlinkSync(PID_FILE);
    }

    // 2. Find any orphaned "dagger call dev" processes
    try {
      const pids = execSync('pgrep -f "dagger call.*(dev|services)"', { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .map((p) => parseInt(p, 10))
        .filter((p) => !isNaN(p) && p !== process.pid);

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`[PLATTR] Stopped orphaned dagger process (PID ${pid}).`);
          killed = true;
        } catch {
          // already dead, ignore
        }
      }
    } catch {
      // pgrep returns non-zero when no matches — that's fine
    }

    if (killed) {
      console.log('[PLATTR] Dev environment stopped. Dagger will clean up all containers.');
    } else {
      console.log('[PLATTR] No running dev environment found.');
    }
  });

program
  .command('test')
  .description('Run tests with full infrastructure')
  .action(() => testCommand());

program
  .command('build')
  .description('Build production container image')
  .action(() => buildCommand());

// --- Preview ---
const preview = program.command('preview').description('Preview environments');

preview
  .command('start')
  .description('Start a local preview environment')
  .requiredOption('--pr <number>', 'Pull request number', parseInt)
  .option('-p, --port <port>', 'Port', parseInt, 3100)
  .action((options) => previewCommand(options.pr, options.port));

preview
  .command('list')
  .description('List active remote preview environments')
  .action(() => previewListCommand());

// --- Database ---
const db = program.command('db').description('Database operations');

db.command('migrate')
  .description('Run database migrations')
  .option('--engine <engine>', 'Migration engine (prisma, knex, raw)')
  .action((options) => dbMigrateCommand(options.engine));

db.command('shell')
  .description('Open interactive psql shell (local)')
  .action(() => dbShellCommand());

db.command('seed')
  .description('Seed database with test data')
  .option('--file <path>', 'Seed file path')
  .action((options) => dbSeedCommand(options.file));

db.command('connect')
  .description('Connect to remote database')
  .option('--env <environment>', 'Target environment', 'production')
  .action((options) => {
    const { loadConfig } = require('./lib/config');
    const config = loadConfig();
    dbConnectCommand(options.env, config.name);
  });

// --- Status ---
program
  .command('status')
  .description('Show application status')
  .option('--env <environment>', 'Target environment', 'production')
  .option('--pr <number>', 'PR number (for preview)', parseInt)
  .action((options) => statusCommand(options.env, options.pr));

// --- Logs ---
program
  .command('logs')
  .description('Stream application logs')
  .option('--env <environment>', 'Target environment', 'production')
  .option('-f, --follow', 'Stream logs continuously')
  .option('--tail <lines>', 'Number of lines', parseInt)
  .option('--pr <number>', 'PR number (for preview)', parseInt)
  .action((options) => logsCommand(options));

// --- Env vars ---
const envCmd = program.command('env').description('Environment variable management');

envCmd
  .command('set <keyvalues...>')
  .description('Set environment variables (KEY=VALUE)')
  .option('--env <environment>', 'Target environment', 'production')
  .action((keyvalues, options) => envSetCommand(keyvalues, options.env));

envCmd
  .command('list')
  .description('List environment variables')
  .option('--env <environment>', 'Target environment', 'production')
  .action((options) => envListCommand(options.env));

envCmd
  .command('unset <key>')
  .description('Remove an environment variable')
  .option('--env <environment>', 'Target environment', 'production')
  .action((key, options) => envUnsetCommand(key, options.env));

program.parse();
