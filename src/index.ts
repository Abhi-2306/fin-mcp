#!/usr/bin/env bun
/**
 * mcp-finance-server
 *
 * A Model Context Protocol server that exposes six financial-data tools backed
 * by the Alpha Vantage API. It speaks MCP over a stdio transport, so any MCP
 * client (e.g. Claude Desktop) can spawn it as a subprocess and call its tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AlphaVantageProvider } from "./alphavantage.ts";
import { CachingFinanceProvider } from "./cache.ts";
import { requireApiKey } from "./config.ts";
import { ResilientProvider } from "./limiter.ts";
import { ProviderError, type FinanceProvider } from "./provider.ts";
import { checkCriteria, settleAll, type ScreenCriteria } from "./screening.ts";

/* --------------------------------- helpers -------------------------------- */

/** A tool result containing a single block of text. */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** A tool result flagged as an error (clients surface this to the model/user). */
const errorText = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

/** Pretty-print any value as a JSON text block. */
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

/**
 * Wrap a tool body so every Alpha Vantage failure becomes a clean, non-throwing
 * tool error result instead of an unhandled exception that kills the request.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof errorText>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) {
      const prefix = {
        bad_ticker: "Invalid ticker / no data",
        rate_limit: "Alpha Vantage rate limit reached",
        network: "Network error",
        unexpected: "Unexpected response",
      }[err.kind];
      return errorText(`${prefix}: ${err.message}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorText(`Unexpected error: ${msg}`);
  }
}

const tickerSchema = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z.\-]+$/, "Ticker must be letters, '.', or '-' (e.g. AAPL, BRK.B)")
  .transform((s) => s.toUpperCase());

const fmtMarketCap = (n: number): string => {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
};

/* --------------------------------- server --------------------------------- */

/**
 * Build the MCP server and register all six tools against the supplied
 * `FinanceProvider`. The provider is injected (not hard-wired) so production
 * can pass the cached/resilient Alpha Vantage stack while the eval harness
 * passes a `MockFinanceProvider` — the tool handlers are identical either way.
 */
export function createServer(provider: FinanceProvider): McpServer {
  const server = new McpServer({
    name: "mcp-finance-server",
    version: "1.0.0",
  });

  /* 1. get_stock_price -------------------------------------------------------- */
  server.registerTool(
  "get_stock_price",
  {
    title: "Get Stock Price",
    description:
      "Get the current price, absolute & percentage daily change, and trading volume for a single stock ticker.",
    inputSchema: { ticker: tickerSchema },
  },
  async ({ ticker }) =>
    guard(async () => {
      const q = await provider.getQuote(ticker);
      return json({
        ticker: q.symbol,
        price: q.price,
        change: q.change,
        changePercent: q.changePercent,
        volume: q.volume,
        previousClose: q.previousClose,
        latestTradingDay: q.latestTradingDay,
      });
    }),
);

/* 2. get_company_overview --------------------------------------------------- */
server.registerTool(
  "get_company_overview",
  {
    title: "Get Company Overview",
    description:
      "Get company fundamentals for a ticker: name, sector, market cap, P/E ratio, and 52-week high/low.",
    inputSchema: { ticker: tickerSchema },
  },
  async ({ ticker }) =>
    guard(async () => {
      const o = await provider.getOverview(ticker);
      return json({
        ticker: o.symbol,
        name: o.name,
        sector: o.sector,
        industry: o.industry,
        marketCap: o.marketCap,
        marketCapFormatted: fmtMarketCap(o.marketCap),
        peRatio: o.peRatio,
        eps: o.eps,
        dividendYield: o.dividendYield,
        week52High: o.week52High,
        week52Low: o.week52Low,
      });
    }),
);

/* 3. get_earnings_report ---------------------------------------------------- */
server.registerTool(
  "get_earnings_report",
  {
    title: "Get Earnings Report",
    description:
      "Get the last N quarters (default 4) of EPS for a ticker, comparing reported (actual) vs. estimated EPS.",
    inputSchema: {
      ticker: tickerSchema,
      quarters: z.number().int().min(1).max(8).default(4).describe("How many recent quarters to return"),
    },
  },
  async ({ ticker, quarters }) =>
    guard(async () => {
      // Provider returns all available quarters; slice to the requested count.
      const earnings = (await provider.getEarnings(ticker)).slice(0, quarters);
      return json({
        ticker,
        quarters: earnings.map((e) => ({
          fiscalDateEnding: e.fiscalDateEnding,
          reportedDate: e.reportedDate,
          reportedEPS: e.reportedEPS,
          estimatedEPS: e.estimatedEPS,
          surprise: e.surprise,
          surprisePercentage: e.surprisePercentage,
          beat: e.reportedEPS !== null && e.estimatedEPS !== null ? e.reportedEPS >= e.estimatedEPS : null,
        })),
      });
    }),
);

/* 4. compare_stocks --------------------------------------------------------- */
server.registerTool(
  "compare_stocks",
  {
    title: "Compare Stocks",
    description:
      "Compare 2-5 tickers side by side on price, daily change %, market cap, P/E ratio, and 52-week range.",
    inputSchema: {
      tickers: z.array(tickerSchema).min(2).max(5).describe("List of 2-5 tickers to compare"),
    },
  },
  async ({ tickers }) =>
    guard(async () => {
      // Dedupe while preserving order.
      const unique = [...new Set(tickers)];

      // Fetch each ticker, capturing per-ticker failures explicitly. The quote
      // is the essential comparison datum, so a ticker is only "compared" if the
      // quote succeeds; the overview is a best-effort supplement (may be null).
      const settled = await settleAll(unique, async (t) => {
        const quote = await provider.getQuote(t);
        const overview = await provider.getOverview(t).catch(() => null);
        return { quote, overview };
      });

      const comparison = [];
      const failures = [];
      for (const r of settled) {
        if (!r.ok) {
          failures.push({ ticker: r.ticker, reason: r.reason });
          continue;
        }
        const { quote, overview } = r.value;
        comparison.push({
          ticker: r.ticker,
          price: quote.price,
          changePercent: quote.changePercent,
          volume: quote.volume,
          name: overview?.name ?? null,
          sector: overview?.sector ?? null,
          marketCap: overview?.marketCap ?? null,
          marketCapFormatted: overview ? fmtMarketCap(overview.marketCap) : null,
          peRatio: overview?.peRatio ?? null,
          week52High: overview?.week52High ?? null,
          week52Low: overview?.week52Low ?? null,
        });
      }

      // Explicit counts so a partial result is never mistaken for a complete one.
      return json({
        requested: unique.length,
        compared: comparison.length,
        failed: failures.length,
        comparison,
        failures,
      });
    }),
);

/* 5. get_top_gainers_losers ------------------------------------------------- */
server.registerTool(
  "get_top_gainers_losers",
  {
    title: "Get Top Gainers & Losers",
    description: "Get the top 5 gaining and top 5 losing US-market stocks for the most recent trading session.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const movers = await provider.getTopMovers();
      return json({
        lastUpdated: movers.lastUpdated,
        topGainers: movers.topGainers,
        topLosers: movers.topLosers,
      });
    }),
);

/* 6. screen_stocks ---------------------------------------------------------- */
server.registerTool(
  "screen_stocks",
  {
    title: "Screen Stocks",
    description:
      "Filter a list of candidate tickers by sector, P/E range, and minimum market cap. " +
      "Note: Alpha Vantage's free tier has no native screener endpoint, so you must supply the candidate " +
      "universe via `tickers`; each is fetched and then filtered against your criteria.",
    inputSchema: {
      tickers: z
        .array(tickerSchema)
        .min(1)
        .max(20)
        .describe("Candidate tickers to evaluate (the universe to screen)"),
      sector: z.string().trim().min(1).optional().describe("Case-insensitive sector match, e.g. 'Technology'"),
      minPe: z.number().min(0).optional().describe("Minimum P/E ratio"),
      maxPe: z.number().min(0).optional().describe("Maximum P/E ratio"),
      minMarketCap: z.number().min(0).optional().describe("Minimum market cap in USD"),
    },
  },
  async ({ tickers, sector, minPe, maxPe, minMarketCap }) =>
    guard(async () => {
      const unique = [...new Set(tickers)];
      const criteria: ScreenCriteria = { sector, minPe, maxPe, minMarketCap };

      // Fetch every candidate, capturing fetch failures explicitly so they are
      // never silently dropped (the original silent-failure bug).
      const settled = await settleAll(unique, (t) => provider.getOverview(t));

      const results = []; // matched: passed all criteria
      const rejected = []; // did_not_match: fetched fine but failed a criterion
      const failures = []; // failed: could not fetch at all

      for (const r of settled) {
        if (!r.ok) {
          failures.push({ ticker: r.ticker, reason: r.reason });
          continue;
        }
        const o = r.value;
        const failedCriteria = checkCriteria(o, criteria);
        const row = {
          ticker: o.symbol,
          name: o.name,
          sector: o.sector,
          marketCap: o.marketCap,
          marketCapFormatted: fmtMarketCap(o.marketCap),
          peRatio: o.peRatio,
        };
        if (failedCriteria.length === 0) {
          results.push(row);
        } else {
          rejected.push({ ...row, failedCriteria });
        }
      }

      // Three explicit states + counts: matched / didNotMatch / failed.
      // matched + didNotMatch + failed === evaluated, always.
      return json({
        criteria: {
          sector: sector ?? null,
          minPe: minPe ?? null,
          maxPe: maxPe ?? null,
          minMarketCap: minMarketCap ?? null,
        },
        evaluated: unique.length,
        matched: results.length,
        didNotMatch: rejected.length,
        failed: failures.length,
        results,
        rejected,
        failures,
      });
    }),
  );

  return server;
}

/* --------------------------------- startup -------------------------------- */

/**
 * Compose the production provider stack. Layered, outermost first:
 *   CachingFinanceProvider → in-memory TTL cache + single-flight
 *     └─ ResilientProvider → concurrency limiter (≤2) + retry/backoff
 *         └─ AlphaVantageProvider → fetch + parse
 */
function buildProvider(): FinanceProvider {
  return new CachingFinanceProvider(new ResilientProvider(new AlphaVantageProvider()));
}

async function main() {
  // Fail fast: refuse to start without a real Alpha Vantage key (exits if missing).
  requireApiKey();

  const server = createServer(buildProvider());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout: it is the MCP transport. Logs go to stderr.
  console.error("mcp-finance-server running on stdio");
}

// Only launch when run as the entry point — importing this module (e.g. from
// the eval harness or tests) must not start the stdio server or require a key.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error starting mcp-finance-server:", err);
    process.exit(1);
  });
}
