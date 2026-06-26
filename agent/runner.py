"""Shared agent runner: stream a compiled graph, optionally trace, return a result.

Both the demo and the eval drive the agent the same way through this. Streaming
with `stream_mode="updates"` gives us one chunk per graph super-step, which is
exactly the granularity we want to (a) trace and (b) measure per-step latency.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage

from tracing import Tracer
from weave_setup import op


@dataclass
class RunResult:
    """The outcome of one agent run — what the eval asserts against."""

    question: str
    final_answer: str | None
    tool_calls: list[dict] = field(default_factory=list)  # [{"name","args"}] in call order
    steps: int = 0

    @property
    def tool_names(self) -> list[str]:
        return [tc["name"] for tc in self.tool_calls]


def _summary(text: str, limit: int = 200) -> str:
    text = text.replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + " ..."


@op  # traced as a Weave op when Weave is active; a plain call otherwise
async def run_agent(
    graph,
    question: str,
    *,
    tracer: Tracer | None = None,
    recursion_limit: int = 15,
) -> RunResult:
    """Run one question through the graph, collecting tool calls + final answer.

    Latency note: we attribute the wall-clock gap between successive streamed
    chunks to the node that just produced — an approximate per-super-step latency
    (the first `agent` step also includes graph startup).
    """
    result = RunResult(question=question, final_answer=None)

    t_prev = time.perf_counter()
    async for chunk in graph.astream(
        {"messages": [HumanMessage(question)]},
        config={"recursion_limit": recursion_limit},
        stream_mode="updates",
    ):
        now = time.perf_counter()
        latency = now - t_prev
        t_prev = now

        for node, update in chunk.items():
            result.steps += 1
            messages = update["messages"]

            if node == "agent":
                last = messages[-1]
                tool_calls = getattr(last, "tool_calls", None) or []
                for tc in tool_calls:
                    result.tool_calls.append({"name": tc["name"], "args": tc["args"]})
                if tracer:
                    tracer.log_step(
                        node="agent",
                        latency_s=latency,
                        reasoning=last.content or "",
                        tool_calls=[{"name": tc["name"], "args": tc["args"]} for tc in tool_calls],
                    )
                # No tool calls → this AIMessage is the final synthesized answer.
                if not tool_calls:
                    result.final_answer = last.content

            elif node == "tools":
                results = [{"tool": m.name, "summary": _summary(str(m.content))} for m in messages]
                if tracer:
                    tracer.log_step(node="tools", latency_s=latency, results=results)

    return result
