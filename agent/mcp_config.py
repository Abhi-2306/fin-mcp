"""Shared MCP connection configuration.

Defines *how* to spawn the existing TypeScript fin-mcp server as a subprocess
over stdio. Kept in one place so every phase — the raw client (Phase 1), the
tool loader (Phase 2), and the agent (Phase 3+) — connects identically.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from mcp import StdioServerParameters

# The agent/ folder lives inside the fin-mcp project; the TS server is one level up.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVER_ENTRY = "src/index.ts"


def _resolve_bun() -> str:
    """Find a bun executable Python's subprocess can actually exec.

    On Windows, `bun` on PATH is usually an npm-installed `.cmd`/`.ps1` shim that
    can't be exec'd directly by a non-shell subprocess, so we prefer the real
    `bun.exe`. Set BUN_PATH to override all of this.
    """
    override = os.environ.get("BUN_PATH")
    if override:
        return override

    # Prefer a real .exe over a shim.
    for name in ("bun.exe", "bun"):
        found = shutil.which(name)
        if found and found.lower().endswith(".exe"):
            return found

    # Known npm-global install location (the shim points here) as a fallback.
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        candidate = Path(appdata) / "npm" / "node_modules" / "bun" / "bin" / "bun.exe"
        if candidate.exists():
            return str(candidate)

    # Last resort: whatever `which` found (a shim works fine on POSIX shells).
    return shutil.which("bun") or "bun"


def server_params() -> StdioServerParameters:
    """Parameters to launch the fin-mcp stdio server as a subprocess.

    cwd is the project root so Bun auto-loads the root `.env` (which holds
    ALPHAVANTAGE_API_KEY) and resolves the `src/index.ts` entry path. We leave
    `env` unset: the MCP SDK supplies a safe default environment that includes
    PATH, and the server reads its API key from the on-disk .env regardless.
    """
    return StdioServerParameters(
        command=_resolve_bun(),
        args=["run", SERVER_ENTRY],
        cwd=str(PROJECT_ROOT),
    )
