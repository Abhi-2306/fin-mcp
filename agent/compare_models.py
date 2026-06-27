#!/usr/bin/env python
"""Phase C — compare tool-selection across several Groq models.

Runs the Phase B benchmark (eval_agent.CASES) against 2-3 Groq models and prints
a table of: tool-selection accuracy, avg latency/question, avg tool-calls/question.

Free-tier reality (this drove the design):
  Groq free tier is 30 req/min AND ~100k tokens/DAY. Each question is ~2 LLM
  calls. The full 42-case benchmark across 3 models is ~250 calls / ~380k tokens
  — far over the daily budget. So:
    • default = a SMALL subset (1 case per category, ~8) → fits a daily budget;
      use --full for all 42 (realistically needs a single model or a paid tier).
    • throttle: a deliberate per-question delay keeps us under 30 rpm.
    • backoff: the agent's own _ainvoke_with_backoff retries 429s.
    • RESUMABLE per model: results are saved to JSON after EACH model, and a
      rate-limit hit stops cleanly — re-running skips already-finished models.

  python compare_models.py                 # mocked (offline; identical rows — harness check)
  python compare_models.py --live           # real comparison (uses quota)
  python compare_models.py --live --full     # all 42 cases (heavy!)
  python compare_models.py --live --models "llama-3.1-8b-instant,qwen/qwen3-32b"
  python compare_models.py --live --fresh    # ignore any saved progress and restart
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from agent import _is_rate_limit, build_graph, make_model
from eval_agent import CASES, EvalCase, FakeToolModel, _build_stub_tools, _score, pick_subset
from runner import run_agent
from tracing import Tracer
from weave_setup import attributes, init_weave, log_summary, weave_requested

# Verified available on the free tier (see `client.models.list()`); all support tools.
DEFAULT_MODELS = [
    "llama-3.3-70b-versatile",                    # 70B baseline
    "llama-3.1-8b-instant",                       # 8B small/fast
    "meta-llama/llama-4-scout-17b-16e-instruct",  # Llama 4, 17B MoE
]

# ~1 request/2s = 30 rpm; each question is ~2 calls, so ~4s/question stays safe.
LIVE_QUESTION_DELAY = 4.0


@dataclass
class ModelResult:
    model: str
    completed: int       # cases actually run (may be < total if rate-limited)
    total: int
    passed: int
    avg_latency_s: float
    avg_tool_calls: float
    status: str          # "ok" | "partial (rate-limited)"

    @property
    def accuracy(self) -> float:
        return (self.passed / self.completed) if self.completed else 0.0


async def evaluate_model(
    model_name: str, cases: list[EvalCase], tracer: Tracer, *, live: bool, delay: float
) -> ModelResult:
    """Run the case set against one model and aggregate its metrics."""
    passed = completed = 0
    lat_sum = tool_sum = 0.0
    status = "ok"

    async def run_with(graph) -> None:
        nonlocal passed, completed, lat_sum, tool_sum, status
        for i, case in enumerate(cases, 1):
            tracer.event(event="case_start", model=model_name, index=i, question=case.question)
            t0 = time.perf_counter()
            try:
                result = await run_agent(graph, case.question, tracer=tracer)
            except Exception as err:  # noqa: BLE001 — one bad case must not crash the comparison
                # Caught INSIDE the session so it never escapes as an ExceptionGroup.
                if _is_rate_limit(err):
                    status = "partial (rate-limited)"
                    tracer.event(event="stopped", model=model_name, reason="rate_limit", completed=completed)
                    return
                # Any other per-case failure (e.g. a small model loops and hits the
                # recursion cap → GraphRecursionError) counts as a FAILED case for
                # this model. Record it (completed but not passed) and continue —
                # this is itself a meaningful comparison signal.
                completed += 1
                lat_sum += time.perf_counter() - t0
                tracer.event(event="case_error", model=model_name, index=i, error=type(err).__name__)
                if delay and i < len(cases):
                    await asyncio.sleep(delay)
                continue
            latency = time.perf_counter() - t0
            completed += 1
            lat_sum += latency
            tool_sum += len(result.tool_calls)
            if _score(case, result, live).passed:
                passed += 1
            if delay and i < len(cases):
                await asyncio.sleep(delay)

    if live:
        from langchain_mcp_adapters.tools import load_mcp_tools
        from mcp import ClientSession
        from mcp.client.stdio import stdio_client

        from mcp_config import server_params

        async with stdio_client(server_params()) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await load_mcp_tools(session)
                await run_with(build_graph(tools, model=make_model(model_name)))
    else:
        # Mock: the FakeToolModel ignores the model id, so rows will be identical.
        # This run only verifies the harness/table/resume — not real differences.
        await run_with(build_graph(_build_stub_tools(), model=FakeToolModel(), iter_delay=0.0))

    avg_lat = lat_sum / completed if completed else 0.0
    avg_tc = tool_sum / completed if completed else 0.0
    return ModelResult(model_name, completed, len(cases), passed, avg_lat, avg_tc, status)


def _load_saved(path: Path) -> dict[str, dict]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def _save(path: Path, results: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2), encoding="utf-8")


def _print_table(models: list[str], results: dict[str, dict]) -> None:
    print("\n" + "=" * 86)
    print(f"  {'model':<44}{'cases':>8}{'accuracy':>11}{'avg lat':>10}{'tools/q':>9}")
    print("-" * 86)
    for m in models:
        r = results.get(m)
        if not r:
            print(f"  {m:<44}{'—':>8}{'(not run)':>11}")
            continue
        acc = (r["passed"] / r["completed"] * 100) if r["completed"] else 0.0
        cases = f"{r['completed']}/{r['total']}"
        flag = "" if r["status"] == "ok" else " *"
        print(f"  {m:<44}{cases:>8}{acc:>10.1f}%{r['avg_latency_s']:>9.2f}s{r['avg_tool_calls']:>9.2f}{flag}")
    print("=" * 86)
    if any(results.get(m, {}).get("status", "ok") != "ok" for m in models):
        print("  * partial: stopped early on a rate limit. Re-run the same command to resume.")
    print()


async def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    argv = sys.argv[1:]
    live = "--live" in argv
    full = "--full" in argv
    fresh = "--fresh" in argv
    models = DEFAULT_MODELS
    if "--models" in argv:
        models = [m.strip() for m in argv[argv.index("--models") + 1].split(",") if m.strip()]

    # Optional W&B Weave tracing (--weave / WEAVE_ENABLED); no-op otherwise.
    init_weave(weave_requested(argv))

    cases = CASES if full else pick_subset(CASES)
    mode = "live" if live else "mock"
    out_path = Path(f"traces/compare-models-{mode}.json")
    trace_path = f"traces/compare-{mode}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"

    print(f"\n  multi-model comparison - {mode} - {len(models)} models x {len(cases)} cases")
    if live and full:
        print("  WARNING: --full --live across multiple models will likely exceed the")
        print("           free-tier daily token budget. Expect partial results.")
    print(f"  results: {out_path}{'  (--fresh: ignoring any saved progress)' if fresh else '  (resumable)'}\n")

    results = {} if fresh else _load_saved(out_path)

    with Tracer(trace_path) as tracer:
        tracer.event(event="run_start", mode=mode, models=models, cases=len(cases))
        for model in models:
            prior = results.get(model)
            if prior and prior.get("status") == "ok" and not fresh:
                print(f"  [skip] {model} — already complete ({prior['passed']}/{prior['completed']})")
                continue
            print(f"  [run ] {model} ...")
            # Tag this model's Weave traces so models are comparable in the dashboard.
            with attributes(eval="model-comparison", model=model, mode=mode):
                result = await evaluate_model(model, cases, tracer, live=live,
                                              delay=LIVE_QUESTION_DELAY if live else 0.0)
            results[model] = asdict(result)
            _save(out_path, results)  # persist after EACH model → resumable
            log_summary(f"compare:{model}",
                        {"model": model, "accuracy": round(result.accuracy, 4),
                         "avg_latency_s": round(result.avg_latency_s, 3),
                         "avg_tool_calls": round(result.avg_tool_calls, 3),
                         "completed": result.completed, "total": result.total})
            print(f"         {result.passed}/{result.completed} passed"
                  f"{'  [RATE-LIMITED, stopping]' if result.status != 'ok' else ''}")
            if result.status != "ok":
                print("\n  Stopped on a rate limit. Progress saved — re-run to resume the rest.")
                break

    _print_table(models, results)


if __name__ == "__main__":
    asyncio.run(main())
