import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';

const DAGGER_MODULE = process.env.PLATTR_DAGGER_MODULE || 'github.com/kcearns/plattr/packages/dagger@main';

export function getDaggerModule(): string {
  return DAGGER_MODULE;
}

export interface AppConfig {
  name: string;
  framework?: string;
  database?: { enabled: boolean; schemaName?: string };
  storage?: { enabled: boolean; buckets?: Array<{ name: string; public: boolean }> };
  auth?: { enabled: boolean };
  redis?: { enabled: boolean };
  search?: { enabled: boolean };
  local?: { port?: number; env?: Record<string, string> };
}

export function loadConfig(): AppConfig {
  const configPath = 'plattr.yaml';
  if (!existsSync(configPath)) {
    console.error('No plattr.yaml found in current directory.');
    console.error('Run "plattr init" to create one.');
    process.exit(1);
  }
  return yaml.load(readFileSync(configPath, 'utf-8')) as AppConfig;
}
