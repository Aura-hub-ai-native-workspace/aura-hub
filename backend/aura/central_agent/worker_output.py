"""Worker stdout → the text a person reads as that worker's answer.

A coding CLI writes its terminal chrome to the same stream as its answer:
ANSI colour codes, a one-line banner naming the model, and a trace line for
each tool call. This module removes exactly those shapes and nothing else.

Deliberately narrow. Only these shapes are recognised, each observed in real
worker output: ANSI escape sequences, a banner line of the form
"> <word> · <model>", a tool trace line "→ <Verb> <path>", and OpenCode's trace
lines ("✗ <Tool> … failed", "⚙ <tool> {…}", "← <Verb> <path>", "✱ <Tool> …"). The trace
is written after the answer, so from the first exact trace line onward the rest is
trace and is dropped. Any other line is kept, so a worker's real findings are never
dropped by a broad pattern (a review may list items with "✗"; only the exact shapes
count). The raw stdout is untouched in the execution record for diagnostics.
"""

from __future__ import annotations

import re

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\[[0-9;]*m")
_BANNER = re.compile(r"^\s*>\s+[\w.-]+\s+·\s+\S+\s*$")
_TOOL_TRACE = re.compile(r"^\s*→\s+(?:\[[0-9;]*m)*\s*[A-Z][a-z]+\s+\S+\s*$")
#: OpenCode's own trace lines. Once one appears after the answer, the rest of the stream is trace.
_TRACE_START = (
    re.compile(r"^\s*✗\s+[A-Za-z_]+\s+.+\s+failed\s*$"),
    re.compile(r"^\s*⚙\s+[A-Za-z_]+\s*\{"),
    re.compile(r"^\s*←\s+[A-Z][a-z]+\s+\S+"),
    re.compile(r"^\s*✱\s+[A-Z][a-z]+\s+.+"),
)


def clean_worker_output(text: str) -> str:
    """The worker's answer with terminal chrome removed. Empty in, empty out;
    an answer that is only chrome comes back empty, never as a success."""
    if not text:
        return ""
    kept: list[str] = []
    for line in _ANSI.sub("", text).splitlines():
        if any(p.match(line) for p in _TRACE_START):
            if any(k.strip() for k in kept):
                break          # the answer is done; what follows is the tool trace
            continue           # a trace line before any answer is skipped on its own
        if _BANNER.match(line) or _TOOL_TRACE.match(line):
            continue
        kept.append(line.rstrip())
    return "\n".join(kept).strip()
