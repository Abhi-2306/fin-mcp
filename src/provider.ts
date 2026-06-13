/**
 * Provider abstraction.
 *
 * The MCP tools depend only on the `FinanceProvider` interface and these
 * provider-agnostic data shapes — never on a concrete data source. Alpha
 * Vantage is currently the only implementation (see `alphavantage.ts`), but a
 * second provider could be dropped in without touching the tools, the cache,
 * or the limiter.
 */

/* ------------------------------- errors ----------------------------------- */

/**
 * How a request failed. The taxonomy is part of the provider contract: the
 * retry layer keys off it (only `rate_limit`/`network` are retried) and the
 * MCP tool layer maps it to a user-facing message.
 */
export type ProviderErrorKind = "bad_ticker" | "rate_limit" | "network" | "unexpected";

/** A normalized error any provider throws, so layers above stay provider-agnostic. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/* ----------------------------- data shapes -------------------------------- */

export interface GlobalQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: string;
  volume: number;
  latestTradingDay: string;
  previousClose: number;
}

export interface CompanyOverview {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  marketCap: number;
  peRatio: number | null;
  eps: number | null;
  dividendYield: number | null;
  week52High: number | null;
  week52Low: number | null;
  description: string;
}

export interface QuarterlyEarning {
  fiscalDateEnding: string;
  reportedDate: string;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  surprise: number | null;
  surprisePercentage: number | null;
}

export interface Mover {
  ticker: string;
  price: number;
  changeAmount: number;
  changePercentage: string;
  volume: number;
}

export interface TopMovers {
  lastUpdated: string;
  topGainers: Mover[];
  topLosers: Mover[];
}

/* ------------------------------ the interface ----------------------------- */

/**
 * The contract every financial-data source must satisfy.
 *
 * `getEarnings` returns *all* available quarters; callers slice to the count
 * they want. Keeping it un-sliced means the cache key can stay `function+ticker`
 * regardless of how many quarters a given call asked for.
 */
export interface FinanceProvider {
  getQuote(symbol: string): Promise<GlobalQuote>;
  getOverview(symbol: string): Promise<CompanyOverview>;
  getEarnings(symbol: string): Promise<QuarterlyEarning[]>;
  getTopMovers(): Promise<TopMovers>;
}
