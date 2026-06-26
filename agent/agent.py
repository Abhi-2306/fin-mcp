"""The LangGraph finance agent — a single-agent reason -> act -> observe loop.

This is the core. It wires a `StateGraph` with two nodes (an LLM "agent" node and
a tool-executing node) and a conditional edge that loops between them until the
model stops asking for tools and produces a final answer.

──────────────────────────────────────────────────────────────────────────────
LangGraph vs LangChain — what belongs to which (the distinction to know):

  LangGraph owns the CONTROL FLOW / orchestration:
    • StateGraph                — the graph container
    • AgentState + add_messages  — the typed state and its accumulator reducer
    • add_node / add_edge / add_conditional_edges — the wiring
    • ToolNode                   — the prebuilt node that runs tool calls
    • recursion_limit            — the step cap (set at invoke time)

  LangChain owns the LLM PRIMITIVES that flow THROUGH the graph:
    • ChatGroq                   — the Groq chat-model wrapper (a ChatModel)
    • model.bind_tools(tools)    — attaching tool schemas to the model
    • SystemMessage / AIMessage / ToolMessage — the message types
    • BaseTool objects            — the tools (from langchain-mcp-adapters)

  Mental model: LangGraph is the *state machine*; LangChain provides the *model,
  messages, and tools* that the machine moves around.
──────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Annotated, TypedDict

from dotenv import load_dotenv
from langchain_core.messages import AnyMessage, SystemMessage
from langchain_core.tools import BaseTool
from langchain_groq import ChatGroq
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

MODEL_NAME = "llama-3.3-70b-versatile"

# A small pause before each model call so a tool-heavy loop stays comfortably
# under Groq's free-tier 30 req/min. Tunable; negligible for single questions.
ITER_DELAY_SECONDS = 0.5

SYSTEM_PROMPT = (
    "You are a financial-data assistant. You have tools that fetch REAL stock "
    "market data from an MCP server: current prices, company overviews, earnings, "
    "side-by-side comparisons, top movers, and screening. Use the tools to answer "
    "with real data — never invent numbers. Call the most specific tool(s) for the "
    "question, then give a concise, well-reasoned answer grounded in the results. "
    "IMPORTANT when calling tools: only include OPTIONAL parameters when you have a "
    "real, concrete value for them. Never pass empty strings (\"\") or placeholder "
    "zeros for optional fields — simply omit them. (For example, to screen by P/E "
    "only, pass just `tickers` and `maxPe`; do not include `sector`.)"
)


# ── LangGraph: the typed graph state ──────────────────────────────────────────
# `add_messages` is LangGraph's message-accumulator reducer. Because `messages`
# is annotated with it, a node returning {"messages": [x]} APPENDS x to the
# history instead of overwriting it — so the user turn, each AIMessage, and each
# ToolMessage all accrue into one growing conversation the model can see.
class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]


def make_model(model_name: str = MODEL_NAME) -> ChatGroq:
    """LangChain: construct the Groq chat model (fail-fast if the key is missing).

    `model_name` is configurable so the multi-model comparison (compare_models.py)
    can build the same agent graph against different Groq models.
    """
    # Load agent/.env regardless of the current working directory.
    load_dotenv(Path(__file__).resolve().parent / ".env")
    import os

    if not os.environ.get("GROQ_API_KEY"):
        raise SystemExit(
            "FATAL: GROQ_API_KEY is not set.\n"
            "Copy agent/.env.example to agent/.env and add your free Groq key\n"
            "(get one at https://console.groq.com/keys)."
        )

    return ChatGroq(
        model=model_name,
        temperature=0,        # deterministic tool selection
        max_retries=2,        # ChatGroq's own retry on transient/429 errors
    )


def _is_rate_limit(err: Exception) -> bool:
    """Best-effort detection of a Groq 429 across SDK/wrapper variations."""
    if "ratelimit" in type(err).__name__.lower():
        return True
    status = getattr(err, "status_code", None) or getattr(err, "code", None)
    if status == 429:
        return True
    text = str(err).lower()
    return "429" in text or "rate limit" in text


async def _ainvoke_with_backoff(model, messages, max_attempts: int = 4):
    """Call the model, retrying ONLY on rate limits with exponential backoff.

    This is our own safety net on top of ChatGroq's max_retries, because the
    free tier's 30 req/min is easy to trip during a multi-step loop.
    """
    delay = 2.0
    for attempt in range(max_attempts):
        try:
            return await model.ainvoke(messages)
        except Exception as err:  # noqa: BLE001 — we re-raise anything non-429
            if _is_rate_limit(err) and attempt < max_attempts - 1:
                print(f"[rate-limit] Groq 429; backing off {delay:.0f}s", file=sys.stderr)
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise


def build_graph(tools: list[BaseTool], model: ChatGroq | None = None):
    """Build and compile the agent graph against a set of (live) LangChain tools."""
    model = model or make_model()
    # LangChain: bind the tool schemas so the model can emit `tool_calls`.
    model_with_tools = model.bind_tools(tools)

    # ── node (a) — the "reason" step: ask the model what to do next ──
    async def agent_node(state: AgentState) -> dict:
        await asyncio.sleep(ITER_DELAY_SECONDS)  # gentle on the rate limit
        # System prompt is prepended fresh each turn; history is accumulated state.
        messages = [SystemMessage(SYSTEM_PROMPT), *state["messages"]]
        response = await _ainvoke_with_backoff(model_with_tools, messages)
        return {"messages": [response]}  # appended via add_messages

    # ── node (b) — the "act + observe" step ──
    # LangGraph's PREBUILT ToolNode: it reads the tool_calls off the last
    # AIMessage, executes each (async-aware, handles parallel calls), and appends
    # one ToolMessage per call. We use the prebuilt rather than a custom node
    # because it already does arg validation, multiple-call handling, and turns
    # tool errors into ToolMessages the model can read and recover from — there's
    # nothing custom we'd need that it doesn't already do.
    tool_node = ToolNode(tools)

    # ── conditional routing — did the model ask to act, or is it finished? ──
    def route(state: AgentState) -> str:
        last = state["messages"][-1]
        # An AIMessage with tool_calls → go execute them; otherwise it's the
        # final natural-language answer → stop.
        if getattr(last, "tool_calls", None):
            return "tools"
        return END

    # ── LangGraph: assemble the StateGraph ──
    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_edge(START, "agent")                                  # entry → reason
    graph.add_conditional_edges("agent", route, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")                                # observe → reason (loop)
    return graph.compile()
