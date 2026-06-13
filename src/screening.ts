/**
 * Multi-ticker evaluation helpers used by `compare_stocks` and `screen_stocks`.
 *
 * The core problem these solve: when you evaluate many tickers, a *failed fetch*
 * (network/rate-limit/bad-ticker) must never be silently conflated with a
 * ticker that was fetched fine but simply *didn't match* the criteria. We make
 * those outcomes explicit so a partial result can never masquerade as complete.
 */

import type { CompanyOverview } from "./provider.ts";

/* --------------------------- generic fetch settling ----------------------- */

/** Outcome of fetching data for one ticker: either a value, or a failure reason. */
export type Settled<T> =
  | { ticker: string; ok: true; value: T }
  | { ticker: string; ok: false; reason: string };

/**
 * Fetch `fn(ticker)` for every ticker in parallel, capturing per-ticker errors
 * instead of letting one failure reject the whole batch. The returned array
 * preserves input order and reports each ticker's outcome explicitly.
 */
export async function settleAll<T>(
  tickers: string[],
  fn: (ticker: string) => Promise<T>,
): Promise<Array<Settled<T>>> {
  return Promise.all(
    tickers.map(async (ticker): Promise<Settled<T>> => {
      try {
        return { ticker, ok: true, value: await fn(ticker) };
      } catch (err) {
        return { ticker, ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/* ------------------------------ screen criteria --------------------------- */

/** The filters a caller can apply in `screen_stocks`. All are optional. */
export interface ScreenCriteria {
  sector?: string;
  minPe?: number;
  maxPe?: number;
  minMarketCap?: number;
}

/** A single criterion that a stock failed, with the expected vs. actual value. */
export interface CriterionFailure {
  criterion: "sector" | "minPe" | "maxPe" | "minMarketCap";
  expected: string;
  actual: string;
}

/**
 * Check one company against the criteria.
 *
 * Returns the list of criteria it FAILED. An empty array means it matched all
 * supplied criteria. (A criterion that wasn't supplied is never a failure.)
 */
export function checkCriteria(o: CompanyOverview, c: ScreenCriteria): CriterionFailure[] {
  const failures: CriterionFailure[] = [];
  const peText = o.peRatio === null ? "null" : String(o.peRatio);

  if (c.sector && o.sector.toLowerCase() !== c.sector.toLowerCase()) {
    failures.push({ criterion: "sector", expected: c.sector, actual: o.sector });
  }
  if (c.minMarketCap !== undefined && o.marketCap < c.minMarketCap) {
    failures.push({ criterion: "minMarketCap", expected: `>= ${c.minMarketCap}`, actual: String(o.marketCap) });
  }
  if (c.minPe !== undefined && (o.peRatio === null || o.peRatio < c.minPe)) {
    failures.push({ criterion: "minPe", expected: `>= ${c.minPe}`, actual: peText });
  }
  if (c.maxPe !== undefined && (o.peRatio === null || o.peRatio > c.maxPe)) {
    failures.push({ criterion: "maxPe", expected: `<= ${c.maxPe}`, actual: peText });
  }
  return failures;
}
