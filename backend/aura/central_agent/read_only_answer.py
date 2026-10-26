"""The answer to a plain read-only request, built from the tool's real result.

The tool ran and its result was recorded as text (see execution.py
`_recorded_output`). The answer shows that text; nothing is paraphrased,
summarised or inferred, so a small model cannot drop or alter a diff, a
listing or a file's contents. Long results are cut at a stated bound.
"""

from __future__ import annotations

import json

#: Characters of tool output shown in one answer.
MAX_SHOWN = 8000

#: Capabilities answered this way.
RENDERED = frozenset({"git.diff", "git.status", "filesystem.list", "filesystem.read",
                      "project.list", "workflow.list"})


def _bounded(text: str) -> str:
    if len(text) <= MAX_SHOWN:
        return text
    return text[:MAX_SHOWN] + f"\n…(cut here; {len(text) - MAX_SHOWN} more characters)"


def _indented(lines: list[str]) -> str:
    return "\n".join(f"  {line}" for line in lines)


def _records(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            out.append(value)
    return out


def describe(capability: str, task_input: dict, output: str) -> str:
    """The answer for one read-only task, from its recorded output."""
    path = str((task_input or {}).get("path") or ".")
    if capability == "git.diff":
        if output.strip() in ("", "no changes"):
            return "The working tree has no uncommitted changes."
        return "Uncommitted changes in the working tree:\n\n" + _bounded(output)
    if capability == "git.status":  # a question about the current branch
        from .git_answer import current_branch

        branch = current_branch(output)
        return f"The current branch is {branch}." if branch else \
            "Git reported no current branch (a detached HEAD or an empty repository)."
    if capability == "filesystem.list":
        names = [n for n in output.splitlines() if n]
        if not names:
            return f"{path} is empty."
        where = "the project root" if path in (".", "") else path
        return f"{len(names)} entries in {where}:\n" + _bounded(_indented(names))
    if capability == "filesystem.read":
        return f"{path} is empty." if not output else f"Contents of {path}:\n\n" + _bounded(output)
    if capability == "project.list":
        projects = _records(output)
        if not projects:
            return "No projects are registered."
        lines = [f"{p.get('name') or p.get('id')} — {p.get('path') or ''}".rstrip(" —") for p in projects]
        return f"{len(projects)} registered project(s):\n" + _bounded(_indented(lines))
    if capability == "workflow.list":
        workflows = _records(output)
        if not workflows:
            return "No workflows are stored."
        lines = [f"{w.get('name') or '(unnamed)'} ({w.get('id')}, {w.get('nodeCount', 0)} nodes)"
                 for w in workflows]
        return f"{len(workflows)} stored workflow(s):\n" + _bounded(_indented(lines))
    raise ValueError(f"not a rendered read-only capability: {capability}")


NO_OUTPUT = ("The tool ran, but no result was recorded for it, so there is nothing "
             "real to show. The request was not completed.")


__all__ = ["MAX_SHOWN", "NO_OUTPUT", "RENDERED", "describe"]
