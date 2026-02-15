import { execSync, ExecSyncOptions } from 'child_process';

export function run(command: string, options: ExecSyncOptions = {}): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: 'inherit',
      cwd: process.cwd(),
      ...options,
    }) as string;
  } catch (err: any) {
    if (err.status === 130) {
      // Ctrl+C — not an error
      process.exit(0);
    }
    throw err;
  }
}

export function runQuiet(command: string): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: process.cwd(),
    }).trim();
  } catch (err: any) {
    throw err;
  }
}
