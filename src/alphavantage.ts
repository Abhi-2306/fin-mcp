/**
 * Thin, typed wrapper around the Alpha Vantage REST API.
 *
 * Every public method returns parsed JSON and translates the three failure
 * modes we care about into a single `AlphaVantageError`:
 *   - bad ticker        -> the API returns an empty payload / "Error Message"
 *   - rate limit hit     -> the API returns a "Note" or "Information" string
 *   - network failure    -> fetch throws / non-2xx HTTP status
 */

const BASE_URL = "https://www.alphavantage.co/query";

/** API key is read from the environment so it never lives in source control. */
const API_KEY = process.env.ALPHAVANTAGE_API_KEY ?? "demo";

/** Distinct error type so tool handlers can produce clean, user-facing text. */
export class AlphaVantageError extends Error {
  constructor(
    message: string,
    readonly kind: "bad_ticker" | "rate_limit" | "network" | "unexpected",
  ) {
    super(message);
    this.name = "AlphaVantageError";
  }
}

type Query = Record<string, string>;

async function request(params: Query): Promise<Record<string, unknown>> {
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", API_KEY);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "mcp-finance-server" },
      // guard against a hung connection
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AlphaVantageError(`Network request to Alpha Vantage failed: ${reason}`, "network");
  }

  if (!res.ok) {
    throw new AlphaVantageError(
      `Alpha Vantage returned HTTP ${res.status} ${res.statusText}`,
      "network",
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new AlphaVantageError("Alpha Vantage returned a non-JSON response", "unexpected");
  }

  // Alpha Vantage signals problems inside a 200 OK body.
  if (typeof body["Error Message"] === "string") {
    throw new AlphaVantageError(String(body["Error Message"]), "bad_ticker");
  }
  if (typeof body["Note"] === "string") {
    throw new AlphaVantageError(String(body["Note"]), "rate_limit");
  }
  // The free tier returns an "Information" string when the daily/min cap is hit.
  if (typeof body["Information"] === "string") {
    const info = String(body["Information"]);
    const kind = /rate limit|api key|premium|frequency/i.test(info) ? "rate_limit" : "unexpected";
    throw new AlphaVantageError(info, kind);
  }

  return body;
}

/* ----------------------------- response shapes ---------------------------- */

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

/* ------------------------------- parsing ---------------------------------- */

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "" || v === "None" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function getGlobalQuote(symbol: string): Promise<GlobalQuote> {
  const body = await request({ function: "GLOBAL_QUOTE", symbol });
  const q = body["Global Quote"] as Record<string, string> | undefined;
  if (!q || Object.keys(q).length === 0) {
    throw new AlphaVantageError(`No quote data found for ticker "${symbol}"`, "bad_ticker");
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

export async function getCompanyOverview(symbol: string): Promise<CompanyOverview> {
  const body = await request({ function: "OVERVIEW", symbol });
  // A bad ticker yields an empty `{}` object with a 200 status.
  if (!body || Object.keys(body).length === 0 || !body["Symbol"]) {
    throw new AlphaVantageError(`No company overview found for ticker "${symbol}"`, "bad_ticker");
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

export async function getEarnings(symbol: string, quarters = 4): Promise<QuarterlyEarning[]> {
  const body = await request({ function: "EARNINGS", symbol });
  const quarterly = body["quarterlyEarnings"] as Array<Record<string, string>> | undefined;
  if (!Array.isArray(quarterly) || quarterly.length === 0) {
    throw new AlphaVantageError(`No earnings data found for ticker "${symbol}"`, "bad_ticker");
  }
  return quarterly.slice(0, quarters).map((q) => ({
    fiscalDateEnding: q["fiscalDateEnding"] ?? "",
    reportedDate: q["reportedDate"] ?? "",
    reportedEPS: num(q["reportedEPS"]),
    estimatedEPS: num(q["estimatedEPS"]),
    surprise: num(q["surprise"]),
    surprisePercentage: num(q["surprisePercentage"]),
  }));
}

export async function getTopMovers(): Promise<TopMovers> {
  const body = await request({ function: "TOP_GAINERS_LOSERS" });
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
    throw new AlphaVantageError("No top gainers/losers data available", "unexpected");
  }
  return {
    lastUpdated: String(body["last_updated"] ?? ""),
    topGainers: gainers.slice(0, 5).map(mapMover),
    topLosers: losers.slice(0, 5).map(mapMover),
  };
}
