interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000, onRetry } = options;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt > maxRetries) throw err;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5);

      if (onRetry) onRetry(attempt, err);
      else console.warn(`  [RETRY] Attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${Math.round(jitter)}ms...`);

      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }
  throw new Error('Unreachable');
}
