#!/usr/bin/env python
"""Phase 3 — run the LangGraph agent on a single question.

Connects to the fin-mcp server, loads its tools as LangChain tools, builds the
agent graph, and runs ONE question end to end — printing the conversation so the
reason -> act -> observe loop is visible.

IMPORTANT: the whole run happens INSIDE the open MCP session, because the loaded
tools call back through that live session to execute. Build + invoke the graph
while the `async with` blocks are still open.

    python phase3_run.py                       # uses the default question
    python phase3_run.py "compare AAPL and MSFT"

Needs GROQ_API_KEY (in agent/.env).
"""

from __future__ import annotations

import asyncio
import json
import sys

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.errors import GraphRecursionError
from mcp import ClientSession
from mcp.client.stdio import stdio_client

from agent import build_graph
from mcp_config import server_params

DEFAULT_QUESTION = "What's Apple's stock price?"
RECURSION_LIMIT = 15  # the step cap — graph raises if exceeded (can't loop forever)


def render(msg) -> None:
    """Print one message in the conversation with a role label."""
    if isinstance(msg, HumanMessage):
        print(f"  [user]        {msg.content}")
    elif isinstance(msg, AIMessage):
        # An AIMessage is either a tool request (act) or the final answer.
        if msg.tool_calls:
            for tc in msg.tool_calls:
                args = json.dumps(tc["args"], separators=(",", ":"))
                print(f"  [agent->tool] call {tc['name']}({args})")
        if msg.content:
            print(f"  [agent]       {msg.content}")
    elif isinstance(msg, ToolMessage):
        # Summarize the tool result to keep the trace readable.
        summary = msg.content if isinstance(msg.content, str) else str(msg.content)
        summary = summary.replace("\n", " ")
        if len(summary) > 200:
            summary = summary[:200] + " …"
        print(f"  [tool-result] {msg.name}: {summary}")


async def main() -> None:
    question = " ".join(sys.argv[1:]).strip() or DEFAULT_QUESTION

    async with stdio_client(server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)
            graph = build_graph(tools)  # builds the model too (needs GROQ_API_KEY)

            print(f"\nQ: {question}\n")
            print("--- reason -> act -> observe ---")
            try:
                result = await graph.ainvoke(
                    {"messages": [HumanMessage(question)]},
                    config={"recursion_limit": RECURSION_LIMIT},
                )
            except GraphRecursionError:
                print(f"\nStopped: hit the {RECURSION_LIMIT}-step recursion cap.")
                return

            for msg in result["messages"]:
                render(msg)

            print("\n--- final answer ---")
            print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
