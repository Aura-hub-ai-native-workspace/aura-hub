"""Shared Context — one persistent, structured memory for every part of AURA.

Chat, the Planner, Workspace, workers, workflows and web research all need
the same facts: what the person is building, what they decided and
rejected, what was researched, which plan is current, what has been done
and what failed. This module is that memory's Python binding.

It is NOT a second store. The desktop's TypeScript services already keep a
per-project memory at ``<home>/memory/<projectId>.json``
(``packages/ai-service/src/memory.ts``: ``{id, kind, title, body, pinned,
at}``). This reads and writes that same file with the same record shape, so
a decision recorded here is visible to the TS intelligence pipeline and the
Memory screen, and the other way round. It extends the shape in two
backward-compatible ways: more ``kind`` values, and optional fields (``key``,
``taskId``, ``planId``, ``refs``, ``source``) that the TS side preserves
untouched.

Properties the rest of the system relies on:

* **Structured, not a transcript.** Records are typed (a goal, a decision, a
  research finding, a plan, an error…) and have a stable ``key`` when they
  should be updated in place (one "current plan" record, one record per
  error), so context does not grow by repetition.
* **Bounded retrieval.** ``package_for`` builds a context package that fits
  a stated character budget (derived from the receiving model's real limit),
  always keeping the load-bearing kinds (goal, requirements, decisions,
  conventions, rejected alternatives) and filling the rest by relevance.
* **Isolated.** One file per project id; ids are validated so one project's
  context can never be read through another's name or a path trick. General
  chat (no project) has its own scope, ``general``.
* **No secrets.** Everything written is passed through the same redactor the
  provider bridge uses, and credential-shaped keys are dropped.
* **Untrusted stays untrusted.** Research and anything from the web or a
  worker is rendered fenced as data, never as instructions.
"""

from __future__ import annotations

import re
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..config import aura_home
from ..jsonutil import read_json_file, write_json_atomic

try:  # POSIX advisory lock between the Python and Node processes.
    import fcntl  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — Windows: in-process lock only
    fcntl = None  # type: ignore[assignment]

#: Kinds the TypeScript store already writes.
LEGACY_KINDS = frozenset({
    "conversation", "decision", "code", "accepted", "rejected",
    "correction", "pinned", "learning", "diagnosis",
})
#: Kinds this service adds. Mirrored in packages/ai-service/src/memory.ts.
NEW_KINDS = frozenset({
    "goal", "requirement", "constraint", "convention", "architecture",
    "research", "plan", "execution", "environment", "error", "origin",
})
KINDS = LEGACY_KINDS | NEW_KINDS

#: Always part of a context package: they define what is being built and
#: what must not be revisited. Ordered by importance.
ALWAYS_KINDS = ("goal", "requirement", "constraint", "decision", "rejected",
                "convention", "architecture")
#: Content that came from outside AURA's own reasoning: fenced when rendered.
UNTRUSTED_KINDS = frozenset({"research", "error", "execution", "diagnosis", "code"})

GENERAL_SCOPE = "general"


def conversation_scope(session_id: str) -> str:
    """The scope of ONE general conversation: ``general.<session id>``.

    General chats do not share notes with each other; a conversation's context
    follows it only when it is adopted into a project (adopt_conversation).
    """
    return f"{GENERAL_SCOPE}.{session_id}"
MAX_ITEMS_PER_SCOPE = 2000
MAX_TITLE = 160
MAX_BODY = 4000
MAX_REFS = 12

_SCOPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
_STOP = frozenset(
    "the a an is are to of in on and or for how what where does do this that with it be".split())
_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|secret|token|password|passwd|authorization|credential)", re.IGNORECASE)
_SECRET_VALUE_RE = re.compile(
    # A key prefix must start a token: "task-create-notes-file" contains "sk-"
    # but is an identifier, not a credential.
    r"((?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}|(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}"
    r"|(?<![A-Za-z0-9])xox[abp]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,})")


class ContextError(ValueError):
    """A request the store refuses (bad scope, unknown kind)."""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _keywords(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", text.lower())
            if len(w) > 2 and w not in _STOP}


def scrub(text: str) -> str:
    """Remove credential-shaped values. Never raises."""
    return _SECRET_VALUE_RE.sub("[redacted]", text or "")


def _clean_refs(refs: object) -> list[dict]:
    out: list[dict] = []
    if not isinstance(refs, list):
        return out
    for r in refs[:MAX_REFS]:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or "").strip()
        if url and not url.lower().startswith(("http://", "https://")):
            continue
        ref = {"title": scrub(str(r.get("title") or ""))[:200], "url": url[:500]}
        if r.get("retrievedAt"):
            ref["retrievedAt"] = str(r["retrievedAt"])[:40]
        if r.get("excerpt"):
            ref["excerpt"] = scrub(str(r["excerpt"]))[:400]
        if ref["url"] or ref["title"]:
            out.append(ref)
    return out


class SharedContext:
    """Persistent structured context, one file per scope (project or general)."""

    def __init__(self, home: Path | str | None = None) -> None:
        self._home = Path(home) if home is not None else None
        self._guard = threading.RLock()

    # ── storage ──────────────────────────────────────────────────────────

    def _file(self, scope: str) -> Path:
        if not isinstance(scope, str) or not _SCOPE_RE.fullmatch(scope):
            raise ContextError("context scope must be a project id "
                               "(letters, digits, '.', '_', '-')")
        base = self._home if self._home is not None else aura_home()
        return Path(base) / "memory" / f"{scope}.json"

    def _read(self, scope: str) -> list[dict]:
        raw = read_json_file(self._file(scope), [])
        return [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []

    class _Locked:
        """Read-modify-write under a cross-process advisory lock."""

        def __init__(self, outer: SharedContext, scope: str) -> None:
            self.outer, self.scope = outer, scope
            self.fh = None

        def __enter__(self) -> list[dict]:
            self.outer._guard.acquire()
            path = self.outer._file(self.scope)
            path.parent.mkdir(parents=True, exist_ok=True)
            if fcntl is not None:
                self.fh = open(f"{path}.lock", "a+")  # noqa: SIM115
                fcntl.flock(self.fh, fcntl.LOCK_EX)
            return self.outer._read(self.scope)

        def __exit__(self, *exc: object) -> None:
            try:
                if self.fh is not None:
                    fcntl.flock(self.fh, fcntl.LOCK_UN)  # type: ignore[union-attr]
                    self.fh.close()
            finally:
                self.outer._guard.release()

    # ── writes ───────────────────────────────────────────────────────────

    def add(self, scope: str, kind: str, title: str, body: str = "", *,
            key: str | None = None, pinned: bool | None = None,
            refs: list[dict] | None = None, task_id: str | None = None,
            plan_id: str | None = None, source: str | None = None) -> dict:
        """Record one item. With ``key``, an existing record with that key is
        updated in place (and keeps its id and pinned state) instead of
        duplicated."""
        if kind not in KINDS:
            raise ContextError(f"unknown context kind: {kind!r}")
        title = scrub(str(title or "")).strip()[:MAX_TITLE]
        body = scrub(str(body or ""))[:MAX_BODY]
        if not title:
            raise ContextError("a context record needs a title")
        extra: dict[str, Any] = {}
        if key:
            extra["key"] = str(key)[:120]
        if refs:
            extra["refs"] = _clean_refs(refs)
        if task_id:
            extra["taskId"] = str(task_id)[:64]
        if plan_id:
            extra["planId"] = str(plan_id)[:96]
        if source:
            extra["source"] = str(source)[:40]
        with self._Locked(self, scope) as items:
            existing = None
            if key:
                existing = next((i for i in items if i.get("key") == extra["key"]), None)
            if existing is not None:
                existing.update({"kind": kind, "title": title, "body": body,
                                 "at": _now(), **extra})
                if pinned is not None:
                    existing["pinned"] = pinned
                item = existing
            else:
                item = {
                    "id": f"mem_{uuid.uuid4().hex[:12]}",
                    "kind": kind, "title": title, "body": body,
                    "pinned": bool(pinned) if pinned is not None else kind == "pinned",
                    "at": _now(), **extra,
                }
                items.append(item)
                if len(items) > MAX_ITEMS_PER_SCOPE:
                    # Drop the oldest unpinned, non-load-bearing records.
                    droppable = [i for i in items
                                 if not i.get("pinned") and i.get("kind") not in ALWAYS_KINDS]
                    droppable.sort(key=lambda i: str(i.get("at")))
                    for victim in droppable[:len(items) - MAX_ITEMS_PER_SCOPE]:
                        items.remove(victim)
            write_json_atomic(self._file(scope), items)
            return dict(item)

    def remove(self, scope: str, item_id: str) -> bool:
        with self._Locked(self, scope) as items:
            kept = [i for i in items if i.get("id") != item_id]
            if len(kept) == len(items):
                return False
            write_json_atomic(self._file(scope), kept)
            return True

    # ── reads ────────────────────────────────────────────────────────────

    def list(self, scope: str, kinds: set[str] | frozenset[str] | None = None,
             limit: int | None = None) -> list[dict]:
        items = self._read(scope)
        if kinds:
            items = [i for i in items if i.get("kind") in kinds]
        # Pinned first, then newest first.
        pinned = [i for i in items if i.get("pinned")]
        rest = sorted((i for i in items if not i.get("pinned")),
                      key=lambda i: str(i.get("at")), reverse=True)
        out = pinned + rest
        return out[:limit] if limit else out

    def get(self, scope: str, key: str) -> dict | None:
        return next((i for i in self._read(scope) if i.get("key") == key), None)

    def counts(self, scope: str) -> dict[str, int]:
        out: dict[str, int] = {}
        for i in self._read(scope):
            k = str(i.get("kind"))
            out[k] = out.get(k, 0) + 1
        return out

    def retrieve(self, scope: str, query: str = "", *, limit: int = 12,
                 kinds: set[str] | None = None, task_id: str | None = None,
                 plan_id: str | None = None) -> list[dict]:
        """The most relevant records for ``query``: load-bearing kinds first
        (newest first), then everything else by keyword overlap (pinned and
        recent break ties). Records tied to ``task_id``/``plan_id`` rank up."""
        items = self._read(scope)
        if kinds:
            items = [i for i in items if i.get("kind") in kinds]
        q = _keywords(query)

        def score(i: dict) -> float:
            kw = _keywords(f"{i.get('title', '')} {i.get('body', '')}")
            s = float(len(q & kw))
            if i.get("pinned"):
                s += 0.5
            if task_id and i.get("taskId") == task_id:
                s += 3
            if plan_id and i.get("planId") == plan_id:
                s += 2
            return s

        always = [i for i in items if i.get("kind") in ALWAYS_KINDS]
        # Newest first, then (stable) grouped by kind importance.
        always.sort(key=lambda i: str(i.get("at")), reverse=True)
        always.sort(key=lambda i: ALWAYS_KINDS.index(i["kind"]))
        taken = {i["id"] for i in always}
        relevant = sorted(
            (i for i in items if i.get("id") not in taken and score(i) > 0),
            key=lambda i: (score(i), str(i.get("at"))), reverse=True)
        return (always + relevant)[:limit]

    # ── bounded packages ─────────────────────────────────────────────────

    @staticmethod
    def render(items: list[dict], max_chars: int) -> tuple[str, int]:
        """Render records into at most ``max_chars``. Untrusted kinds are
        fenced and labelled as data. Returns ``(text, records_included)``;
        a record is included whole or not at all."""
        lines: list[str] = []
        used = 0
        included = 0
        for i in items:
            kind = str(i.get("kind"))
            head = f"[{kind}] {i.get('title', '')}"
            body = str(i.get("body") or "").strip()
            refs = i.get("refs") or []
            ref_line = ""
            if refs:
                ref_line = " Sources: " + "; ".join(
                    f"{r.get('title') or r.get('url')} <{r.get('url')}>" for r in refs[:4])
            text = f"{head}: {body}{ref_line}" if body else f"{head}{ref_line}"
            if kind in UNTRUSTED_KINDS:
                text = f'<untrusted-data kind="{kind}">{text}</untrusted-data>'
            if used + len(text) + 1 > max_chars:
                continue  # a shorter, later record may still fit
            lines.append(text)
            used += len(text) + 1
            included += 1
        return "\n".join(lines), included

    def package_for(self, scope: str, query: str = "", *, model_context_chars: int = 24_000,
                    share: float = 0.25, limit: int = 16,
                    task_id: str | None = None,
                    plan_id: str | None = None) -> dict:
        """A context package for one model call, sized to that model.

        ``model_context_chars`` is the receiving model's real limit (a
        provider spec's ``max_context_chars``); the package takes at most
        ``share`` of it, never less than 600 characters, never more than 12k.
        """
        budget = max(600, min(12_000, int(model_context_chars * share)))
        items = self.retrieve(scope, query, limit=limit, task_id=task_id, plan_id=plan_id)
        text, included = self.render(items, budget)
        return {"text": text, "records": included, "available": len(items),
                "budgetChars": budget, "scope": scope}

    # ── convenience writers the pipeline uses ────────────────────────────

    def note_turn(self, scope: str, user: str, answer: str, *,
                  session_id: str, refs: list[dict] | None = None) -> None:
        """Keep a short conversation summary + research metadata; never the
        full transcript (the session store already holds that)."""
        self.add(scope, "conversation", f"Q: {user.strip()[:120]}",
                 f"A: {answer.strip()[:600]}", key=f"turn:{session_id}:{uuid.uuid4().hex[:6]}",
                 refs=refs, source="chat")

    def record_origin(self, scope: str, *, idea: str, summary: str,
                      decisions: list[str], research: list[dict],
                      from_conversation: str | None) -> None:
        """Associate a new project with the conversation that produced it."""
        self.add(scope, "origin", "Original idea", idea[:1200], key="origin",
                 pinned=True, source=from_conversation or "chat")
        self.add(scope, "goal", "Project goal", idea[:1200], key="goal", pinned=True)
        if summary.strip():
            self.add(scope, "conversation", "Idea discussion summary",
                     summary[:3000], key="origin-summary", source=from_conversation or "chat")
        for n, text in enumerate(decisions[:12], 1):
            self.add(scope, "decision", text[:150], text, key=f"origin-decision:{n}")
        if research:
            self.add(scope, "research", "Research behind the idea",
                     "; ".join(r.get("title") or r.get("url", "") for r in research[:8]),
                     key="origin-research", refs=research)


__all__ = ["ALWAYS_KINDS", "ContextError", "GENERAL_SCOPE", "conversation_scope", "KINDS", "NEW_KINDS",
           "SharedContext", "scrub"]

