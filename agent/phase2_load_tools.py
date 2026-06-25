#!/usr/bin/env python
"""Phase 2 — Load the MCP tools as LangChain tools (still no LLM).

Phase 1 proved we can *discover* the server's tools over the raw MCP protocol.
But the model can't use raw MCP tool definitions directly — LangChain (and
therefore LangGraph) expects tools to be `BaseTool` objects with a name, a
description, and a pydantic args schema. This phase does the conversion.

Who does what (the key distinction):

  • MCP Python SDK (`mcp`)            — the transport. `ClientSession` speaks
                                        JSON-RPC to the server: initialize,
                                        tools/list, tools/call.

  • langchain-mcp-adapters           — the ADAPTER / bridge. `load_mcp_tools`
    (`load_mcp_tools`)                  reads the MCP tool definitions from the
                                        session and wraps each one as a LangChain
                                        tool whose `.ainvoke()` calls back through
                                        the session's `tools/call`. It translates
                                        MCP's JSON Schema into a pydantic args
                                        schema. This is the ONLY MCP-aware glue.

  • LangChain (`langchain-core`)      — the tool ABSTRACTION. The objects we get
    (`BaseTool`)                        back are `BaseTool`s — the same interface
                                        any LangChain/LangGraph code binds to a
                                        model. From here up, nothing knows or
                                        cares that these tools came from MCP.

    python phase2_load_tools.py
"""

from __future__ import annotations

import asyncio

from langchain_core.tools import BaseTool  # the LangChain tool abstraction
from langchain_mcp_adapters.tools import load_mcp_tools  # the MCP→LangChain adapter
from mcp import ClientSession  # the transport (MCP SDK)
from mcp.client.stdio import stdio_client

from mcp_config import server_params


async def load_tools() -> list[BaseTool]:
    """Connect to the fin-mcp server and return its tools as LangChain tools."""
    async with stdio_client(server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            # The one adapter call: MCP tool defs (over `session`) → LangChain tools.
            return await load_mcp_tools(session)


async def main() -> None:
    tools = await load_tools()

    print(f"Loaded {len(tools)} MCP tools as LangChain tools:\n")
    for i, tool in enumerate(tools, 1):
        # `type(tool).__name__` confirms these are real LangChain BaseTool objects
        # (typically StructuredTool) — not MCP types anymore.
        print(f"{i}. {tool.name}   [{type(tool).__name__}, BaseTool={isinstance(tool, BaseTool)}]")
        print(f"   {tool.description.splitlines()[0]}")

        # `.args` is the pydantic-derived arg schema the adapter built from the
        # MCP inputSchema — this is what the model sees when deciding how to call.
        args = tool.args
        if args:
            print("   args:")
            for name, spec in args.items():
                ptype = spec.get("type", spec.get("anyOf", "?"))
                print(f"     - {name}: {ptype}")
        else:
            print("   args: (none)")
        print()

    print("Phase 2 OK - MCP tools are now LangChain BaseTool objects, ready to bind to a model.")


if __name__ == "__main__":
    asyncio.run(main())
