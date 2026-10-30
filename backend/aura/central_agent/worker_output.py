"""Worker stdout → the text a person reads as that worker's answer.

A coding CLI writes its terminal chrome to the same stream as its answer:
ANSI colour codes, a one-line banner naming the model, and a trace line for
each tool call. This module removes exactly those shapes and nothing else.

Deliberately narrow. Only three shapes are recognised, each observed in real
Kilo output: ANSI escape sequences, a banner line of the form
"> <word> · <model>", and a tool trace line "→ <Verb> <path>" (the arrow
followed by a single capitalised verb and one target). Any other line is kept,
so a worker's real findings are never dropped by a broad pattern. The raw
stdout is untouched in the execution record for diagnostics.
"""

from __future__ import annotations

import re

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\[[0-9;]*m")
_BANNER = re.compile(r"^\s*>\s+[\w.-]+\s+·\s+\S+\s*$")
_TOOL_TRACE = re.compile(r"^\s*→\s+(?:\[[0-9;]*m)*\s*[A-Z][a-z]+\s+\S+\s*$")


def clean_worker_output(text: str) -> str:
    """The worker's answer with terminal chrome removed. Empty in, empty out;
    an answer that is only chrome comes back empty, never as a success."""
    if not text:
        return ""
    kept: list[str] = []
    for line in _ANSI.sub("", text).splitlines():
        if _BANNER.match(line) or _TOOL_TRACE.match(line):
            continue
        kept.append(line.rstrip())
    return "\n".join(kept).strip()
