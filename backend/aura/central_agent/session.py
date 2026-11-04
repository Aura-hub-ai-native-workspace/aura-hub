"""Agent session persistence — durable session state under AURA_HOME.

Format follows the store conventions (pretty JSON, atomic write, tolerant
read). Persisted content is deliberately narrow: identity, state,
conversation messages, plan/result references and an event tail. NEVER
persisted: secrets, provider credentials, raw prompts/completions, or any
tool output beyond what the Fabric already redacted.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

from ..config import aura_home
from ..contracts import AgentEvent, AgentMessage, AgentResult, AgentSession
from ..jsonutil import read_json_file, write_json_atomic

logger = logging.getLogger(__name__)


_APPROVAL_REMOVED = (
    "This request was waiting for an approval that no longer exists in AURA Hub, "
    "so nothing ran. Submit the request again.")


def migrate_legacy_approval_state(raw: dict) -> dict:
    """Sessions written before the approval workflow was removed may hold a
    parked state. The work they were waiting on never ran, so they are
    recorded as failed with that reason. Nothing is ever marked completed
    or verified by this migration."""
    if raw.get("state") == "awaiting-approval":
        raw["state"] = "failed"
    if raw.get("orchestrationState") == "awaiting-approval":
        raw["orchestrationState"] = "failed"
    queue = raw.get("taskQueue")
    if isinstance(queue, list):
        for entry in queue:
            if isinstance(entry, dict) and entry.get("state") == "awaiting-approval":
                entry["state"] = "failed"
    last = raw.get("lastResult")
    if isinstance(last, dict) and last.get("outcome") == "awaiting-approval":
        raw["lastResult"] = {**last, "status": "failed", "outcome": "failed",
                             "failureReason": "approval-workflow-removed",
                             "summary": _APPROVAL_REMOVED}
    return raw


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AgentSessionStore:
    def __init__(self, home: Path | None = None, tail_limit: int = 50) -> None:
        self._home = home
        self._tail_limit = tail_limit
        self._last_id: str | None = None

    def _dir(self) -> Path:
        return (self._home or aura_home()) / "agent" / "sessions"

    def create(self, project_id: str | None,
               session_id: str | None = None) -> AgentSession:
        """Create a session, optionally under a caller-supplied id.

        A client that needs the id BEFORE the first run settles (live
        event subscription, early cancellation) may propose one shaped
        exactly like a server id (`agt-` + 12 hex chars). Anything else
        — wrong shape, or an id already taken — falls back to a fresh
        server id, so a caller can never hijack or overwrite a session.
        """
        import re as _re

        ts = _now()
        sid = None
        if isinstance(session_id, str) and _re.fullmatch(
                r"agt-[0-9a-f]{12}", session_id):
            if self.load(session_id) is None:
                sid = session_id
        if sid is None:
            sid = f"agt-{uuid.uuid4().hex[:12]}"
        return AgentSession(
            sessionId=sid,
            projectId=project_id,
            createdAt=ts,
            updatedAt=ts,
        )

    @property
    def last_session_id(self) -> str | None:
        """Most recently saved session — convenience for request/response APIs."""
        return self._last_id

    def save(self, session: AgentSession) -> Path:
        self._last_id = session.sessionId
        path = self._dir() / f"{session.sessionId}.json"
        # Full dump (not wire()'s exclude_unset): agent sessions are mutated
        # in place, so defaulted fields legitimately change after construction.
        write_json_atomic(path, session.model_dump(by_alias=True))
        return path

    def load(self, session_id: str) -> AgentSession | None:
        """The session, or None. None is a plain 'no such session' only when
        the file is absent; a file that exists but cannot be read or validated
        is logged, because callers otherwise see the session vanish with no
        trace (the 404 'no such session' that hid a parked approval)."""
        path = self._dir() / f"{session_id}.json"
        raw = read_json_file(path, None)
        if isinstance(raw, dict):
            raw = migrate_legacy_approval_state(raw)
        if not isinstance(raw, dict):
            if path.exists():
                logger.error("agent session %s exists but is not a readable JSON object: %s",
                             session_id, path)
            return None
        try:
            return AgentSession.model_validate(raw)
        except Exception as exc:  # noqa: BLE001 — reported, not swallowed
            first = str(exc).strip().splitlines()[0][:300] if str(exc).strip() else type(exc).__name__
            logger.error("agent session %s failed schema validation and cannot be loaded: %s",
                         session_id, first)
            return None

    def append_message(self, session: AgentSession, role: str, content: str) -> AgentSession:
        session.messages.append(AgentMessage(role=role, content=content, at=_now()))
        session.updatedAt = _now()
        return session

    def record_event(self, session: AgentSession, event: AgentEvent) -> AgentSession:
        session.eventCount += 1  # full tails live with the event bus; the file keeps a count
        session.updatedAt = _now()
        return session

    def finish(self, session: AgentSession, result: AgentResult) -> AgentSession:
        session.lastResult = result
        session.state = result.status
        session.updatedAt = _now()
        return session
