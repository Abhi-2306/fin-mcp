/**
 * Canned fixtures + a MockFinanceProvider for the eval harness.
 *
 * The mock implements the same `FinanceProvider` interface as the real Alpha
 * Vantage provider, so the eval exercises the genuine tool handlers and
 * cache/retry/limiter layers without ever touching the network.
 */

import {
  ProviderError,
  type CompanyOverview,
  type FinanceProvider,
  type GlobalQuote,
  type QuarterlyEarning,
  type TopMovers,
} from "../src/provider.ts";

/* ------------------------------ mock provider ----------------------------- */

export interface MockData {
  quotes?: Record<string, GlobalQuote>;
  overviews?: Record<string, CompanyOverview>;
  earnings?: Record<string, QuarterlyEarning[]>;
  topMovers?: TopMovers;
  /** symbol → error thrown on ANY method for that symbol (simulates a fetch failure). */
  throwers?: Record<string, ProviderError>;
}

export class MockFinanceProvider implements FinanceProvider {
  /** Per-`method:symbol` invocation counts, for asserting retry/single-flight behavior. */
  readonly calls: Record<string, number> = {};

  constructor(private readonly data: MockData = {}) {}

  count(method: string, symbol = ""): number {
    return this.calls[`${method}:${symbol}`] ?? 0;
  }

  private track(method: string, symbol = ""): void {
    const key = `${method}:${symbol}`;
    this.calls[key] = (this.calls[key] ?? 0) + 1;
  }

  private maybeThrow(symbol: string): void {
    const err = this.data.throwers?.[symbol];
    if (err) throw err;
  }

  async getQuote(symbol: string): Promise<GlobalQuote> {
    this.track("getQuote", symbol);
    this.maybeThrow(symbol);
    const q = this.data.quotes?.[symbol];
    if (!q) throw new ProviderError(`No quote data found for ticker "${symbol}"`, "bad_ticker");
    return q;
  }

  async getOverview(symbol: string): Promise<CompanyOverview> {
    this.track("getOverview", symbol);
    this.maybeThrow(symbol);
    const o = this.data.overviews?.[symbol];
    if (!o) throw new ProviderError(`No company overview found for ticker "${symbol}"`, "bad_ticker");
    return o;
  }

  async getEarnings(symbol: string): Promise<QuarterlyEarning[]> {
    this.track("getEarnings", symbol);
    this.maybeThrow(symbol);
    const e = this.data.earnings?.[symbol];
    if (!e) throw new ProviderError(`No earnings data found for ticker "${symbol}"`, "bad_ticker");
    return e;
  }

  async getTopMovers(): Promise<TopMovers> {
    this.track("getTopMovers");
    if (!this.data.topMovers) throw new ProviderError("No top gainers/losers data available", "unexpected");
    return this.data.topMovers;
  }
}

/* -------------------------------- builders -------------------------------- */

const quote = (symbol: string, price: number): GlobalQuote => ({
  symbol,
  price,
  change: 1.23,
  changePercent: "0.42%",
  volume: 1_000_000,
  latestTradingDay: "2026-06-12",
  previousClose: price - 1.23,
});

const overview = (
  symbol: string,
  name: string,
  sector: string,
  marketCap: number,
  peRatio: number | null,
): CompanyOverview => ({
  symbol,
  name,
  sector,
  industry: "—",
  marketCap,
  peRatio,
  eps: peRatio === null ? null : 5,
  dividendYield: null,
  week52High: 200,
  week52Low: 50,
  description: "",
});

/* ------------------------------- the dataset ------------------------------ */

/**
 * Default canned universe used by most eval cases:
 *   AAPL  — Technology, P/E 35 (fails maxPe=30)
 *   MSFT  — Technology, P/E 28 (matches maxPe=30)
 *   GOOGL — Technology, P/E 24
 *   XOM   — Energy (fails sector=Technology)
 *   NOEPS — Technology, P/E null (a company with no earnings)
 */
export const defaultData: MockData = {
  quotes: {
    AAPL: quote("AAPL", 291.13),
    MSFT: quote("MSFT", 470.5),
    GOOGL: quote("GOOGL", 178.2),
  },
  overviews: {
    AAPL: overview("AAPL", "Apple Inc", "Technology", 4_275_000_000_000, 35),
    MSFT: overview("MSFT", "Microsoft Corp", "Technology", 3_300_000_000_000, 28),
    GOOGL: overview("GOOGL", "Alphabet Inc", "Technology", 2_100_000_000_000, 24),
    XOM: overview("XOM", "Exxon Mobil Corp", "Energy", 500_000_000_000, 12),
    NOEPS: overview("NOEPS", "No Earnings Co", "Technology", 2_000_000_000, null),
  },
  earnings: {
    // Mixed beats/misses so the eval can verify `beat === (reported >= estimated)`.
    AAPL: [
      { fiscalDateEnding: "2026-03-31", reportedDate: "2026-04-30", reportedEPS: 2.1, estimatedEPS: 2.0, surprise: 0.1, surprisePercentage: 5 },
      { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-30", reportedEPS: 1.8, estimatedEPS: 1.9, surprise: -0.1, surprisePercentage: -5.3 },
      { fiscalDateEnding: "2025-09-30", reportedDate: "2025-10-30", reportedEPS: 1.5, estimatedEPS: 1.5, surprise: 0, surprisePercentage: 0 },
      { fiscalDateEnding: "2025-06-30", reportedDate: "2025-07-30", reportedEPS: 2.3, estimatedEPS: 2.0, surprise: 0.3, surprisePercentage: 15 },
      { fiscalDateEnding: "2025-03-31", reportedDate: "2025-04-30", reportedEPS: 1.0, estimatedEPS: 1.2, surprise: -0.2, surprisePercentage: -16.7 },
    ],
  },
  topMovers: {
    lastUpdated: "2026-06-12 16:15:00 US/Eastern",
    topGainers: Array.from({ length: 5 }, (_, i) => ({
      ticker: `GAIN${i}`,
      price: 10 + i,
      changeAmount: 4 + i,
      changePercentage: `${40 + i}%`,
      volume: 1_000_000 + i,
    })),
    topLosers: Array.from({ length: 5 }, (_, i) => ({
      ticker: `LOSE${i}`,
      price: 9 - i,
      changeAmount: -(4 + i),
      changePercentage: `-${40 + i}%`,
      volume: 1_000_000 + i,
    })),
  },
};
