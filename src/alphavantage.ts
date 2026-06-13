/**
 * Alpha Vantage implementation of `FinanceProvider`.
 *
 * This is the only layer that knows Alpha Vantage's URL shape and its quirk of
 * signaling errors inside a 200 OK body. It is intentionally a *pure* fetch +
 * parse layer: throttling and retries are applied by wrapping it in a
 * `ResilientProvider` (see `limiter.ts`), and caching by `CachingFinanceProvider`.
 *
 * The three failure modes are normalized into `ProviderError`:
 *   - bad ticker     -> empty payload / "Error Message"
 *   - rate limit hit  -> "Note" / "Information" string
 *   - network failure -> fetch throws / non-2xx HTTP status
 */

import { requireApiKey } from "./config.ts";
import {
  ProviderError,
  type CompanyOverview,
  type FinanceProvider,
  type GlobalQuote,
  type Mover,
  type QuarterlyEarning,
  type TopMovers,
} from "./provider.ts";

const BASE_URL = "https://www.alphavantage.co/query";

type Query = Record<string, string>;

/** Parse Alpha Vantage's string-typed numerics, treating its missing-value sentinels as null. */
export const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "" || v === "None" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class AlphaVantageProvider implements FinanceProvider {
  /** A single raw HTTP attempt, mapping all failure modes to `ProviderError`. */
  private async request(params: Query): Promise<Record<string, unknown>> {
    const url = new URL(BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // requireApiKey() is validated once at startup and cached; never the demo key.
    url.searchParams.set("apikey", requireApiKey());

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "mcp-finance-server" },
        signal: AbortSignal.timeout(15_000), // guard against a hung connection
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`Network request to Alpha Vantage failed: ${reason}`, "network");
    }

    if (!res.ok) {
      throw new ProviderError(`Alpha Vantage returned HTTP ${res.status} ${res.statusText}`, "network");
    }

    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError("Alpha Vantage returned a non-JSON response", "unexpected");
    }

    // Alpha Vantage signals problems inside a 200 OK body.
    if (typeof body["Error Message"] === "string") {
      throw new ProviderError(String(body["Error Message"]), "bad_ticker");
    }
    if (typeof body["Note"] === "string") {
      throw new ProviderError(String(body["Note"]), "rate_limit");
    }
    // The free tier returns an "Information" string when the daily/min cap is hit.
    if (typeof body["Information"] === "string") {
      const info = String(body["Information"]);
      const kind = /rate limit|api key|premium|frequency|sparingly|per second/i.test(info)
        ? "rate_limit"
        : "unexpected";
      throw new ProviderError(info, kind);
    }

    return body;
  }

  async getQuote(symbol: string): Promise<GlobalQuote> {
    const body = await this.request({ function: "GLOBAL_QUOTE", symbol });
    const q = body["Global Quote"] as Record<string, string> | undefined;
    if (!q || Object.keys(q).length === 0) {
      throw new ProviderError(`No quote data found for ticker "${symbol}"`, "bad_ticker");
    }
    return {
      symbol: q["01. symbol"] ?? symbol,
      price: num(q["05. price"]) ?? 0,
      change: num(q["09. change"]) ?? 0,
      changePercent: q["10. change percent"] ?? "0%",
      volume: num(q["06. volume"]) ?? 0,
      latestTradingDay: q["07. latest trading day"] ?? "",
      previousClose: num(q["08. previous close"]) ?? 0,
    };
  }

  async getOverview(symbol: string): Promise<CompanyOverview> {
    const body = await this.request({ function: "OVERVIEW", symbol });
    // A bad ticker yields an empty `{}` object with a 200 status.
    if (!body || Object.keys(body).length === 0 || !body["Symbol"]) {
      throw new ProviderError(`No company overview found for ticker "${symbol}"`, "bad_ticker");
    }
    return {
      symbol: String(body["Symbol"]),
      name: String(body["Name"] ?? ""),
      sector: String(body["Sector"] ?? "Unknown"),
      industry: String(body["Industry"] ?? "Unknown"),
      marketCap: num(body["MarketCapitalization"]) ?? 0,
      peRatio: num(body["PERatio"]),
      eps: num(body["EPS"]),
      dividendYield: num(body["DividendYield"]),
      week52High: num(body["52WeekHigh"]),
      week52Low: num(body["52WeekLow"]),
      description: String(body["Description"] ?? ""),
    };
  }

  async getEarnings(symbol: string): Promise<QuarterlyEarning[]> {
    const body = await this.request({ function: "EARNINGS", symbol });
    const quarterly = body["quarterlyEarnings"] as Array<Record<string, string>> | undefined;
    if (!Array.isArray(quarterly) || quarterly.length === 0) {
      throw new ProviderError(`No earnings data found for ticker "${symbol}"`, "bad_ticker");
    }
    // Return all available quarters; callers slice to the count they want.
    return quarterly.map((q) => ({
      fiscalDateEnding: q["fiscalDateEnding"] ?? "",
      reportedDate: q["reportedDate"] ?? "",
      reportedEPS: num(q["reportedEPS"]),
      estimatedEPS: num(q["estimatedEPS"]),
      surprise: num(q["surprise"]),
      surprisePercentage: num(q["surprisePercentage"]),
    }));
  }

  async getTopMovers(): Promise<TopMovers> {
    const body = await this.request({ function: "TOP_GAINERS_LOSERS" });
    const mapMover = (m: Record<string, string>): Mover => ({
      ticker: m["ticker"] ?? "",
      price: num(m["price"]) ?? 0,
      changeAmount: num(m["change_amount"]) ?? 0,
      changePercentage: m["change_percentage"] ?? "0%",
      volume: num(m["volume"]) ?? 0,
    });
    const gainers = (body["top_gainers"] as Array<Record<string, string>>) ?? [];
    const losers = (body["top_losers"] as Array<Record<string, string>>) ?? [];
    if (gainers.length === 0 && losers.length === 0) {
      throw new ProviderError("No top gainers/losers data available", "unexpected");
    }
    return {
      lastUpdated: String(body["last_updated"] ?? ""),
      topGainers: gainers.slice(0, 5).map(mapMover),
      topLosers: losers.slice(0, 5).map(mapMover),
    };
  }
}
