export interface RetryOptions {
  retries: number;
  baseMs?: number;
  isRetryable: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Exponential backoff with jitter. `retries` is the number of extra attempts after the first. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const base = o.baseMs ?? 300;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= o.retries || !o.isRetryable(e)) throw e;
      await sleep(base * 2 ** attempt * (0.5 + Math.random()));
      attempt++;
    }
  }
}
