#!/usr/bin/env python
"""Phase 5 — a tool-SELECTION eval for the agent (distinct from the server eval).

The TypeScript `bun run eval` checks the *server's* reliability (do the tools
return correct data?). THIS eval checks the *agent's* behavior: given a natural-
language question, does it pick the right tool and produce a non-empty answer?

Two modes (mirrors the server eval's MockFinanceProvider pattern):

  • mocked (default) — a deterministic FakeToolModel (keyword tool-choice) + stub
    tools. No network, no Groq quota. Tests the GRAPH WIRING + this harness.
    Should be a clean sweep every run.

  • --live          — the real Groq model + real MCP tools. Tests the ACTUAL
    model's tool selection. Uses quota, so we pace cases under the 30 rpm limit.

Every run also writes a JSONL trace to agent/traces/ (Phase 5's tracing feature),
so you can inspect each step's reasoning / tool calls / latency afterward.

    python eval_agent.py            # mocked
    python eval_agent.py --live      # real Groq + real server (needs GROQ_API_KEY)
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import re
import sys
from dataclasses import dataclass

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool

from agent import build_graph, make_model
from runner import run_agent
from tracing import Tracer

# ── the eval cases: (question, the tool we expect the agent to select) ───────
CASES: list[tuple[str, str]] = [
    ("What's the current stock price of AAPL?", "get_stock_price"),
    ("Give me a company overview of MSFT.", "get_company_overview"),
    ("Show me the last 4 quarters of earnings for AAPL.", "get_earnings_report"),
    ("Compare AAPL and MSFT - which looks stronger?", "compare_stocks"),
    ("What are today's top gainers and losers?", "get_top_gainers_losers"),
    ("Screen AAPL and MSFT for stocks with a P/E under 30.", "screen_stocks"),
    ("What's the current stock price of TSLA?", "get_stock_price"),
]

# Pace between live cases to stay under Groq's free-tier 30 req/min.
LIVE_INTER_CASE_DELAY = 3.0


# ─────────────────────────── mocked-mode fixtures ───────────────────────────
# These stand in for the LLM and the MCP tools so the default run is offline.

def _extract_tickers(question: str) -> list[str]:
    """Pull ticker-like tokens (2-5 uppercase letters) from the question."""
    found = re.findall(r"\b[A-Z]{2,5}\b", question)
    return found or ["AAPL"]


class FakeToolModel:
    """A deterministic stand-in for ChatGroq used in mocked mode.

    On the first turn it selects a tool by keyword (a crude stub of an LLM's
    tool choice); once tool results are in the history it returns a canned
    synthesis. Implements just enough of the chat-model surface the graph uses:
    `bind_tools()` and `ainvoke()`.
    """

    def __init__(self) -> None:
        self._tools: list[BaseTool] = []

    def bind_tools(self, tools, **_kwargs):
        self._tools = tools
        return self

    async def ainvoke(self, messages):
        # If any tool result is already present, we're on the synthesis turn.
        if any(isinstance(m, ToolMessage) for m in messages):
            return AIMessage(content="Based on the tool results, here is a concise synthesized answer.")

        question = next((m.content for m in messages if isinstance(m, HumanMessage)), "")
        name, args = self._select(question)
        return AIMessage(
            content="",
            tool_calls=[{"name": name, "args": args, "id": "call_1", "type": "tool_call"}],
        )

    @staticmethod
    def _select(question: str) -> tuple[str, dict]:
        q = question.lower()
        tickers = _extract_tickers(question)
        if "gainer" in q or "loser" in q or "movers" in q:
            return "get_top_gainers_losers", {}
        if "compare" in q:
            return "compare_stocks", {"tickers": tickers}
        if "screen" in q or "filter" in q:
            return "screen_stocks", {"tickers": tickers}
        if "earning" in q:
            return "get_earnings_report", {"ticker": tickers[0]}
        if any(k in q for k in ("overview", "sector", "market cap", "fundamental", "p/e", "pe ratio")):
            return "get_company_overview", {"ticker": tickers[0]}
        return "get_stock_price", {"ticker": tickers[0]}


def _build_stub_tools() -> list[BaseTool]:
    """Stub LangChain tools with the same names/args as the real MCP tools."""

    def get_stock_price(ticker: str) -> str:
        return json.dumps({"ticker": ticker, "price": 275.15, "changePercent": "-1.2%"})

    def get_company_overview(ticker: str) -> str:
        return json.dumps({"ticker": ticker, "sector": "TECHNOLOGY", "marketCap": 3_000_000_000_000, "peRatio": 28.0})

    def get_earnings_report(ticker: str, quarters: int = 4) -> str:
        return json.dumps({"ticker": ticker, "quarters": [{"reportedEPS": 2.1, "estimatedEPS": 2.0, "beat": True}]})

    def compare_stocks(tickers: list[str]) -> str:
        return json.dumps({"requested": len(tickers), "compared": len(tickers), "failed": 0, "comparison": []})

    def get_top_gainers_losers() -> str:
        return json.dumps({"topGainers": [{"ticker": "GAIN"}], "topLosers": [{"ticker": "LOSE"}]})

    def screen_stocks(tickers: list[str], maxPe: float | None = None) -> str:
        return json.dumps({"evaluated": len(tickers), "matched": 1, "didNotMatch": 1, "failed": 0, "results": []})

    funcs = [get_stock_price, get_company_overview, get_earnings_report,
             compare_stocks, get_top_gainers_losers, screen_stocks]
    return [StructuredTool.from_function(func=f, name=f.__name__, description=f.__name__) for f in funcs]


# ────────────────────────────── the harness ─────────────────────────────────
@dataclass
class Scored:
    desc: str
    passed: bool
    detail: str


def _score(question: str, expected_tool: str, result) -> Scored:
    """A case passes iff the expected tool was called AND a non-empty answer came back."""
    called = result.tool_names
    tool_ok = expected_tool in called
    answer_ok = bool(result.final_answer and result.final_answer.strip())
    passed = tool_ok and answer_ok
    if passed:
        detail = f"called {called}; answer {len(result.final_answer)} chars"
    else:
        reasons = []
        if not tool_ok:
            reasons.append(f"expected {expected_tool}, got {called or '[]'}")
        if not answer_ok:
            reasons.append("empty final answer")
        detail = "; ".join(reasons)
    return Scored(desc=f"{question}  ->  {expected_tool}", passed=passed, detail=detail)


async def _run_cases(graph, tracer: Tracer, *, delay: float) -> list[Scored]:
    scored: list[Scored] = []
    for i, (question, expected) in enumerate(CASES, 1):
        tracer.event(event="case_start", index=i, question=question, expected=expected)
        try:
            result = await run_agent(graph, question, tracer=tracer)
            scored.append(_score(question, expected, result))
        except Exception as err:  # noqa: BLE001 — one bad case must not sink the suite
            # e.g. the model emits an invalid tool call and the provider 400s.
            # Capture it as a failed case (mirrors the server eval's per-item
            # failure capture) and keep going.
            reason = str(err).replace("\n", " ")
            if len(reason) > 160:
                reason = reason[:160] + " ..."
            tracer.event(event="case_error", index=i, error=f"{type(err).__name__}: {reason}")
            scored.append(
                Scored(desc=f"{question}  ->  {expected}", passed=False,
                       detail=f"errored: {type(err).__name__}: {reason}")
            )
        if delay and i < len(CASES):
            await asyncio.sleep(delay)  # pace live runs under the rate limit
    return scored


async def run_mocked(tracer: Tracer) -> list[Scored]:
    graph = build_graph(_build_stub_tools(), model=FakeToolModel())
    return await _run_cases(graph, tracer, delay=0.0)


async def run_live(tracer: Tracer) -> list[Scored]:
    # Imported here so mocked mode needs no MCP/Groq setup at all.
    from langchain_mcp_adapters.tools import load_mcp_tools
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client

    from mcp_config import server_params

    async with stdio_client(server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)
            graph = build_graph(tools, model=make_model())
            return await _run_cases(graph, tracer, delay=LIVE_INTER_CASE_DELAY)


async def main() -> None:
    live = "--live" in sys.argv
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    trace_path = f"traces/eval-{'live' if live else 'mock'}-{stamp}.jsonl"

    mode = "LIVE (real Groq + real server)" if live else "mocked (offline)"
    print(f"\n  agent tool-selection eval - {mode} - {len(CASES)} cases")
    print(f"  trace: {trace_path}\n")

    with Tracer(trace_path) as tracer:
        tracer.event(event="run_start", mode=("live" if live else "mock"), cases=len(CASES))
        scored = await (run_live(tracer) if live else run_mocked(tracer))

    for s in scored:
        print(f"  [{'PASS' if s.passed else 'FAIL'}] {s.desc}")
        print(f"         |- {s.detail}")

    passed = sum(s.passed for s in scored)
    failed = len(scored) - passed
    print(f"\n  -- scorecard --")
    print(f"  total:  {len(scored)}")
    print(f"  passed: {passed}")
    print(f"  failed: {failed}\n")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
