"""Agent session persistence — durable session state under AURA_HOME.

Format follows the store conventions (pretty JSON, atomic write, tolerant
read). Persisted content is deliberately narrow: identity, state,
conversation messages, plan/result references and an event tail. NEVER
persisted: secrets, provider credentials, raw prompts/completions, or any
tool output beyond what the Fabric already redacted.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

from ..config import aura_home
from ..contracts import AgentEvent, AgentMessage, AgentResult, AgentSession
from ..jsonutil import read_json_file, write_json_atomic


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class AgentSessionStore:
    def __init__(self, home: Path | None = None, tail_limit: int = 50) -> None:
        self._home = home
        self._tail_limit = tail_limit
        self._last_id: str | None = None

    def _dir(self) -> Path:
        return (self._home or aura_home()) / "agent" / "sessions"

    def create(self, project_id: str | None) -> AgentSession:
        ts = _now()
        return AgentSession(
            sessionId=f"agt-{uuid.uuid4().hex[:12]}",
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
        raw = read_json_file(self._dir() / f"{session_id}.json", None)
        if not isinstance(raw, dict):
            return None
        try:
            return AgentSession.model_validate(raw)
        except Exception:
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
