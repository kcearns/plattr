import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

/**
 * Get the .plattr state directory in the project root, creating it if needed.
 */
export function getStateDir(): string {
  const dir = join(process.cwd(), '.plattr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read existing env file into a Map, merging in new vars, and write back.
 * New values overwrite existing keys.
 */
export function mergeEnvFile(appName: string, newVars: Record<string, string>): void {
  const envFile = join(getStateDir(), `${appName}.env`);
  const existing = new Map<string, string>();

  if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
      if (match) {
        existing.set(match[1], match[2]);
      }
    }
  }

  for (const [key, value] of Object.entries(newVars)) {
    existing.set(key, value);
  }

  const content = Array.from(existing.entries())
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');
  writeFileSync(envFile, content + '\n');
}

/**
 * Read the env file and return key-value pairs.
 * Returns null if the file doesn't exist.
 */
export function readEnvFile(appName: string): Record<string, string> | null {
  const envFile = join(getStateDir(), `${appName}.env`);
  if (!existsSync(envFile)) return null;

  const vars: Record<string, string> = {};
  const lines = readFileSync(envFile, 'utf-8').trim().split('\n');
  for (const line of lines) {
    const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

/**
 * Delete state files for the app.
 */
export function clearState(appName: string): void {
  const dir = getStateDir();
  for (const file of [`${appName}.pids`, `${appName}.env`]) {
    const filePath = join(dir, file);
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}
