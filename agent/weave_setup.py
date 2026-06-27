"""Optional W&B Weave observability - the HOSTED equivalent of our JSONL tracer.

What this is (and isn't):
  • This is **observability / eval-tracking** for an LLM agent: it records each
    agent run (model reasoning, tool calls, results, latency) and eval summaries
    to the W&B *Weave* dashboard so runs are browsable and comparable.
  • This is NOT W&B *Models* and NOT training/experiment tracking - no model
    weights, gradients, or runs-as-in-training. It's the same information our
    `tracing.py` writes to JSONL, just sent to a hosted UI instead of a file.

Design: Weave is STRICTLY OPTIONAL. The core agent loop never imports `weave`
at module load. Everything here degrades to a no-op when:
  • the `--weave` flag / WEAVE_ENABLED env toggle is off, OR
  • the `weave` package isn't installed (it's not in requirements.txt), OR
  • WANDB_API_KEY isn't set.
So `import weave_setup` is always safe, and `@op`-decorated functions run
identically whether or not Weave is active.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

_weave = None       # the weave module, once successfully imported + initialized
_active = False     # True only after a successful weave.init()


def weave_requested(argv: list[str]) -> bool:
    """True if Weave was asked for via the --weave flag or WEAVE_ENABLED env."""
    if "--weave" in argv:
        return True
    return os.environ.get("WEAVE_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")


def init_weave(enabled: bool, project: str = "fin-mcp-agent") -> bool:
    """Initialize Weave if requested AND possible; otherwise stay a no-op.

    Returns whether Weave is now active. Reads WANDB_API_KEY from the env.
    Never raises - any problem just disables Weave and prints a note to stderr.
    """
    global _weave, _active
    if not enabled:
        return False
    # Load agent/.env so WANDB_API_KEY is visible even in mock mode (where
    # make_model - which otherwise loads .env - is never called).
    load_dotenv(Path(__file__).resolve().parent / ".env")
    try:
        import weave  # optional dependency - only imported when explicitly enabled
    except ImportError:
        print("[weave] package not installed - `pip install -r requirements-weave.txt`. "
              "Continuing without W&B (offline JSONL tracing still works).", file=sys.stderr)
        return False
    if not os.environ.get("WANDB_API_KEY"):
        print("[weave] WANDB_API_KEY not set - continuing without W&B.", file=sys.stderr)
        return False
    try:
        weave.init(project)
    except Exception as err:  # noqa: BLE001 - never let observability break the run
        print(f"[weave] init failed ({err}); continuing without W&B.", file=sys.stderr)
        return False
    _weave, _active = weave, True
    print(f"[weave] initialized - tracing to W&B Weave project '{project}'.", file=sys.stderr)
    return True


def op(fn):
    """Mark a function as a traced Weave op - lazily and optionally.

    Unlike a bare `@weave.op()`, this does NOT import or require weave at import
    time. If Weave is active at call time the function is wrapped with weave.op()
    (cached); otherwise it's called directly. Works for the agent's async nodes
    and the runner.
    """
    cached = None

    if asyncio.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def awrap(*args, **kwargs):
            nonlocal cached
            if _active and _weave is not None:
                if cached is None:
                    cached = _weave.op()(fn)
                return await cached(*args, **kwargs)
            return await fn(*args, **kwargs)
        return awrap

    @functools.wraps(fn)
    def swrap(*args, **kwargs):
        nonlocal cached
        if _active and _weave is not None:
            if cached is None:
                cached = _weave.op()(fn)
            return cached(*args, **kwargs)
        return fn(*args, **kwargs)
    return swrap


@contextlib.contextmanager
def attributes(**tags):
    """Tag every Weave trace produced inside this block (e.g. model=..., eval=...).

    These tags are what make runs comparable/filterable in the dashboard. No-op
    when Weave is inactive.
    """
    if _active and _weave is not None and hasattr(_weave, "attributes"):
        with _weave.attributes(tags):
            yield
    else:
        yield


def log_summary(name: str, summary: dict) -> None:
    """Record an eval/comparison summary as a Weave op result (so it's logged and
    comparable in the dashboard alongside the per-run traces). No-op when inactive."""
    if not (_active and _weave is not None):
        return
    try:
        @_weave.op(name="evaluation_summary")
        def evaluation_summary(name: str, summary: dict) -> dict:
            return {"name": name, **summary}

        evaluation_summary(name, summary)
    except Exception as err:  # noqa: BLE001
        print(f"[weave] summary log failed ({err}).", file=sys.stderr)


def is_active() -> bool:
    return _active
