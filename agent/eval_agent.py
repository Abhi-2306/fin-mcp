#!/usr/bin/env python
"""Agent tool-SELECTION eval / benchmark (distinct from the server's data eval).

The TypeScript `bun run eval` checks the *server's* reliability (do the tools
return correct data?). THIS eval checks the *agent's* behavior: given a natural-
language question, does it pick the right tool(s) and produce a non-empty answer?

Phase B grew this from 7 cases to ~40 across all 6 tools + multi-tool + ambiguous
cases, which is what makes a "tool-selection accuracy %" defensible.

Each case (see EvalCase) carries:
  • question        — the natural-language prompt
  • expected        — the acceptable tool(s) for it (a SET)
  • match           — "any" (accuracy: did it pick an acceptable tool?) or
                       "all" (multi-tool: did it pick every required tool?)
  • answer_keywords — optional substrings asserted on the answer (LIVE only,
                       since the mock model returns a canned answer)

Two modes (mirrors the server eval's MockFinanceProvider pattern):
  • mocked (default) — a deterministic FakeToolModel (keyword tool-choice) + stub
    tools. No network, no Groq quota. Verifies the harness + graph wiring scale to
    the full case set; should be a clean sweep.
  • --live           — the real Groq model + real MCP tools = the actual
    tool-selection benchmark. Uses quota, so cases are paced under 30 rpm.

Every run writes a JSONL trace to agent/traces/.

    python eval_agent.py            # mocked
    python eval_agent.py --live      # real Groq + real server (needs GROQ_API_KEY)
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import re
import sys
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool

from agent import build_graph, make_model
from runner import run_agent
from tracing import Tracer
from weave_setup import attributes, init_weave, log_summary, weave_requested

# Tool name constants (keep typos out of the case table).
PRICE = "get_stock_price"
OVERVIEW = "get_company_overview"
EARNINGS = "get_earnings_report"
COMPARE = "compare_stocks"
MOVERS = "get_top_gainers_losers"
SCREEN = "screen_stocks"

# Pace between live cases to stay under Groq's free-tier 30 req/min.
LIVE_INTER_CASE_DELAY = 3.0


@dataclass
class EvalCase:
    question: str
    expected: set[str]
    match: str = "any"          # "any" = ≥1 expected tool called; "all" = all called
    category: str = ""
    answer_keywords: list[str] = field(default_factory=list)  # checked LIVE only


# ── the benchmark: ~40 cases across all six tools + multi-tool + ambiguous ───
CASES: list[EvalCase] = [
    # get_stock_price (6)
    EvalCase("What's the current stock price of AAPL?", {PRICE}, category="price"),
    EvalCase("How much is TSLA trading at right now?", {PRICE}, category="price"),
    EvalCase("Give me NVDA's latest price and daily change.", {PRICE}, category="price"),
    EvalCase("What's the share price of AMZN today?", {PRICE}, category="price"),
    EvalCase("Quote me GOOGL.", {PRICE}, category="price"),
    EvalCase("How much is one share of MSFT worth?", {PRICE}, category="price"),

    # get_company_overview (6)
    EvalCase("Give me a company overview of MSFT.", {OVERVIEW}, category="overview"),
    EvalCase("What sector is AAPL in?", {OVERVIEW}, category="overview"),
    EvalCase("What's NVDA's market cap and P/E ratio?", {OVERVIEW}, category="overview"),
    EvalCase("Tell me about Apple's fundamentals.", {OVERVIEW}, category="overview"),
    EvalCase("What's the 52-week high and low for TSLA?", {OVERVIEW}, category="overview"),
    EvalCase("Company profile for AMZN, please.", {OVERVIEW}, category="overview"),

    # get_earnings_report (6)
    EvalCase("Show me AAPL's last 4 quarters of earnings.", {EARNINGS}, category="earnings"),
    EvalCase("Did MSFT beat earnings estimates recently?", {EARNINGS}, category="earnings"),
    EvalCase("What was NVDA's reported EPS last quarter?", {EARNINGS}, category="earnings"),
    EvalCase("Give me the earnings history for TSLA.", {EARNINGS}, category="earnings"),
    EvalCase("How did GOOGL's actual EPS compare to estimates?", {EARNINGS}, category="earnings"),
    EvalCase("Earnings report for AMZN.", {EARNINGS}, category="earnings"),

    # compare_stocks (6)
    EvalCase("Compare AAPL and MSFT.", {COMPARE}, category="compare"),
    EvalCase("Which is stronger, NVDA or AMD?", {COMPARE}, category="compare"),
    EvalCase("AAPL vs GOOGL vs MSFT - compare them.", {COMPARE}, category="compare"),
    EvalCase("Put TSLA and RIVN side by side.", {COMPARE}, category="compare"),
    EvalCase("Compare the market caps of AMZN and MSFT.", {COMPARE}, category="compare"),
    EvalCase("How do AAPL and NVDA stack up against each other?", {COMPARE}, category="compare"),

    # get_top_gainers_losers (5)
    EvalCase("What are today's top gainers and losers?", {MOVERS}, category="movers"),
    EvalCase("Show me the biggest movers in the market today.", {MOVERS}, category="movers"),
    EvalCase("Which stocks are up the most today?", {MOVERS}, category="movers"),
    EvalCase("Top losers right now?", {MOVERS}, category="movers"),
    EvalCase("What's moving in the market today?", {MOVERS}, category="movers"),

    # screen_stocks (5)
    EvalCase("Screen AAPL, MSFT, NVDA for P/E under 30.", {SCREEN}, category="screen"),
    EvalCase("Filter these tickers for me: AAPL, XOM, MSFT.", {SCREEN}, category="screen"),
    EvalCase("From AAPL, GOOGL, AMZN, which have a market cap over 1 trillion?", {SCREEN}, category="screen"),
    EvalCase("Screen TSLA and NVDA for P/E between 20 and 40.", {SCREEN}, category="screen"),
    EvalCase("Which of AAPL, MSFT, JPM are in the Technology sector?", {SCREEN}, category="screen"),

    # multi-tool (4) — require ALL listed tools
    EvalCase("What's AAPL's price and its latest earnings?", {PRICE, EARNINGS}, match="all", category="multi"),
    EvalCase("Give me MSFT's overview and how it compares to AAPL.", {OVERVIEW, COMPARE}, match="all", category="multi"),
    EvalCase("Show me NVDA's price and its company overview.", {PRICE, OVERVIEW}, match="all", category="multi"),
    EvalCase("Compare AAPL and MSFT, and show me today's top movers.", {COMPARE, MOVERS}, match="all", category="multi"),

    # ambiguous / edge (4) — ANY reasonable data tool is acceptable
    EvalCase("How is Apple doing?", {PRICE, OVERVIEW, EARNINGS}, category="ambiguous"),
    EvalCase("Tell me everything about TSLA.", {OVERVIEW, PRICE, EARNINGS}, category="ambiguous"),
    EvalCase("Is NVDA a good buy?", {OVERVIEW, PRICE, EARNINGS}, category="ambiguous"),
    EvalCase("Give me the full picture on MSFT.", {OVERVIEW, PRICE, EARNINGS}, category="ambiguous"),
]


# ─────────────────────────── mocked-mode fixtures ───────────────────────────
# A deterministic stand-in for the LLM + stub tools so the default run is offline.

_TICKER_STOPWORDS = {"EPS", "PE", "P", "E", "US", "CEO", "IPO", "ETF", "AND", "VS", "OR"}


def _extract_tickers(question: str) -> list[str]:
    found = [t for t in re.findall(r"\b[A-Z]{2,5}\b", question) if t not in _TICKER_STOPWORDS]
    return found or ["AAPL"]


def _select_tools(question: str) -> list[tuple[str, dict]]:
    """Keyword-based intent detection → one or more (tool, args).

    A believable deterministic stand-in for an LLM's tool choice (it does NOT
    peek at the expected answer). Emits multiple calls when several distinct
    intents are present (multi-tool questions).
    """
    q = question.lower()
    tickers = _extract_tickers(question)
    t0 = tickers[0]
    calls: list[tuple[str, dict]] = []

    def has(*ks: str) -> bool:
        return any(k in q for k in ks)

    def add(name: str, args: dict) -> None:
        if name not in [n for n, _ in calls]:
            calls.append((name, args))

    if has("gainer", "loser", "movers", "moving in the market", "what's moving",
            "biggest mover", "up the most", "down the most"):
        add(MOVERS, {})
    if len(tickers) >= 2 and has("compare", "versus", " vs ", "vs ", "stack up",
                                 "side by side", "stronger", "which is"):
        add(COMPARE, {"tickers": tickers})
    if len(tickers) >= 2 and "compare" not in q and has(
            "screen", "filter", "which of", "which have", "over 1 trillion", "sector?"):
        add(SCREEN, {"tickers": tickers})
    if has("earning", "eps", "beat "):
        add(EARNINGS, {"ticker": t0})
    if has("overview", "sector", "market cap", "fundamental", "p/e", "pe ratio",
            "52-week", "52 week", "profile", "everything about", "good buy", "full picture"):
        add(OVERVIEW, {"ticker": t0})
    if has("price", "trading at", "trading right", "quote", "share price",
            "worth", "how much is", "cost"):
        add(PRICE, {"ticker": t0})

    if not calls:
        add(PRICE, {"ticker": t0})  # vague questions default to a price lookup
    return calls


class FakeToolModel:
    """Deterministic ChatGroq stand-in: select tools by keyword, then synthesize."""

    def __init__(self) -> None:
        self._tools: list[BaseTool] = []

    def bind_tools(self, tools, **_kwargs):
        self._tools = tools
        return self

    async def ainvoke(self, messages):
        # Once tool results exist in history, this is the synthesis turn.
        if any(isinstance(m, ToolMessage) for m in messages):
            return AIMessage(content="Based on the tool results, here is a concise synthesized answer.")
        question = next((m.content for m in messages if isinstance(m, HumanMessage)), "")
        selected = _select_tools(question)
        tool_calls = [
            {"name": name, "args": args, "id": f"call_{i}", "type": "tool_call"}
            for i, (name, args) in enumerate(selected)
        ]
        return AIMessage(content="", tool_calls=tool_calls)


def _build_stub_tools() -> list[BaseTool]:
    """Stub LangChain tools matching the real tool names/args (return canned JSON)."""

    def get_stock_price(ticker: str) -> str:
        return json.dumps({"ticker": ticker, "price": 275.15, "changePercent": "-1.2%"})

    def get_company_overview(ticker: str) -> str:
        return json.dumps({"ticker": ticker, "sector": "TECHNOLOGY", "marketCap": 3e12, "peRatio": 28.0})

    def get_earnings_report(ticker: str, quarters: int = 4) -> str:
        return json.dumps({"ticker": ticker, "quarters": [{"reportedEPS": 2.1, "estimatedEPS": 2.0, "beat": True}]})

    def compare_stocks(tickers: list[str]) -> str:
        return json.dumps({"requested": len(tickers), "compared": len(tickers), "failed": 0})

    def get_top_gainers_losers() -> str:
        return json.dumps({"topGainers": [{"ticker": "GAIN"}], "topLosers": [{"ticker": "LOSE"}]})

    def screen_stocks(tickers: list[str], maxPe: float | None = None) -> str:
        return json.dumps({"evaluated": len(tickers), "matched": 1, "didNotMatch": 1, "failed": 0})

    funcs = [get_stock_price, get_company_overview, get_earnings_report,
             compare_stocks, get_top_gainers_losers, screen_stocks]
    return [StructuredTool.from_function(func=f, name=f.__name__, description=f.__name__) for f in funcs]


# ────────────────────────────── the harness ─────────────────────────────────
@dataclass
class Scored:
    case: EvalCase
    passed: bool
    detail: str


def _score(case: EvalCase, result, live: bool) -> Scored:
    called = set(result.tool_names)
    if case.match == "all":
        tool_ok = case.expected.issubset(called)
    else:
        tool_ok = bool(case.expected & called)

    answer_ok = bool(result.final_answer and result.final_answer.strip())

    kw_ok = True
    if live and case.answer_keywords:
        ans = (result.final_answer or "").lower()
        kw_ok = any(k.lower() in ans for k in case.answer_keywords)

    passed = tool_ok and answer_ok and kw_ok
    if passed:
        detail = f"called {sorted(called)}"
    else:
        why = []
        if not tool_ok:
            why.append(f"expected {case.match} of {sorted(case.expected)}, got {sorted(called) or '[]'}")
        if not answer_ok:
            why.append("empty answer")
        if not kw_ok:
            why.append(f"answer missing {case.answer_keywords}")
        detail = "; ".join(why)
    return Scored(case=case, passed=passed, detail=detail)


async def _run_cases(graph, tracer: Tracer, *, delay: float, live: bool) -> list[Scored]:
    scored: list[Scored] = []
    for i, case in enumerate(CASES, 1):
        tracer.event(event="case_start", index=i, question=case.question,
                     expected=sorted(case.expected), match=case.match)
        try:
            result = await run_agent(graph, case.question, tracer=tracer)
            scored.append(_score(case, result, live))
        except Exception as err:  # noqa: BLE001 — one bad case must not sink the suite
            reason = str(err).replace("\n", " ")
            if len(reason) > 140:
                reason = reason[:140] + " ..."
            tracer.event(event="case_error", index=i, error=f"{type(err).__name__}: {reason}")
            scored.append(Scored(case=case, passed=False,
                                 detail=f"errored: {type(err).__name__}: {reason}"))
        if delay and i < len(CASES):
            await asyncio.sleep(delay)
    return scored


async def run_mocked(tracer: Tracer) -> list[Scored]:
    graph = build_graph(_build_stub_tools(), model=FakeToolModel())
    return await _run_cases(graph, tracer, delay=0.0, live=False)


async def run_live(tracer: Tracer) -> list[Scored]:
    from langchain_mcp_adapters.tools import load_mcp_tools
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client

    from mcp_config import server_params

    async with stdio_client(server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)
            graph = build_graph(tools, model=make_model())
            return await _run_cases(graph, tracer, delay=LIVE_INTER_CASE_DELAY, live=True)


def _print_report(scored: list[Scored]) -> int:
    # Per-case lines.
    for s in scored:
        tag = "PASS" if s.passed else "FAIL"
        q = s.case.question if len(s.case.question) <= 52 else s.case.question[:52] + "…"
        print(f"  [{tag}] ({s.case.category:9}) {q}")
        if not s.passed:
            print(f"           |- {s.detail}")

    # Per-category accuracy.
    cats: dict[str, list[Scored]] = {}
    for s in scored:
        cats.setdefault(s.case.category, []).append(s)
    print("\n  -- accuracy by category --")
    for cat, items in cats.items():
        p = sum(i.passed for i in items)
        print(f"  {cat:11} {p}/{len(items)}")

    passed = sum(s.passed for s in scored)
    total = len(scored)
    pct = (passed / total * 100) if total else 0.0
    print("\n  == tool-selection accuracy ==")
    print(f"  {passed}/{total}  ({pct:.1f}%)\n")
    return 1 if passed < total else 0


async def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows cp1252 safety
    except Exception:
        pass

    live = "--live" in sys.argv
    # Optional W&B Weave tracing (--weave / WEAVE_ENABLED); no-op otherwise.
    init_weave(weave_requested(sys.argv))

    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    trace_path = f"traces/eval-{'live' if live else 'mock'}-{stamp}.jsonl"

    mode = "LIVE (real Groq + real server)" if live else "mocked (offline)"
    print(f"\n  agent tool-selection eval - {mode} - {len(CASES)} cases")
    print(f"  trace: {trace_path}\n")

    with Tracer(trace_path) as tracer:
        tracer.event(event="run_start", mode=("live" if live else "mock"), cases=len(CASES))
        # Tag every Weave trace from this suite so it's grouped in the dashboard.
        with attributes(eval="tool-selection", mode=("live" if live else "mock")):
            scored = await (run_live(tracer) if live else run_mocked(tracer))

    passed = sum(s.passed for s in scored)
    total = len(scored)
    # Log the eval summary to Weave (comparable alongside other runs/models).
    log_summary(f"tool-selection-{'live' if live else 'mock'}",
                {"passed": passed, "total": total,
                 "accuracy": round(passed / total, 4) if total else 0.0})

    sys.exit(_print_report(scored))


if __name__ == "__main__":
    asyncio.run(main())
