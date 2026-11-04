"""What the CEO says in the group chat when it assigns work and when a worker hands back.

Plain wording built from facts the run already has (the brief, the worker's
name, its state and detail). Nothing here decides anything: it only describes
what happened, so the person can follow the work without reading the event log.
"""

from __future__ import annotations

#: How many characters of a brief the assignment line quotes.
MAX_BRIEF_CHARS = 220

_FAILED = {"failed", "denied", "timeout", "blocked", "cancelled"}


def assignment_line(brief: str) -> str:
    """The CEO's line when it starts a step: the step's own description, shortened."""
    text = " ".join((brief or "").split())
    if not text:
        return "Starting the next step."
    if len(text) > MAX_BRIEF_CHARS:
        text = text[: MAX_BRIEF_CHARS - 1].rstrip() + "…"
    return f"Next step: {text}"


_DISPLAY = {
    "opencode": "OpenCode", "kilo-code": "Kilo Code", "claude-code": "Claude Code",
    "codex-cli": "Codex CLI", "qwen-cli": "Qwen Code", "gemini-cli": "Gemini CLI",
}
#: Boilerplate the executor adds to every successful delegate, which says nothing the line does not.
_BOILERPLATE = ("Delegate to coding agent completed.",)


def display_name(worker: str) -> str:
    """A worker's name as a person says it (the id `opencode` is `OpenCode`)."""
    w = (worker or "").strip()
    return _DISPLAY.get(w.lower(), w)


def handoff_line(worker: str, state: str, detail: str | None) -> str:
    """The CEO's line when a worker finishes: what it reports, in one or two plain sentences."""
    name = display_name(worker) or "The worker"
    note = " ".join((detail or "").split())
    for junk in _BOILERPLATE:
        note = note.replace(junk, "").strip()
    note = note.replace(f"{name} completed the task.", "").replace("Exit code 0.", "").strip()
    if len(note) > 280:
        note = note[:279].rstrip() + "…"
    if state in ("done", "verified"):
        return f"{name} finished the step." + (f" {note}" if note else "")
    if state == "unverified":
        return f"{name} finished, but I could not verify the result." + (f" {note}" if note else "")
    if state == "denied":
        return f"{name} is waiting for your Allow, so I've paused this step."
    if state in _FAILED:
        return f"{name} could not finish the step ({state})." + (f" {note}" if note else "")
    return f"{name} reported {state}." + (f" {note}" if note else "")
