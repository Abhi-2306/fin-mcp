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

import {
  AlphaVantageError,
  getCompanyOverview,
  getEarnings,
  getGlobalQuote,
  getTopMovers,
  type CompanyOverview,
} from "./alphavantage.ts";

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
    if (err instanceof AlphaVantageError) {
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
      const q = await getGlobalQuote(ticker);
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
      const o = await getCompanyOverview(ticker);
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
      const earnings = await getEarnings(ticker, quarters);
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
      const rows = await Promise.all(
        unique.map(async (t) => {
          try {
            const [quote, overview] = await Promise.all([
              getGlobalQuote(t),
              getCompanyOverview(t).catch(() => null as CompanyOverview | null),
            ]);
            return {
              ticker: t,
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
            };
          } catch (err) {
            return { ticker: t, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return json({ comparison: rows });
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
      const movers = await getTopMovers();
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
      const evaluated = await Promise.all(
        unique.map(async (t) => {
          try {
            return await getCompanyOverview(t);
          } catch {
            return null;
          }
        }),
      );

      const matches = evaluated
        .filter((o): o is CompanyOverview => o !== null)
        .filter((o) => {
          if (sector && o.sector.toLowerCase() !== sector.toLowerCase()) return false;
          if (minMarketCap !== undefined && o.marketCap < minMarketCap) return false;
          if (minPe !== undefined && (o.peRatio === null || o.peRatio < minPe)) return false;
          if (maxPe !== undefined && (o.peRatio === null || o.peRatio > maxPe)) return false;
          return true;
        })
        .map((o) => ({
          ticker: o.symbol,
          name: o.name,
          sector: o.sector,
          marketCap: o.marketCap,
          marketCapFormatted: fmtMarketCap(o.marketCap),
          peRatio: o.peRatio,
        }));

      return json({
        criteria: { sector: sector ?? null, minPe: minPe ?? null, maxPe: maxPe ?? null, minMarketCap: minMarketCap ?? null },
        evaluated: unique.length,
        matched: matches.length,
        results: matches,
      });
    }),
);

/* --------------------------------- startup -------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout: it is the MCP transport. Logs go to stderr.
  console.error("mcp-finance-server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting mcp-finance-server:", err);
  process.exit(1);
});
