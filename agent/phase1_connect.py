#!/usr/bin/env python
"""Phase 1 — Prove the cross-language MCP connection works (no LLM yet).

This spawns the TypeScript fin-mcp server as a subprocess, completes the MCP
handshake over stdio, calls `tools/list`, and prints every discovered tool with
its JSON Schema. If this runs, a Python MCP *client* can talk to a TypeScript
MCP *server* purely over the protocol — the foundation everything else builds on.

No LLM, no LangChain, no LangGraph here on purpose: this isolates the transport.

    python phase1_connect.py
"""

from __future__ import annotations

import asyncio

from mcp import ClientSession
from mcp.client.stdio import stdio_client

from mcp_config import PROJECT_ROOT, server_params


async def main() -> None:
    params = server_params()
    print(f"Spawning server: {params.command} {' '.join(params.args)}")
    print(f"  cwd = {PROJECT_ROOT}\n")

    # stdio_client launches the subprocess and yields its (read, write) streams.
    async with stdio_client(params) as (read, write):
        # ClientSession drives the JSON-RPC 2.0 protocol over those streams.
        async with ClientSession(read, write) as session:
            # --- the MCP handshake ---
            # initialize → the server replies with its name/version + capabilities.
            init = await session.initialize()
            print(f"Connected to: {init.serverInfo.name} v{init.serverInfo.version}")
            print(f"Protocol version: {init.protocolVersion}\n")

            # --- tools/list: discover what the server exposes ---
            result = await session.list_tools()
            tools = result.tools
            print(f"Discovered {len(tools)} tools:\n")

            for i, tool in enumerate(tools, 1):
                print(f"{i}. {tool.name}")
                if tool.description:
                    # Keep the printout tidy — first line of the description.
                    print(f"   {tool.description.splitlines()[0]}")

                schema = tool.inputSchema or {}
                props = schema.get("properties", {})
                required = set(schema.get("required", []))
                if props:
                    print("   inputs:")
                    for name, spec in props.items():
                        flag = "required" if name in required else "optional"
                        ptype = spec.get("type", "?")
                        # Surface array item types (e.g. tickers: array<string>).
                        if ptype == "array" and isinstance(spec.get("items"), dict):
                            ptype = f"array<{spec['items'].get('type', '?')}>"
                        print(f"     - {name}: {ptype} ({flag})")
                else:
                    print("   inputs: (none)")
                print()

    print("Phase 1 OK - Python MCP client <-> TypeScript MCP server over stdio.")


if __name__ == "__main__":
    asyncio.run(main())
