# mcp-finance-server — project guide

An MCP (Model Context Protocol) server exposing 6 financial-data tools over **stdio**, backed by the Alpha Vantage API. TypeScript, run with **Bun** (runtime + package manager). The official `@modelcontextprotocol/sdk` provides the server; Zod schemas validate tool inputs.

## Commands

```bash
bun install        # deps
bun run start       # run the stdio server (it blocks waiting for an MCP client — that's correct)
bun run dev         # same, with --watch
bun run typecheck   # tsc --noEmit
bun test            # unit tests (all mocked, no network)
bun run eval        # 18-case eval harness through real tool handlers (mocked provider) → scorecard
bun run eval:live   # OPTIONAL: ~2 real Alpha Vantage spot-checks (uses a real key + quota)
```

The Alpha Vantage key lives in `.env` as `ALPHAVANTAGE_API_KEY` (gitignored; Bun auto-loads it). Free tier ≈ **25 requests/day** — this is why tests/evals never hit the live API.

## Architecture (data layer is layered `FinanceProvider` decorators)

Tool handlers depend only on the `FinanceProvider` interface. Request flow, outermost first:

```
MCP tools (index.ts)
  → CachingFinanceProvider (cache.ts)     TTL cache + single-flight; quotes/top-movers 60s, overview/earnings 6h
    → ResilientProvider (limiter.ts)       ConcurrencyLimiter(≤2) + withRetry (1s/2s/4s, only rate_limit|network, never bad_ticker)
      → AlphaVantageProvider (alphavantage.ts)   pure fetch() + parse → throws ProviderError
        → Alpha Vantage HTTP API
```

`index.ts` exports **`createServer(provider)`** and only runs `main()` when `import.meta.main` (so tests/eval can import it without launching stdio or requiring a key). Production stack is built in `buildProvider()`.

### Modules (`src/`)
- `index.ts` — server + 6 tool registrations + Zod input schemas + the `guard()` error wrapper.
- `provider.ts` — `FinanceProvider` interface, data shapes, `ProviderError` (`kind`: bad_ticker | rate_limit | network | unexpected).
- `config.ts` — `requireApiKey()`: fail-fast at startup (exits 1 if key missing or `"demo"`).
- `cache.ts` — `TtlCache` (hit/miss/wait counts, single-flight) + `CachingFinanceProvider`.
- `limiter.ts` — `ConcurrencyLimiter`, `withRetry`, `ResilientProvider`.
- `alphavantage.ts` — `AlphaVantageProvider` + exported `num()` parser.
- `screening.ts` — `settleAll()` (per-ticker success/failure capture) + `checkCriteria()`.

## Conventions / key decisions (don't regress these)
- **stdout is the MCP transport.** All logging goes to `console.error` (stderr). Never `console.log` in the server path.
- **Fail-fast on the API key**; the `demo` key is never used as a silent fallback.
- **No silent failures in multi-ticker tools.** `compare_stocks` and `screen_stocks` return explicit per-ticker states with counts that always reconcile:
  - `screen_stocks`: `evaluated === matched + didNotMatch + failed` (results / rejected[+failedCriteria] / failures).
  - `compare_stocks`: `requested === compared + failed` (comparison / failures[{ticker,reason}]).
- **Retry only transient errors** (rate_limit, network); `bad_ticker` is never retried.
- **`getEarnings` returns all quarters**; the tool slices to the requested count (keeps cache key = `function:ticker`).
- Ticker schema: trimmed, 1–10 chars, `[A-Za-z.\-]`, uppercased via Zod transform.

## Testing (never hits the live API)
- Unit tests `src/*.test.ts`: mock `global.fetch` for provider tests; pure-logic tests otherwise.
- Eval `eval/run.ts`: injects `MockFinanceProvider` (`eval/fixtures.ts`) at the bottom of the real cache/resilience stack and drives the real tool handlers via an in-memory MCP client⇄server pair. Scorecard exits 1 on any failure (CI-gateable).

## Status
Parts A (bug fixes: fail-fast key, three-state compare/screen), B (cache + limiter/retry + provider abstraction), and C (unit tests + eval harness) are **complete and green**: typecheck clean, 30 unit tests pass, 18/18 eval cases pass, 6 tools list over stdio.
