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

The server reads its Alpha Vantage key from the `ALPHAVANTAGE_API_KEY` environment variable and falls back to the literal `demo` key if none is set.

> ⚠️ **Replace the `demo` key before real use.** The `demo` key only returns data for a handful of symbols (e.g. `IBM`) and is heavily rate-limited. Get a free key at <https://www.alphavantage.co/support/#api-key> and set it:
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

MCP is a JSON-RPC 2.0 protocol that connects an MCP **client** (here, Claude Desktop) to an MCP **server** (this process) over a **transport** — we use **stdio**, where the client launches the server as a subprocess and exchanges newline-delimited JSON-RPC messages over the server's stdin/stdout (so stdout is reserved for the protocol and all logging must go to stderr). The session opens with a **handshake**: the client sends an `initialize` request advertising its protocol version and capabilities, the server replies with its own info and capabilities, and the client confirms with an `initialized` notification. Once initialized, the client calls `tools/list` to discover the server's tools — each tool ships a name, description, and a **JSON Schema** (its `inputSchema`) that tells the model exactly what arguments are valid — and then issues `tools/call` requests, which the server routes to the matching handler, validates against that schema, executes (fetching from Alpha Vantage), and returns as a structured result (or an `isError` result on failure).

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

**Output**
```json
{
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

**Output**
```json
{
  "criteria": { "sector": "TECHNOLOGY", "minPe": 10, "maxPe": 40, "minMarketCap": 1000000000000 },
  "evaluated": 4,
  "matched": 2,
  "results": [
    { "ticker": "AAPL", "name": "Apple Inc", "sector": "TECHNOLOGY", "marketCap": 3000000000000, "marketCapFormatted": "$3.00T", "peRatio": 29.4 }
  ]
}
```

## Error handling

Errors are returned as MCP results with `isError: true` and a human-readable message, categorized as:

- **Invalid ticker / no data** — the symbol doesn't exist or has no data for that endpoint.
- **Alpha Vantage rate limit reached** — daily/per-minute cap hit (or the `demo` key was used for an unsupported symbol).
- **Network error** — request failed or timed out (15s timeout).
- **Unexpected response** — anything else (e.g. non-JSON body).

Invalid arguments (wrong type, out-of-range, malformed ticker) are rejected by JSON Schema validation before the handler runs.

## Project layout

```
fin-mcp/
├── src/
│   ├── index.ts          # MCP server + 6 tool definitions (stdio transport)
│   └── alphavantage.ts    # typed Alpha Vantage client + error handling
├── package.json
├── tsconfig.json
└── README.md
```
