/** Exponential-backoff retry for transient failures. Caller decides what's retryable. */
import type { Logger } from "@/lib/logger/logger";

export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly isRetryable: (err: unknown) => boolean;
  readonly logger?: Logger;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(work: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await work();
    } catch (err) {
      lastErr = err;
      const exhausted = attempt === opts.maxRetries;
      if (exhausted || !opts.isRetryable(err)) throw err;
      const delay = opts.baseDelayMs * 2 ** attempt;
      opts.logger?.warn("retrying after transient failure", {
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: delay,
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}
