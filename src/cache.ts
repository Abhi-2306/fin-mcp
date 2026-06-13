/**
 * In-memory caching layer.
 *
 * `TtlCache` is a generic key → value store with per-entry TTL and hit/miss
 * accounting. `CachingFinanceProvider` is a decorator that wraps any
 * `FinanceProvider` and caches each method's result under a `function:ticker`
 * key with the appropriate TTL — so a cache hit short-circuits before the
 * request ever reaches the retry/limiter/network layers below it.
 */

import type { FinanceProvider } from "./provider.ts";

/** Per-data-type TTLs. Prices move constantly; fundamentals barely change intraday. */
export const TTL = {
  quote: 60_000, // 60s
  topMovers: 60_000, // 60s
  overview: 6 * 60 * 60_000, // 6 hours
  earnings: 6 * 60 * 60_000, // 6 hours
} as const;

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class TtlCache {
  private readonly store = new Map<string, Entry>();
  // Single-flight: in-flight fetches keyed by cache key, so concurrent misses
  // for the same key share one network request instead of stampeding.
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;

  /**
   * Return the cached value for `key` if still fresh; otherwise run `fetcher`,
   * cache its result for `ttlMs`, and return it. Concurrent calls for the same
   * key while a fetch is in flight are coalesced onto that one fetch. Hits,
   * misses, and coalesced waits are counted and logged to stderr (stdout is
   * reserved for the MCP transport).
   */
  async getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);

    if (hit && hit.expiresAt > now) {
      this.hits++;
      this.log("HIT ", key);
      return hit.value as T;
    }

    // A fetch for this key is already running — wait on it instead of starting
    // another. Counts as a hit (no extra network request was made).
    const pending = this.inflight.get(key);
    if (pending) {
      this.hits++;
      this.log("WAIT", key);
      return pending as Promise<T>;
    }

    this.misses++;
    this.log("MISS", key);
    const fetch = (async () => {
      try {
        const value = await fetcher();
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, fetch);
    return fetch as Promise<T>;
  }

  /** Expose running hit/miss counts and current entry count. */
  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  private log(event: string, key: string): void {
    const { hits, misses } = this;
    const total = hits + misses;
    const rate = total === 0 ? 0 : Math.round((hits / total) * 100);
    console.error(`[cache] ${event} ${key} (hits=${hits} misses=${misses} rate=${rate}%)`);
  }
}

/**
 * Wraps a `FinanceProvider` so every call is served from cache when fresh.
 * Cache key is `function:ticker` (top-movers has no ticker), per the TTL table.
 */
export class CachingFinanceProvider implements FinanceProvider {
  constructor(
    private readonly inner: FinanceProvider,
    private readonly cache: TtlCache = new TtlCache(),
  ) {}

  getQuote(symbol: string) {
    return this.cache.getOrFetch(`getQuote:${symbol}`, TTL.quote, () => this.inner.getQuote(symbol));
  }

  getOverview(symbol: string) {
    return this.cache.getOrFetch(`getOverview:${symbol}`, TTL.overview, () => this.inner.getOverview(symbol));
  }

  getEarnings(symbol: string) {
    return this.cache.getOrFetch(`getEarnings:${symbol}`, TTL.earnings, () => this.inner.getEarnings(symbol));
  }

  getTopMovers() {
    return this.cache.getOrFetch(`getTopMovers`, TTL.topMovers, () => this.inner.getTopMovers());
  }

  /** Pass-through to the underlying cache stats. */
  stats(): CacheStats {
    return this.cache.stats();
  }
}
