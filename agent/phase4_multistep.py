#!/usr/bin/env python
"""Phase 4 — multi-step demonstration with a visible reason -> act -> observe loop.

A question like "compare AAPL and MSFT and say which is stronger" forces the
agent to take MULTIPLE steps: call tool(s), observe the data, then reason again
to synthesize an answer. Unlike Phase 3 (which dumped the final message list),
this STREAMS the graph node-by-node via `graph.astream(stream_mode="updates")`,
so you watch each super-step of the loop unfold.

    python phase4_multistep.py
    python phase4_multistep.py "compare NVDA, AMD and INTC — which has the best value?"

Needs GROQ_API_KEY (in agent/.env).
"""

from __future__ import annotations

import asyncio
import json
import sys

from langchain_core.messages import HumanMessage
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.errors import GraphRecursionError
from mcp import ClientSession
from mcp.client.stdio import stdio_client

from agent import build_graph
from mcp_config import server_params

DEFAULT_QUESTION = "Compare AAPL and MSFT and tell me which looks stronger and why."
RECURSION_LIMIT = 15


def _summarize(text: str, limit: int = 240) -> str:
    text = text.replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + " …"


def render_agent(step: int, messages) -> str | None:
    """Render an 'agent' (reason) super-step. Returns the final answer if any."""
    last = messages[-1]
    tool_calls = getattr(last, "tool_calls", None)
    if tool_calls:
        # REASON → decided to ACT: show which tools and with what args.
        names = ", ".join(tc["name"] for tc in tool_calls)
        print(f"[STEP {step}] AGENT (reason) -> wants to call: {names}")
        for tc in tool_calls:
            args = json.dumps(tc["args"], separators=(",", ":"))
            print(f"            call {tc['name']}({args})")
        return None
    # No tool calls → this is the final synthesized answer.
    print(f"[STEP {step}] AGENT (reason) -> produced final answer")
    return last.content


def render_tools(step: int, messages) -> None:
    """Render a 'tools' (act -> observe) super-step: one line per tool result."""
    print(f"[STEP {step}] TOOLS (act -> observe) -> {len(messages)} result(s)")
    for m in messages:
        print(f"            {m.name}: {_summarize(str(m.content))}")


async def main() -> None:
    question = " ".join(sys.argv[1:]).strip() or DEFAULT_QUESTION

    async with stdio_client(server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)
            graph = build_graph(tools)

            print(f"\nQ: {question}\n")
            print("=== reason -> act -> observe (streamed live) ===")

            step = 0
            final_answer = None
            try:
                # stream_mode="updates" yields {node_name: {"messages": [...]}}
                # after each node runs — i.e. one chunk per super-step of the loop.
                async for chunk in graph.astream(
                    {"messages": [HumanMessage(question)]},
                    config={"recursion_limit": RECURSION_LIMIT},
                    stream_mode="updates",
                ):
                    for node, update in chunk.items():
                        step += 1
                        messages = update["messages"]
                        if node == "agent":
                            answer = render_agent(step, messages)
                            if answer is not None:
                                final_answer = answer
                        elif node == "tools":
                            render_tools(step, messages)
            except GraphRecursionError:
                print(f"\nStopped: hit the {RECURSION_LIMIT}-step recursion cap.")
                return

            print("\n=== FINAL SYNTHESIS ===")
            print(final_answer)


if __name__ == "__main__":
    asyncio.run(main())
