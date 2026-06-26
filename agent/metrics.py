#!/usr/bin/env python
"""Phase A — extract the agent/server's "Tier 1" metrics into a clean report.

Runs a FIXED workload of ~10 questions with deliberately OVERLAPPING tickers and
reports five metric groups, each with a one-line note on how it was measured:

  1. Cache hit rate + total upstream API calls
  2. API-call reduction (caching on vs. off)
  3. Latency p50/p95, cached (warm) vs. uncached (cold)
  4. Average tool-calls per question
  5. Retry recovery (calls that succeeded only after a retry)

Where the numbers come from:
  • The TS server logs cache + retry events to STDERR (`[cache] ...`, `[retry] ...`).
    We capture that stream via stdio_client(errlog=...) and parse it.
  • Per-tool-call latency comes from our own timing (also written to a JSONL trace).

Two drive modes:
  • --mode direct (DEFAULT): issue the workload as direct tool calls. Deterministic,
    reproducible, and quota-light — best for the server-side metrics, which don't
    depend on who calls the tools. tool-calls/question is 1.0 by construction.
  • --mode agent: route the same questions through the real LLM agent (needs
    GROQ_API_KEY). This is the only way to measure REAL tool-calls/question
    (i.e. the model's redundant-call behavior).

  python metrics.py                 # direct, deterministic
  python metrics.py --mode agent     # through the LLM (uses Groq quota)
  python metrics.py --selftest        # verify the parsing/aggregation math offline

The workload is split cold/warm BY DESIGN: the first 5 items introduce each
ticker (cache miss → upstream), the last 5 repeat them (cache hit). That makes
the cached-vs-uncached split principled rather than a fragile correlation.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import math
import re
import sys
import time

# ── the fixed workload: (question, (tool_name, args)). First 5 cold, last 5 warm. ──
WORKLOAD: list[tuple[str, tuple[str, dict]]] = [
    # cold: first time we touch each (ticker, endpoint) → cache miss → upstream
    ("What's the current stock price of AAPL?", ("get_stock_price", {"ticker": "AAPL"})),
    ("Give me a company overview of AAPL.", ("get_company_overview", {"ticker": "AAPL"})),
    ("What's the current stock price of MSFT?", ("get_stock_price", {"ticker": "MSFT"})),
    ("Give me a company overview of MSFT.", ("get_company_overview", {"ticker": "MSFT"})),
    ("What's the current stock price of TSLA?", ("get_stock_price", {"ticker": "TSLA"})),
    # warm: repeat the SAME calls within TTL → cache hit → no upstream
    ("What is AAPL trading at right now?", ("get_stock_price", {"ticker": "AAPL"})),
    ("Remind me of AAPL's sector and P/E.", ("get_company_overview", {"ticker": "AAPL"})),
    ("And MSFT's current price?", ("get_stock_price", {"ticker": "MSFT"})),
    ("What's MSFT's market cap again?", ("get_company_overview", {"ticker": "MSFT"})),
    ("TSLA price once more?", ("get_stock_price", {"ticker": "TSLA"})),
]
COLD_COUNT = 5  # first COLD_COUNT items are cold; the rest are warm repeats


# ─────────────────────────── pure parsing/aggregation ───────────────────────
# These are deliberately side-effect-free so --selftest can verify them offline.

_CACHE_LINE = re.compile(r"\[cache\]\s+\w+.*\(hits=(\d+)\s+misses=(\d+)")
_RETRY_LINE = re.compile(r"\[retry\]\s+attempt\s+(\d+)\s+failed\s+\((\w+)\)")


def parse_cache_final(stderr_text: str) -> tuple[int, int]:
    """Return (hits, misses) from the LAST `[cache]` line (counts are cumulative)."""
    hits = misses = 0
    for m in _CACHE_LINE.finditer(stderr_text):
        hits, misses = int(m.group(1)), int(m.group(2))
    return hits, misses


def parse_retries(stderr_text: str) -> tuple[int, int]:
    """Return (total_retry_attempts, retry_sequences).

    Each `[retry]` line is one failed attempt that triggered a backoff.
    A new sequence begins at "attempt 1 failed" (a fresh call hitting trouble).
    """
    attempts = sequences = 0
    for m in _RETRY_LINE.finditer(stderr_text):
        attempts += 1
        if int(m.group(1)) == 1:
            sequences += 1
    return attempts, sequences


def percentile(values: list[float], p: float) -> float:
    """Linear-interpolation percentile (numpy-free). p in [0,100]."""
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * (p / 100.0)
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return s[int(k)]
    return s[lo] * (hi - k) + s[hi] * (k - lo)


def _is_error_result(content: str) -> str | None:
    """Classify a tool result string as an error kind, or None if it's data."""
    c = content.lower()
    if "rate limit" in c:
        return "rate_limit"
    if "network error" in c:
        return "network"
    if "invalid ticker" in c or "no data" in c:
        return "bad_ticker"
    if "unexpected" in c:
        return "unexpected"
    return None


# ───────────────────────────────── runners ──────────────────────────────────
class CallRecord:
    """One tool call's outcome: latency, cold/warm phase, and error kind (if any)."""

    __slots__ = ("phase", "latency", "error_kind")

    def __init__(self, phase: str, latency: float, error_kind: str | None):
        self.phase = phase
        self.latency = latency
        self.error_kind = error_kind


async def run_direct(stderr_path: str, trace_path: str) -> tuple[list[CallRecord], float]:
    """Issue the workload as direct tool calls; return (records, tool_calls_per_q)."""
    from langchain_mcp_adapters.tools import load_mcp_tools
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client

    from mcp_config import server_params
    from tracing import Tracer

    records: list[CallRecord] = []
    errlog = open(stderr_path, "w", encoding="utf-8")
    try:
        async with stdio_client(server_params(), errlog=errlog) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {t.name: t for t in await load_mcp_tools(session)}
                with Tracer(trace_path) as tracer:
                    tracer.event(event="run_start", mode="direct", workload=len(WORKLOAD))
                    for i, (question, (tool_name, args)) in enumerate(WORKLOAD):
                        phase = "cold" if i < COLD_COUNT else "warm"
                        t0 = time.perf_counter()
                        try:
                            content = str(await tools[tool_name].ainvoke(args))
                            err = _is_error_result(content)
                        except Exception as e:  # ToolException etc.
                            content = str(e)
                            err = _is_error_result(content) or "unexpected"
                        latency = time.perf_counter() - t0
                        records.append(CallRecord(phase, latency, err))
                        tracer.log_step(node="tool", latency_s=latency, phase=phase,
                                        tool=tool_name, args=args, error_kind=err)
    finally:
        errlog.close()
    # Direct mode issues exactly one tool call per question by construction.
    return records, 1.0


async def run_agent(stderr_path: str, trace_path: str) -> tuple[list[CallRecord], float]:
    """Route the workload through the real LLM agent; measure real tool-calls/question."""
    from langchain_mcp_adapters.tools import load_mcp_tools
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client

    from agent import _is_rate_limit, build_graph
    from mcp_config import server_params
    from runner import run_agent as drive
    from tracing import Tracer

    records: list[CallRecord] = []
    total_tool_calls = 0
    attempted = 0
    errlog = open(stderr_path, "w", encoding="utf-8")
    try:
        async with stdio_client(server_params(), errlog=errlog) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await load_mcp_tools(session)
                graph = build_graph(tools)
                with Tracer(trace_path) as tracer:
                    tracer.event(event="run_start", mode="agent", workload=len(WORKLOAD))
                    for i, (question, _spec) in enumerate(WORKLOAD):
                        phase = "cold" if i < COLD_COUNT else "warm"
                        t0 = time.perf_counter()
                        # Catch the rate limit INSIDE the session body so it doesn't
                        # escape as an anyio ExceptionGroup. If Groq is exhausted,
                        # stop early and report whatever we collected (partial).
                        try:
                            result = await drive(graph, question, tracer=tracer)
                        except Exception as err:  # noqa: BLE001
                            if _is_rate_limit(err):
                                print(f"\n  ! Groq rate/token limit reached after {attempted}/"
                                      f"{len(WORKLOAD)} questions — stopping early, reporting partial.")
                                tracer.event(event="stopped", reason="rate_limit", attempted=attempted)
                                break
                            raise
                        latency = time.perf_counter() - t0
                        attempted += 1
                        total_tool_calls += len(result.tool_calls)
                        # Latency here is whole-question (incl. LLM); phase still applies
                        # to the underlying tool fetches (warm repeats hit the cache).
                        records.append(CallRecord(phase, latency, None))
    finally:
        errlog.close()
    per_q = total_tool_calls / attempted if attempted else 0.0
    return records, per_q


# ─────────────────────────────── the report ─────────────────────────────────
def build_report(mode: str, records: list["CallRecord"], tool_calls_per_q: float,
                 stderr_text: str) -> str:
    hits, misses = parse_cache_final(stderr_text)
    total_req = hits + misses
    retry_attempts, retry_sequences = parse_retries(stderr_text)

    # Retry recovery: of the sequences that hit a transient failure, how many
    # ultimately succeeded? Exhausted ones surface as retryable error results.
    retryable_errors = sum(1 for r in records if r.error_kind in ("rate_limit", "network"))
    recovered = max(retry_sequences - retryable_errors, 0)

    cold = [r.latency for r in records if r.phase == "cold"]
    warm = [r.latency for r in records if r.phase == "warm"]

    hit_rate = (hits / total_req * 100) if total_req else 0.0
    reduction = (hits / total_req * 100) if total_req else 0.0

    L = []
    L.append("")
    L.append("=" * 70)
    L.append(f"  AGENT METRICS REPORT  (mode={mode}, workload={len(records)} questions)")
    L.append("=" * 70)

    L.append("\n1. CACHE")
    L.append(f"   hit rate ............. {hit_rate:5.1f}%   (hits={hits}, misses={misses})")
    L.append(f"   upstream API calls ... {misses}")
    L.append("   note: from the server's final `[cache]` stderr line; upstream = misses.")

    L.append("\n2. API-CALL REDUCTION (caching on vs. off)")
    L.append(f"   with caching ON  ..... {misses} upstream calls")
    L.append(f"   with caching OFF ..... {total_req} upstream calls")
    L.append(f"   reduction ............ {reduction:5.1f}%")
    L.append("   note: ON = cache misses (measured); OFF = total requests (derived: with")
    L.append("         no cache every request hits upstream) — avoids a 2nd quota-burning run.")

    L.append("\n3. LATENCY  (per tool call, p50/p95)")
    L.append(f"   cold/uncached ........ p50={percentile(cold,50)*1000:6.1f}ms  p95={percentile(cold,95)*1000:6.1f}ms  (n={len(cold)})")
    L.append(f"   warm/cached .......... p50={percentile(warm,50)*1000:6.1f}ms  p95={percentile(warm,95)*1000:6.1f}ms  (n={len(warm)})")
    L.append("   note: wall-clock per call; cold=first touch (miss->upstream), warm=repeat (hit).")

    L.append("\n4. TOOL CALLS PER QUESTION")
    L.append(f"   average .............. {tool_calls_per_q:.2f}")
    if mode == "direct":
        L.append("   note: 1.00 by construction (direct mode). Run --mode agent for real LLM behavior.")
    else:
        L.append("   note: real count from the LLM agent (>1.0 reveals redundant/duplicate calls).")

    L.append("\n5. RETRY RECOVERY")
    L.append(f"   retry attempts ....... {retry_attempts}   (each = one transient failure + backoff)")
    L.append(f"   retry sequences ...... {retry_sequences}   (distinct calls that hit trouble)")
    L.append(f"   recovered after retry  {recovered}   (sequences not ending in a surfaced error)")
    L.append("   note: parsed from `[retry]` stderr lines; recovered = sequences - retryable errors.")
    L.append("=" * 70 + "\n")
    return "\n".join(L)


# ───────────────────────────────── selftest ─────────────────────────────────
def _selftest() -> int:
    """Verify the pure parsers/aggregators on synthetic fixtures (no network)."""
    sample = "\n".join([
        "mcp-finance-server running on stdio",
        "[cache] MISS getQuote:AAPL (hits=0 misses=1 rate=0%)",
        "[cache] MISS getOverview:AAPL (hits=0 misses=2 rate=0%)",
        "[retry] attempt 1 failed (rate_limit); retrying in 1000ms (2 left)",
        "[retry] attempt 2 failed (rate_limit); retrying in 2000ms (1 left)",
        "[cache] HIT getQuote:AAPL (hits=1 misses=2 rate=33%)",
        "[cache] HIT getOverview:AAPL (hits=2 misses=2 rate=50%)",
    ])
    hits, misses = parse_cache_final(sample)
    attempts, sequences = parse_retries(sample)
    assert (hits, misses) == (2, 2), (hits, misses)
    assert (attempts, sequences) == (2, 1), (attempts, sequences)
    assert percentile([10, 20, 30, 40], 50) == 25.0, percentile([10, 20, 30, 40], 50)
    assert percentile([10, 20, 30, 40], 95) == 38.5, percentile([10, 20, 30, 40], 95)
    assert percentile([], 50) == 0.0
    assert _is_error_result("Alpha Vantage rate limit reached: ...") == "rate_limit"
    assert _is_error_result('{"ticker":"AAPL","price":275}') is None
    print("selftest OK - parsers and aggregators verified on synthetic fixtures.")
    return 0


# ─────────────────────────────────── main ───────────────────────────────────
async def _amain(mode: str) -> None:
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    stderr_path = f"traces/metrics-stderr-{mode}-{stamp}.log"
    trace_path = f"traces/metrics-{mode}-{stamp}.jsonl"

    print(f"\nRunning {len(WORKLOAD)}-question workload (mode={mode}) ...")
    runner = run_agent if mode == "agent" else run_direct
    records, per_q = await runner(stderr_path, trace_path)

    if not records:
        # Happens when agent mode can't complete a single question (e.g. Groq's
        # daily token limit is exhausted). Be clear instead of printing zeros.
        print("\n  No data collected — the LLM could not complete any question")
        print("  (most likely Groq's daily token limit). Options:")
        print("    • wait for the Groq quota window to reset, then retry, or")
        print("    • run `python metrics.py` (direct mode) — it needs no Groq quota.\n")
        return

    with open(stderr_path, "r", encoding="utf-8") as f:
        stderr_text = f.read()

    print(build_report(mode, records, per_q, stderr_text))
    print(f"  (server stderr: {stderr_path})")
    print(f"  (jsonl trace:   {trace_path})\n")


def main() -> None:
    # Windows consoles default to cp1252 and crash on non-ASCII output; force UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    mode = "agent" if "--mode" in sys.argv and "agent" in sys.argv else "direct"
    asyncio.run(_amain(mode))


if __name__ == "__main__":
    main()
