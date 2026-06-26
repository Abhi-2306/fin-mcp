"""Structured JSONL tracing for agent runs.

One JSON object per line (JSONL) so traces are easy to tail, grep, and diff.
Each step records: timestamp, node, latency, and node-specific fields (the
model's reasoning + requested tool calls for `agent` steps; tool results for
`tools` steps). Written to agent/traces/ (gitignored).
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path


class Tracer:
    """Append-only JSONL writer for one agent run (or one eval suite)."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._f = self.path.open("w", encoding="utf-8")

    def _write(self, record: dict) -> None:
        # Prepend an ISO timestamp to every record.
        record = {"ts": _dt.datetime.now().isoformat(timespec="milliseconds"), **record}
        self._f.write(json.dumps(record, default=str) + "\n")
        self._f.flush()

    def event(self, **fields) -> None:
        """Log an arbitrary record (e.g. run/case boundaries)."""
        self._write(fields)

    def log_step(self, *, node: str, latency_s: float, **fields) -> None:
        """Log one graph super-step with its latency and node-specific fields."""
        self._write({"node": node, "latency_s": round(latency_s, 3), **fields})

    def close(self) -> None:
        self._f.close()

    def __enter__(self) -> "Tracer":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
