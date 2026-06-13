#!/usr/bin/env bun
/**
 * Eval harness for the MCP finance server.
 *
 * Runs a fixed set of cases through the *actual* MCP tool handlers (via an
 * in-memory client⇄server pair) and prints a scorecard. By default it injects a
 * `MockFinanceProvider` with canned fixtures — no network, no quota burned.
 *
 *   bun run eval            # mocked (default)
 *   bun run eval -- --live   # a few real Alpha Vantage spot-checks (needs a key)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/index.ts";
import { AlphaVantageProvider } from "../src/alphavantage.ts";
import { CachingFinanceProvider } from "../src/cache.ts";
import { ResilientProvider, type ResilientOptions } from "../src/limiter.ts";
import { ProviderError, type FinanceProvider } from "../src/provider.ts";
import { defaultData, MockFinanceProvider, type MockData } from "./fixtures.ts";

/* --------------------------------- harness -------------------------------- */

interface Harness {
  mock: MockFinanceProvider;
  cached: CachingFinanceProvider;
  client: Client;
  close: () => Promise<void>;
}

// Small backoff so the retry-related cases run in milliseconds, not seconds.
const FAST_RETRY: ResilientOptions = { backoffMs: [5, 5, 5] };

/** Build a fresh, isolated mock → resilient → cache → server → client stack. */
async function makeHarness(data: MockData, opts: ResilientOptions = FAST_RETRY): Promise<Harness> {
  const mock = new MockFinanceProvider(data);
  const cached = new CachingFinanceProvider(new ResilientProvider(mock, opts));
  const server = createServer(cached);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "eval-harness", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    mock,
    cached,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

interface CallResult {
  rejected: boolean; // the protocol rejected the call (threw) before/around the handler
  isError: boolean; // tool returned an `isError` result
  text: string; // raw text of the first content block (or the thrown message)
  data: any; // parsed JSON of `text`, if it parsed
}

/** Call a tool, normalizing both protocol rejections and `isError` results. */
async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<CallResult> {
  try {
    const r = (await h.client.callTool({ name, arguments: args })) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    const text = r.content?.[0]?.text ?? "";
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { rejected: false, isError: Boolean(r.isError), text, data };
  } catch (err) {
    return { rejected: true, isError: true, text: err instanceof Error ? err.message : String(err), data: undefined };
  }
}

/* ------------------------------- assertions ------------------------------- */

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface Scored {
  desc: string;
  pass: boolean;
  detail: string;
}

/* --------------------------------- cases ---------------------------------- */

type Case = { desc: string; run: () => Promise<string> };

const mockedCases: Case[] = [
  {
    desc: "get_stock_price AAPL → price>0, ticker=AAPL, all fields present",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError, data } = await call(h, "get_stock_price", { ticker: "AAPL" });
        assert(!isError, "unexpected error result");
        assert(data.ticker === "AAPL", `ticker was ${data.ticker}`);
        assert(data.price > 0, "price not > 0");
        for (const f of ["change", "changePercent", "volume", "previousClose", "latestTradingDay"]) {
          assert(f in data, `missing field ${f}`);
        }
        return `price=${data.price}`;
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "get_company_overview MSFT → marketCap>0, peRatio is number, sector present",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError, data } = await call(h, "get_company_overview", { ticker: "MSFT" });
        assert(!isError, "unexpected error result");
        assert(data.marketCap > 0, "marketCap not > 0");
        assert(typeof data.peRatio === "number", "peRatio not a number");
        assert(typeof data.sector === "string" && data.sector.length > 0, "sector missing");
        return `peRatio=${data.peRatio}`;
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "get_company_overview (no earnings) → peRatio is null, no crash",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError, data } = await call(h, "get_company_overview", { ticker: "NOEPS" });
        assert(!isError, "unexpected error result");
        assert(data.peRatio === null, `peRatio was ${data.peRatio}`);
        return "peRatio=null handled";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "get_earnings_report AAPL quarters=4 → ≤4 quarters, beat computed correctly",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError, data } = await call(h, "get_earnings_report", { ticker: "AAPL", quarters: 4 });
        assert(!isError, "unexpected error result");
        assert(data.quarters.length <= 4, `got ${data.quarters.length} quarters`);
        for (const q of data.quarters) {
          if (q.reportedEPS !== null && q.estimatedEPS !== null) {
            assert(q.beat === q.reportedEPS >= q.estimatedEPS, `beat wrong for ${q.fiscalDateEnding}`);
          }
        }
        return `${data.quarters.length} quarters, beats verified`;
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "get_earnings_report quarters=2 → exactly 2 returned (slice works)",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { data } = await call(h, "get_earnings_report", { ticker: "AAPL", quarters: 2 });
        assert(data.quarters.length === 2, `got ${data.quarters.length}`);
        return "exactly 2";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "get_top_gainers_losers → 5 gainers + 5 losers",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { data } = await call(h, "get_top_gainers_losers", {});
        assert(data.topGainers.length === 5, `gainers=${data.topGainers.length}`);
        assert(data.topLosers.length === 5, `losers=${data.topLosers.length}`);
        return "5 + 5";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "compare_stocks [AAPL, MSFT] → both compared; counts reconcile",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { data } = await call(h, "compare_stocks", { tickers: ["AAPL", "MSFT"] });
        assert(data.requested === 2 && data.compared === 2 && data.failed === 0, JSON.stringify(data));
        assert(data.comparison.length === 2, "comparison length");
        return "requested=2 compared=2 failed=0";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "compare_stocks [AAPL, MSFT, GOOGL] where GOOGL throws → GOOGL in failures; counts reconcile",
    run: async () => {
      const data = { ...defaultData, throwers: { GOOGL: new ProviderError("simulated fetch failure", "network") } };
      const h = await makeHarness(data);
      try {
        const { data: out } = await call(h, "compare_stocks", { tickers: ["AAPL", "MSFT", "GOOGL"] });
        assert(out.requested === 3 && out.compared === 2 && out.failed === 1, JSON.stringify(out));
        assert(out.failures.some((f: any) => f.ticker === "GOOGL"), "GOOGL not in failures");
        return "requested=3 compared=2 failed=1, GOOGL in failures";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "screen_stocks [AAPL, XOM, MSFT] sector=Technology maxPe=30 → MSFT matched, AAPL+XOM rejected; invariant holds",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { data } = await call(h, "screen_stocks", {
          tickers: ["AAPL", "XOM", "MSFT"],
          sector: "Technology",
          maxPe: 30,
        });
        assert(
          data.evaluated === data.matched + data.didNotMatch + data.failed,
          `invariant broken: ${JSON.stringify(data)}`,
        );
        assert(data.results.some((r: any) => r.ticker === "MSFT"), "MSFT not matched");
        const aapl = data.rejected.find((r: any) => r.ticker === "AAPL");
        const xom = data.rejected.find((r: any) => r.ticker === "XOM");
        assert(aapl?.failedCriteria.some((c: any) => c.criterion === "maxPe"), "AAPL not rejected on PE");
        assert(xom?.failedCriteria.some((c: any) => c.criterion === "sector"), "XOM not rejected on sector");
        return "MSFT matched; AAPL(PE)+XOM(sector) rejected";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "screen_stocks where one ticker throws → lands in failures; invariant still holds",
    run: async () => {
      const data = { ...defaultData, throwers: { ZFAIL: new ProviderError("simulated fetch failure", "network") } };
      const h = await makeHarness(data);
      try {
        const { data: out } = await call(h, "screen_stocks", {
          tickers: ["MSFT", "AAPL", "ZFAIL"],
          sector: "Technology",
          maxPe: 30,
        });
        assert(out.evaluated === out.matched + out.didNotMatch + out.failed, `invariant broken: ${JSON.stringify(out)}`);
        assert(out.failures.some((f: any) => f.ticker === "ZFAIL"), "ZFAIL not in failures");
        return `evaluated=${out.evaluated}=${out.matched}+${out.didNotMatch}+${out.failed}`;
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: 'get_stock_price "FAKEXYZ" (bad_ticker) → isError, classified "Invalid ticker / no data"',
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError, text } = await call(h, "get_stock_price", { ticker: "FAKEXYZ" });
        assert(isError, "expected isError");
        assert(/Invalid ticker \/ no data/.test(text), `message was: ${text}`);
        return "classified bad_ticker";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: 'get_stock_price "" → rejected by Zod schema before the handler runs',
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const res = await call(h, "get_stock_price", { ticker: "" });
        assert(res.rejected || res.isError, "expected rejection");
        assert(Object.keys(h.mock.calls).length === 0, "handler ran (provider was called)");
        return "rejected pre-handler (provider never called)";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: 'get_stock_price "aapl" → schema transforms to "AAPL"',
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError, data } = await call(h, "get_stock_price", { ticker: "aapl" });
        assert(!isError, "unexpected error");
        assert(data.ticker === "AAPL", `ticker was ${data.ticker}`);
        return "lowercase → AAPL";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "get_stock_price (15-char string) → rejected by schema max length",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const res = await call(h, "get_stock_price", { ticker: "ABCDEFGHIJKLMNO" });
        assert(res.rejected || res.isError, "expected rejection");
        assert(Object.keys(h.mock.calls).length === 0, "handler ran (provider was called)");
        return "rejected pre-handler (max length)";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "simulated rate_limit on every attempt → isError after retries exhausted",
    run: async () => {
      const data: MockData = { throwers: { RATELIM: new ProviderError("please slow down", "rate_limit") } };
      const h = await makeHarness(data);
      try {
        const { isError, text } = await call(h, "get_stock_price", { ticker: "RATELIM" });
        assert(isError, "expected isError");
        assert(/rate limit/i.test(text), `message was: ${text}`);
        assert(h.mock.count("getQuote", "RATELIM") === 4, `attempts=${h.mock.count("getQuote", "RATELIM")}`);
        return "isError after 4 attempts (1+3 retries)";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "cache: get_stock_price AAPL twice → second is a cache hit (via stats)",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        await call(h, "get_stock_price", { ticker: "AAPL" });
        await call(h, "get_stock_price", { ticker: "AAPL" });
        assert(h.cached.stats().hits >= 1, "no cache hit recorded");
        assert(h.mock.count("getQuote", "AAPL") === 1, `provider called ${h.mock.count("getQuote", "AAPL")}x`);
        return `hits=${h.cached.stats().hits}, provider called once`;
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "single-flight: two concurrent get_stock_price AAPL → provider called exactly once",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        await Promise.all([call(h, "get_stock_price", { ticker: "AAPL" }), call(h, "get_stock_price", { ticker: "AAPL" })]);
        assert(h.mock.count("getQuote", "AAPL") === 1, `provider called ${h.mock.count("getQuote", "AAPL")}x`);
        return "coalesced to 1 fetch";
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "bad_ticker is never retried → provider called exactly once",
    run: async () => {
      const h = await makeHarness(defaultData);
      try {
        const { isError } = await call(h, "get_stock_price", { ticker: "FAKEXYZ" });
        assert(isError, "expected isError");
        assert(h.mock.count("getQuote", "FAKEXYZ") === 1, `called ${h.mock.count("getQuote", "FAKEXYZ")}x`);
        return "1 attempt (no retry)";
      } finally {
        await h.close();
      }
    },
  },
];

/* ------------------------------- live cases ------------------------------- */

/** A small set of read-only spot-checks against the real API (opt-in via --live). */
function makeLiveHarness(): Promise<Harness> {
  const realProvider: FinanceProvider = new CachingFinanceProvider(new ResilientProvider(new AlphaVantageProvider()));
  return (async () => {
    const server = createServer(realProvider);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "eval-harness-live", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // No mock in live mode; expose a stub so the shared helpers stay happy.
    return { mock: new MockFinanceProvider(), cached: realProvider as CachingFinanceProvider, client, close: async () => {
      await client.close();
      await server.close();
    } };
  })();
}

const liveCases: Case[] = [
  {
    desc: "[live] get_stock_price AAPL → price>0, ticker=AAPL",
    run: async () => {
      const h = await makeLiveHarness();
      try {
        const { isError, data, text } = await call(h, "get_stock_price", { ticker: "AAPL" });
        assert(!isError, `error: ${text}`);
        assert(data.ticker === "AAPL" && data.price > 0, JSON.stringify(data));
        return `price=${data.price}`;
      } finally {
        await h.close();
      }
    },
  },
  {
    desc: "[live] get_company_overview IBM → marketCap>0, sector present",
    run: async () => {
      const h = await makeLiveHarness();
      try {
        const { isError, data, text } = await call(h, "get_company_overview", { ticker: "IBM" });
        assert(!isError, `error: ${text}`);
        assert(data.marketCap > 0 && typeof data.sector === "string", JSON.stringify(data));
        return `${data.name}, ${data.sector}`;
      } finally {
        await h.close();
      }
    },
  },
];

/* --------------------------------- runner --------------------------------- */

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const cases = live ? liveCases : mockedCases;

  console.log(`\n  mcp-finance-server eval — ${live ? "LIVE (real API)" : "mocked"} — ${cases.length} cases\n`);

  // Silence provider/cache/retry stderr chatter so the scorecard stays readable.
  const realError = console.error;
  if (!live) console.error = () => {};

  const results: Scored[] = [];
  for (const c of cases) {
    try {
      const detail = await c.run();
      results.push({ desc: c.desc, pass: true, detail });
    } catch (err) {
      results.push({ desc: c.desc, pass: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  console.error = realError;

  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.desc}`);
    console.log(`         └─ ${r.detail}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n  ── scorecard ──`);
  console.log(`  total:  ${results.length}`);
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
