#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { devCommand } from './commands/dev';
import { testCommand, testCiCommand } from './commands/test';
import { buildCommand } from './commands/build';
import { previewCommand, previewListCommand } from './commands/preview';
import { dbMigrateCommand, dbShellCommand, dbSeedCommand, dbConnectCommand } from './commands/db';
import { infraStatusCommand, infraStopCommand, infraStartCommand, infraDestroyCommand, infraInitCommand, dbResetCommand, redisResetCommand, searchResetCommand } from './commands/infra';
import { deployLocalCommand, undeployLocalCommand } from './commands/deploy-local';
import { statusCommand } from './commands/status';
import { logsCommand } from './commands/logs';
import { envSetCommand, envListCommand, envUnsetCommand } from './commands/env';

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
  .command('test')
  .description('Run tests against local infrastructure')
  .option('--ci', 'Run Dagger-based ephemeral tests (clean state)')
  .action((options) => options.ci ? testCiCommand() : testCommand());

program
  .command('build')
  .description('Build production container image')
  .action(() => buildCommand());

// --- Deploy local ---
const deploy = program.command('deploy').description('Deployment commands');

deploy
  .command('local')
  .description('Build production image and deploy to local Kind cluster')
  .option('-p, --port <port>', 'Port for the app', parseInt)
  .option('--skip-tests', 'Skip the test step')
  .option('--skip-scan', 'Skip the Trivy security scan')
  .option('--fail-on-scan', 'Exit with error if vulnerabilities found (no prompt)')
  .action((options) => deployLocalCommand({
    port: options.port,
    skipTests: options.skipTests,
    skipScan: options.skipScan,
    failOnScan: options.failOnScan,
  }));

const undeploy = program.command('undeploy').description('Remove deployments');

undeploy
  .command('local')
  .description('Remove app deployment from local Kind cluster')
  .action(() => undeployLocalCommand());

// --- Infrastructure ---
const infra = program.command('infra').description('Local infrastructure management');

infra
  .command('init')
  .description('Initialize AWS infrastructure configuration (generates cdk.json)')
  .action(() => infraInitCommand());

infra
  .command('status')
  .description('Show local infrastructure status')
  .action(() => infraStatusCommand());

infra
  .command('stop')
  .description('Stop local infrastructure (data preserved)')
  .action(() => infraStopCommand());

infra
  .command('start')
  .description('Start local infrastructure')
  .action(() => infraStartCommand());

infra
  .command('destroy')
  .description('Delete local cluster and all data')
  .action(() => infraDestroyCommand());

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

db.command('reset')
  .description('Reset local database (deletes all data)')
  .action(() => dbResetCommand());

// --- Redis ---
const redis = program.command('redis').description('Redis operations');

redis.command('reset')
  .description('Reset local Redis (deletes all data)')
  .action(() => redisResetCommand());

// --- Search ---
const search = program.command('search').description('OpenSearch operations');

search.command('reset')
  .description('Reset local OpenSearch (deletes all data)')
  .action(() => searchResetCommand());

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
