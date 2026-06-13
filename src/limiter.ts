/**
 * Throttled concurrency + retry-with-backoff.
 *
 * Two independent primitives the provider composes around every HTTP call:
 *   - `ConcurrencyLimiter` caps how many requests are in flight at once, so a
 *     multi-ticker fan-out can't fire dozens of requests simultaneously and
 *     trip Alpha Vantage's ~1-request-per-second free-tier limit.
 *   - `withRetry` retries transient failures (rate limit / network) with
 *     exponential backoff, and never retries a deterministic `bad_ticker`.
 */

import { ProviderError, type FinanceProvider, type ProviderErrorKind } from "./provider.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* --------------------------- concurrency limiter -------------------------- */

/**
 * Allows at most `max` calls to run concurrently; the rest queue (FIFO) until a
 * slot frees. A slot is held for the *entire* operation passed to `run`, so if
 * a retrying request is sleeping through its backoff it still occupies its slot
 * — which is exactly what we want when the API is rate-limiting us.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/* ------------------------------ retry/backoff ----------------------------- */

/** Only transient failures are worth retrying — a bad ticker will never succeed. */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "network"]);

/** Backoff before each retry: 1s, then 2s, then 4s (up to 3 retries / 4 total attempts). */
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];

export interface RetryOptions {
  /** Override the backoff schedule (also sets the retry count = length). */
  backoffMs?: number[];
}

/**
 * Run `fn`, retrying on retryable `ProviderError`s with exponential backoff.
 * Non-retryable errors (and non-`ProviderError`s) are thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ProviderError && RETRYABLE.has(err.kind);
      const triesLeft = attempt < backoff.length;
      if (!retryable || !triesLeft) throw err;

      const delay = backoff[attempt]!;
      const kind = (err as ProviderError).kind;
      console.error(
        `[retry] attempt ${attempt + 1} failed (${kind}); retrying in ${delay}ms (${backoff.length - attempt - 1} left)`,
      );
      await sleep(delay);
    }
  }
}

/* --------------------------- resilient decorator -------------------------- */

export interface ResilientOptions {
  /** Max concurrent in-flight requests (default 2). */
  maxConcurrent?: number;
  /** Retry backoff schedule in ms (default 1s/2s/4s). Pass `[]` to disable retries. */
  backoffMs?: number[];
}

/**
 * Wraps any `FinanceProvider` so every method call is throttled by a shared
 * `ConcurrencyLimiter` and retried via `withRetry`. Composing this as a
 * decorator (rather than baking it into one provider) means the real Alpha
 * Vantage provider and the test `MockFinanceProvider` get identical resilience
 * — so the eval harness exercises the true retry/limiter behavior offline.
 */
export class ResilientProvider implements FinanceProvider {
  private readonly limiter: ConcurrencyLimiter;
  private readonly backoffMs?: number[];

  constructor(
    private readonly inner: FinanceProvider,
    opts: ResilientOptions = {},
  ) {
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrent ?? 2);
    this.backoffMs = opts.backoffMs;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    // Limiter outside retry: a retrying call holds its slot through backoff, so
    // we don't free capacity for new requests to pile on while being throttled.
    return this.limiter.run(() => withRetry(fn, { backoffMs: this.backoffMs }));
  }

  getQuote(symbol: string) {
    return this.run(() => this.inner.getQuote(symbol));
  }
  getOverview(symbol: string) {
    return this.run(() => this.inner.getOverview(symbol));
  }
  getEarnings(symbol: string) {
    return this.run(() => this.inner.getEarnings(symbol));
  }
  getTopMovers() {
    return this.run(() => this.inner.getTopMovers());
  }
}
