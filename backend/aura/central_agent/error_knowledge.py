"""Error knowledge — what went wrong before, written down so it is not rediscovered.

Every meaningful execution error becomes a small Markdown file in
``<project>/.aura/errors/``. Markdown on purpose: any worker, any person,
any tool can read it with no AURA code, and it travels with the project.
Each file is also indexed into Shared Context (kind ``error``) so the
coordinator, the Planner and later workers retrieve it by relevance before
they start similar work.

Honesty rules, enforced here rather than hoped for:

* A **root cause** is written only when the caller says it was established;
  otherwise the file says "Not established." A guess is never recorded as a
  cause.
* A **resolution** is written only with verification evidence. Without
  evidence the record stays ``open`` (or ``workaround`` if one was tried) —
  a workaround is never promoted to a verified fix.
* **Sanitized**: credentials are redacted, ANSI/control characters removed,
  the user's home directory abbreviated, and the diagnostic is length-bounded
  so a noisy log cannot bury the record or leak into it.
* One file per error, written atomically; IDs are stable and unique.

The directory carries its own ``.gitignore`` (``*``) so recording errors
never dirties the person's repository; delete the files whenever you like.
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .shared_context import SharedContext, scrub

ERROR_DIR = Path(".aura") / "errors"
MAX_DIAGNOSTIC = 1500
MAX_FILES_SCANNED = 300
STATUSES = ("open", "workaround", "resolved")
CLASSES = ("quota", "auth", "network", "timeout", "malformed", "ordinary",
           "scope", "verification", "unavailable", "unknown")

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f]")
_STOP = frozenset("the a an is are to of in on and or for how what where this that with it be".split())


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sanitize(text: str, limit: int = MAX_DIAGNOSTIC) -> str:
    """Safe-to-store diagnostic text."""
    text = _ANSI.sub("", str(text or ""))
    home = str(Path.home())
    if home and home != "/":
        text = text.replace(home, "~")
    text = scrub(text)
    text = re.sub(r"[ \t]+\n", "\n", text).strip()
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "error"


def _words(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if len(w) > 2 and w not in _STOP}


class ErrorKnowledge:
    """The error records of one project folder."""

    def __init__(self, project_root: str | Path, *, project_id: str | None = None,
                 shared: SharedContext | None = None) -> None:
        self.root = Path(project_root)
        self.dir = self.root / ERROR_DIR
        self.project_id = project_id
        self.shared = shared

    # ── write ────────────────────────────────────────────────────────────

    def record(self, *, summary: str, diagnostic: str = "", error_class: str = "unknown",
               task_id: str | None = None, plan_id: str | None = None,
               session_id: str | None = None, worker: str | None = None,
               tool: str | None = None, root_cause: str | None = None,
               recovery_attempt: str | None = None) -> dict:
        """Write one record. ``root_cause`` means ESTABLISHED cause — leave it
        None when it is only a suspicion."""
        error_class = error_class if error_class in CLASSES else "unknown"
        rid = f"err-{uuid.uuid4().hex[:10]}"
        fields = {
            "id": rid, "status": "open", "recorded": _now(), "class": error_class,
            "project": self.project_id or self.root.name, "task": task_id or "",
            "plan": plan_id or "", "session": session_id or "",
            "worker": worker or "", "tool": tool or "",
        }
        body = {
            "summary": sanitize(summary, 200) or "Unspecified error",
            "diagnostic": sanitize(diagnostic),
            "root_cause": sanitize(root_cause, 600) if root_cause else "",
            "recovery": sanitize(recovery_attempt, 600) if recovery_attempt else "",
            "resolution": "", "evidence": "",
        }
        path = self.dir / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{_slug(task_id or body['summary'])}-{rid[4:]}.md"
        self._write(path, fields, body)
        self._index(fields, body, path)
        return {**fields, **body, "path": str(path.relative_to(self.root))}

    def resolve(self, record_id: str, *, resolution: str, evidence: str,
                root_cause: str | None = None) -> dict | None:
        """Mark a record resolved — only with verification ``evidence``.
        Without it the record becomes at most a ``workaround``."""
        found = self._find(record_id)
        if found is None:
            return None
        path, fields, body = found
        body["resolution"] = sanitize(resolution, 600)
        if root_cause:
            body["root_cause"] = sanitize(root_cause, 600)
        if evidence and evidence.strip():
            body["evidence"] = sanitize(evidence, 600)
            fields["status"] = "resolved"
        else:
            body["evidence"] = ""
            fields["status"] = "workaround"
        fields["updated"] = _now()
        self._write(path, fields, body)
        self._index(fields, body, path)
        return {**fields, **body, "path": str(path.relative_to(self.root))}

    # ── read ─────────────────────────────────────────────────────────────

    def all(self) -> list[dict]:
        if not self.dir.is_dir():
            return []
        out = []
        for path in sorted(self.dir.glob("*.md"), reverse=True)[:MAX_FILES_SCANNED]:
            parsed = self._parse(path)
            if parsed:
                fields, body = parsed
                out.append({**fields, **body, "path": str(path.relative_to(self.root))})
        return out

    def retrieve(self, query: str, limit: int = 4) -> list[dict]:
        """Records relevant to ``query``, resolved ones first: a verified
        resolution is the most useful thing to know before starting."""
        q = _words(query)
        scored = []
        for rec in self.all():
            overlap = len(q & _words(f"{rec['summary']} {rec['diagnostic']} {rec['class']} {rec.get('worker', '')}"))
            if overlap == 0:
                continue
            scored.append((overlap + (1.5 if rec["status"] == "resolved" else 0), rec["recorded"], rec))
        scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
        return [r for _s, _t, r in scored[:limit]]

    @staticmethod
    def brief(records: list[dict]) -> str:
        """The records as a short block for a worker brief — marked as data."""
        if not records:
            return ""
        lines = ["KNOWN ISSUES FROM EARLIER WORK ON THIS PROJECT (recorded data; verify before relying on it):"]
        for r in records:
            line = f"- [{r['status']}] {r['summary']}"
            if r["status"] == "resolved" and r.get("resolution"):
                line += f" — resolved by: {r['resolution']}"
            elif r["status"] == "workaround" and r.get("resolution"):
                line += f" — workaround tried (NOT verified): {r['resolution']}"
            elif r.get("root_cause"):
                line += f" — cause: {r['root_cause']}"
            lines.append(line[:400])
        return "\n".join(lines)

    # ── file format ──────────────────────────────────────────────────────

    def _ensure_dir(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        gi = self.dir.parent / ".gitignore"
        if not gi.exists():
            gi.write_text("*\n", encoding="utf-8")

    def _write(self, path: Path, fields: dict, body: dict) -> None:
        self._ensure_dir()
        meta = "\n".join(f"- **{k}:** {v}" for k, v in fields.items() if v != "")
        text = (
            f"# {body['summary']}\n\n{meta}\n\n"
            f"## What happened\n\n{body['diagnostic'] or '(no diagnostic captured)'}\n\n"
            f"## Root cause\n\n{body['root_cause'] or 'Not established.'}\n\n"
            f"## Recovery attempt\n\n{body['recovery'] or 'None recorded.'}\n\n"
            f"## Resolution\n\n{body['resolution'] or 'Not resolved.'}\n\n"
            f"## Verification evidence\n\n{body['evidence'] or 'None.'}\n")
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)

    _FIELD = re.compile(r"^- \*\*([a-z]+):\*\* (.*)$")

    def _parse(self, path: Path) -> tuple[dict, dict] | None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        lines = text.splitlines()
        if not lines or not lines[0].startswith("# "):
            return None
        fields: dict[str, Any] = {}
        for line in lines[1:30]:
            m = self._FIELD.match(line)
            if m:
                fields[m.group(1)] = m.group(2)
        if "id" not in fields:
            return None
        sections: dict[str, str] = {}
        current = None
        buf: list[str] = []
        for line in lines:
            if line.startswith("## "):
                if current:
                    sections[current] = "\n".join(buf).strip()
                current, buf = line[3:].strip(), []
            elif current:
                buf.append(line)
        if current:
            sections[current] = "\n".join(buf).strip()

        def sect(name: str, empty: str) -> str:
            v = sections.get(name, "")
            return "" if v in (empty, "") else v

        body = {
            "summary": lines[0][2:].strip(),
            "diagnostic": sect("What happened", "(no diagnostic captured)"),
            "root_cause": sect("Root cause", "Not established."),
            "recovery": sect("Recovery attempt", "None recorded."),
            "resolution": sect("Resolution", "Not resolved."),
            "evidence": sect("Verification evidence", "None."),
        }
        return fields, body

    def _find(self, record_id: str) -> tuple[Path, dict, dict] | None:
        if not self.dir.is_dir() or not re.fullmatch(r"err-[0-9a-f]{10}", record_id or ""):
            return None
        for path in self.dir.glob(f"*-{record_id[4:]}.md"):
            parsed = self._parse(path)
            if parsed:
                return path, parsed[0], parsed[1]
        return None

    def _index(self, fields: dict, body: dict, path: Path) -> None:
        """Mirror the record into Shared Context so retrieval finds it."""
        if self.shared is None or not self.project_id:
            return
        try:
            self.shared.add(
                self.project_id, "error", body["summary"],
                f"status={fields['status']}; class={fields['class']}; "
                + (f"resolution: {body['resolution']}" if body["resolution"] else
                   f"diagnostic: {body['diagnostic'][:300]}")
                + f" (record: {path.relative_to(self.root)})",
                key=f"error:{fields['id']}", task_id=fields.get("task") or None,
                plan_id=fields.get("plan") or None, source="error-knowledge")
        except Exception:  # noqa: BLE001 — indexing must never lose the record itself
            pass


__all__ = ["CLASSES", "ERROR_DIR", "ErrorKnowledge", "STATUSES", "sanitize"]
