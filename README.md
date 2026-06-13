# mcp-finance-server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes live financial-market data as callable tools, backed by the [Alpha Vantage](https://www.alphavantage.co/) API. Built with the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) in TypeScript, it runs over a **stdio transport** so any MCP client — such as **Claude Desktop** — can spawn it as a subprocess and call its tools.

## What it does

It gives an LLM six finance tools:

| Tool | Purpose |
|------|---------|
| `get_stock_price` | Current price, daily change %, and volume for a ticker |
| `get_company_overview` | Name, sector, market cap, P/E ratio, 52-week high/low |
| `get_earnings_report` | Last N quarters of EPS — reported (actual) vs. estimated |
| `compare_stocks` | Side-by-side key metrics for 2–5 tickers |
| `get_top_gainers_losers` | Top 5 gainers and top 5 losers for the latest session |
| `screen_stocks` | Filter a candidate ticker list by sector, P/E range, and min market cap |

Every tool has a strict **JSON Schema** for its inputs (generated from Zod), and every tool degrades gracefully — bad tickers, hit rate limits, and network failures all return a clean error result instead of crashing the server.

## Setup

This project uses [**Bun**](https://bun.sh) as the runtime and package manager.

```bash
# 1. install dependencies
bun install

# 2. (optional) typecheck
bun run typecheck

# 3. run the server (it speaks MCP over stdio, so it waits for a client)
bun run start
```

### API key

The server reads its Alpha Vantage key from the `ALPHAVANTAGE_API_KEY` environment variable. **It is required** — the server validates it at startup and, if the key is missing or the `demo` placeholder, prints an error to stderr and exits with code 1 rather than running in a broken state. (The `demo` key only serves a handful of sample symbols and silently turns every real request into a confusing rate-limit error, so it is never used as a fallback.)

> ⚠️ **You must set a real key.** Get a free one at <https://www.alphavantage.co/support/#api-key> and set it:
>
> ```bash
> # macOS / Linux
> export ALPHAVANTAGE_API_KEY=YOUR_REAL_KEY
> # Windows PowerShell
> $env:ALPHAVANTAGE_API_KEY = "YOUR_REAL_KEY"
> ```
>
> The free tier allows ~25 requests/day. `compare_stocks` and `screen_stocks` make one request per ticker, so use them sparingly on the free plan.

## Connecting to Claude Desktop

Add the server to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "finance": {
      "command": "bun",
      "args": ["run", "C:\\path\\to\\fin-mcp\\src\\index.ts"],
      "env": {
        "ALPHAVANTAGE_API_KEY": "YOUR_REAL_KEY"
      }
    }
  }
}
```

Use the absolute path to `src/index.ts` on your machine (forward slashes are fine on macOS/Linux). Restart Claude Desktop; the six tools then appear under the 🔌 tools menu.

## MCP architecture (in one paragraph)

MCP is a JSON-RPC 2.0 protocol that connects an MCP **client** (here, Claude Desktop) to an MCP **server** (this process) over a **transport** — we use **stdio**, where the client launches the server as a subprocess and exchanges newline-delimited JSON-RPC messages over the server's stdin/stdout (so stdout is reserved for the protocol and all logging must go to stderr). The session opens with a **handshake**: the client sends an `initialize` request advertising its protocol version and capabilities, the server replies with its own info and capabilities, and the client confirms with an `initialized` notification. Once initialized, the client calls `tools/list` to discover the server's tools — each tool ships a name, description, and a **JSON Schema** (its `inputSchema`) that tells the model exactly what arguments are valid — and then issues `tools/call` requests, which the server routes to the matching handler, validates against that schema, executes (fetching data through the provider stack below), and returns as a structured result (or an `isError` result on failure).

## Internal architecture (data layer)

Tool handlers never touch HTTP directly. They depend only on a `FinanceProvider` interface, and a request flows down through layered, single-responsibility modules — each in its own file:

```
                ┌──────────────────────────────────────────────┐
  tools/call →  │  MCP tools (src/index.ts)                     │   validate args (JSON Schema)
                └───────────────┬──────────────────────────────┘
                                │ FinanceProvider interface (src/provider.ts)
                ┌───────────────▼──────────────────────────────┐
                │  CachingFinanceProvider (src/cache.ts)        │   TTL cache + single-flight
                │   • quote / top-movers .......... 60s          │   hit → return immediately
                │   • overview / earnings ......... 6h           │   miss ↓
                └───────────────┬──────────────────────────────┘
                ┌───────────────▼──────────────────────────────┐
                │  ResilientProvider (src/limiter.ts)           │   throttle + resilience
                │    • ConcurrencyLimiter (≤2 in flight)         │   caps fan-out concurrency
                │    • withRetry (1s/2s/4s backoff)              │   retries rate_limit / network
                │                                                │   never retries bad_ticker
                └───────────────┬──────────────────────────────┘
                ┌───────────────▼──────────────────────────────┐
                │  AlphaVantageProvider (src/alphavantage.ts)   │   pure fetch() + parse
                └───────────────┬──────────────────────────────┘
                                ▼
                         Alpha Vantage HTTP API
```

Layer by layer: the **cache** (`src/cache.ts`) serves fresh results from memory keyed by `function:ticker` with per-data-type TTLs, coalesces concurrent identical misses into one fetch (single-flight), and logs hit/miss/wait counts to stderr. On a miss it calls the **resilient decorator** (`src/limiter.ts`), which runs every call through a **concurrency limiter** (max 2 in flight — so a multi-ticker fan-out can't trip Alpha Vantage's ~1-request-per-second free-tier limit) wrapped around **retry-with-backoff** (1s → 2s → 4s, but only for transient `rate_limit`/`network` errors — a `bad_ticker` is never retried). At the bottom, **`AlphaVantageProvider`** is a pure fetch + parse layer. Each layer is a `FinanceProvider` that wraps another, so the resilience and caching are provider-agnostic: swapping in a second data source means writing one new `FinanceProvider` implementation — nothing above it changes. (This is also what lets the eval harness inject a `MockFinanceProvider` at the bottom and exercise the real cache/retry/limiter and tool handlers offline.)

## Tools reference

All examples show the `arguments` object you'd pass to `tools/call`, and an abbreviated result. (Result text is JSON inside an MCP text content block.)

### 1. `get_stock_price`

**Input**
```json
{ "ticker": "IBM" }
```
**Output**
```json
{
  "ticker": "IBM",
  "price": 274.85,
  "change": 2.49,
  "changePercent": "0.9142%",
  "volume": 6912174,
  "previousClose": 272.36,
  "latestTradingDay": "2026-06-11"
}
```

### 2. `get_company_overview`

**Input**
```json
{ "ticker": "AAPL" }
```
**Output**
```json
{
  "ticker": "AAPL",
  "name": "Apple Inc",
  "sector": "TECHNOLOGY",
  "industry": "ELECTRONIC COMPUTERS",
  "marketCap": 3000000000000,
  "marketCapFormatted": "$3.00T",
  "peRatio": 29.4,
  "eps": 6.42,
  "dividendYield": 0.0044,
  "week52High": 260.1,
  "week52Low": 164.08
}
```

### 3. `get_earnings_report`

**Input**
```json
{ "ticker": "AAPL", "quarters": 4 }
```
`quarters` is optional (default `4`, range 1–8).

**Output**
```json
{
  "ticker": "AAPL",
  "quarters": [
    {
      "fiscalDateEnding": "2026-03-31",
      "reportedDate": "2026-05-01",
      "reportedEPS": 1.65,
      "estimatedEPS": 1.60,
      "surprise": 0.05,
      "surprisePercentage": 3.125,
      "beat": true
    }
  ]
}
```

### 4. `compare_stocks`

**Input**
```json
{ "tickers": ["AAPL", "MSFT", "GOOGL"] }
```
Accepts 2–5 tickers.

**Output** — successfully compared tickers go in `comparison`; any that couldn't be fetched go in `failures` with a reason, and the counts (`requested` / `compared` / `failed`) always reconcile, so a partial result is never mistaken for a complete one.
```json
{
  "requested": 3,
  "compared": 2,
  "failed": 1,
  "comparison": [
    {
      "ticker": "AAPL",
      "price": 258.1,
      "changePercent": "0.91%",
      "volume": 41234567,
      "name": "Apple Inc",
      "sector": "TECHNOLOGY",
      "marketCap": 3000000000000,
      "marketCapFormatted": "$3.00T",
      "peRatio": 29.4,
      "week52High": 260.1,
      "week52Low": 164.08
    }
  ],
  "failures": [
    { "ticker": "GOOGL", "reason": "Network error: ..." }
  ]
}
```

### 5. `get_top_gainers_losers`

**Input**
```json
{}
```
**Output**
```json
{
  "lastUpdated": "2026-06-11 16:15:59 US/Eastern",
  "topGainers": [
    { "ticker": "XYZ", "price": 12.5, "changeAmount": 4.1, "changePercentage": "48.8%", "volume": 9123456 }
  ],
  "topLosers": [
    { "ticker": "ABC", "price": 3.2, "changeAmount": -2.4, "changePercentage": "-42.8%", "volume": 5123456 }
  ]
}
```

### 6. `screen_stocks`

> **Note:** Alpha Vantage's free tier has no native stock-screener endpoint. This tool therefore screens a **candidate universe you provide** via `tickers`: it fetches each company's overview and filters against your criteria.

**Input**
```json
{
  "tickers": ["AAPL", "MSFT", "JPM", "XOM"],
  "sector": "TECHNOLOGY",
  "minPe": 10,
  "maxPe": 40,
  "minMarketCap": 1000000000000
}
```
All filters except `tickers` are optional.

**Output** — every candidate lands in exactly one of three buckets: `results` (matched all criteria), `rejected` (fetched fine but failed one or more criteria — each listed in `failedCriteria` with expected vs. actual), or `failures` (couldn't be fetched). The counts always satisfy `evaluated === matched + didNotMatch + failed`, so a failed fetch is never silently mistaken for a non-match.
```json
{
  "criteria": { "sector": "TECHNOLOGY", "minPe": 10, "maxPe": 40, "minMarketCap": 1000000000000 },
  "evaluated": 4,
  "matched": 1,
  "didNotMatch": 1,
  "failed": 2,
  "results": [
    { "ticker": "AAPL", "name": "Apple Inc", "sector": "TECHNOLOGY", "marketCap": 3000000000000, "marketCapFormatted": "$3.00T", "peRatio": 29.4 }
  ],
  "rejected": [
    {
      "ticker": "XOM", "name": "Exxon Mobil Corp", "sector": "ENERGY",
      "marketCap": 500000000000, "marketCapFormatted": "$500.00B", "peRatio": 12.1,
      "failedCriteria": [
        { "criterion": "sector", "expected": "TECHNOLOGY", "actual": "ENERGY" }
      ]
    }
  ],
  "failures": [
    { "ticker": "MSFT", "reason": "Alpha Vantage rate limit reached: ..." }
  ]
}
```

## Error handling

Errors are returned as MCP results with `isError: true` and a human-readable message, categorized as:

- **Invalid ticker / no data** — the symbol doesn't exist or has no data for that endpoint.
- **Alpha Vantage rate limit reached** — daily (25/day) or per-second cap hit. `compare_stocks` / `screen_stocks` fan out one request per ticker, so a large batch can trip the free tier's 1-request-per-second limit; the affected tickers appear in that tool's `failures` list with this reason.
- **Network error** — request failed or timed out (15s timeout).
- **Unexpected response** — anything else (e.g. non-JSON body).

Invalid arguments (wrong type, out-of-range, malformed ticker) are rejected by JSON Schema validation before the handler runs.

## Testing & Evals

Everything is mocked — **tests and evals never hit the live API** (the free tier is 25 requests/day, so real calls would be flaky and burn quota).

```bash
bun test          # unit tests (mock global.fetch / pure logic)
bun run eval       # eval harness — 18 cases through the real tool handlers (mocked provider)
bun run eval:live  # OPTIONAL: a few real Alpha Vantage spot-checks (needs a real key; uses quota)
bun run typecheck  # tsc --noEmit
```

**Unit tests** (`src/*.test.ts`, run by `bun test`) cover pure logic with mocks:

- `num()` parsing — numeric strings, and Alpha Vantage's `"None"` / `"-"` / `""` / `null` sentinels → `null`, plus a NaN guard.
- **Error classification** — `global.fetch` is mocked to return each failure shape (`"Error Message"` → `bad_ticker`, `"Note"`/rate-limit `"Information"` → `rate_limit`, non-OK HTTP → `network`, non-JSON → `unexpected`, empty `Global Quote` → `bad_ticker`, fetch throw → `network`).
- **Screening criteria** (`checkCriteria`) — matches, and per-criterion failures (sector / P/E range / market cap) with expected-vs-actual.
- **Cache** (`TtlCache`) — hit within TTL (fetcher not re-run), miss after expiry, and single-flight (concurrent identical keys → one fetch).
- **Limiter + retry** — `ConcurrencyLimiter(2)` never exceeds 2 in flight; `withRetry` retries `rate_limit`, refuses to retry `bad_ticker`, and gives up after exhausting attempts.

**Eval harness** (`eval/run.ts`, run by `bun run eval`) injects a `MockFinanceProvider` (implementing `FinanceProvider`) with canned fixtures, wraps it in the *real* cache + resilience layers, and drives the *real* MCP tool handlers through an in-memory client⇄server pair. It runs 18 cases — happy paths for all six tools, schema validation (`""` and a 15-char ticker rejected pre-handler; `"aapl"` → `"AAPL"`), error handling (`bad_ticker` classification, rate-limit after retries), the three-state `compare`/`screen` invariants, and cache/single-flight/no-retry-on-bad-ticker behavior — and prints a PASS/FAIL scorecard (exit code 1 if any case fails, so it can gate CI). The `--live` flag swaps in the real Alpha Vantage provider for a couple of read-only spot-checks.

## Project layout

```
fin-mcp/
├── src/
│   ├── index.ts             # MCP server; exports createServer(provider), composes the prod stack
│   ├── provider.ts           # FinanceProvider interface + data shapes + ProviderError (the abstraction)
│   ├── config.ts             # fail-fast API-key validation at startup
│   ├── cache.ts              # TTL cache + single-flight + CachingFinanceProvider decorator
│   ├── limiter.ts            # ConcurrencyLimiter + retry/backoff + ResilientProvider decorator
│   ├── alphavantage.ts       # AlphaVantageProvider: pure fetch + parse FinanceProvider
│   ├── screening.ts          # multi-ticker evaluation: three-state results & criteria checks
│   ├── alphavantage.test.ts   # unit: num() + error classification (mocked fetch)
│   ├── screening.test.ts      # unit: checkCriteria
│   ├── cache.test.ts          # unit: TTL hit/miss/expiry + single-flight
│   └── limiter.test.ts        # unit: ConcurrencyLimiter + withRetry
├── eval/
│   ├── run.ts                # eval harness + scorecard (18 cases via in-memory MCP client)
│   └── fixtures.ts           # MockFinanceProvider + canned fixtures
├── package.json
├── tsconfig.json
└── README.md
```
