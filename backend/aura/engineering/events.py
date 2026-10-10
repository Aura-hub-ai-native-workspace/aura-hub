"""Engineering Event Store — append-only event log for engineering activities.

Events capture what happened in the engineering workspace:
- Artifact creation/update/verification
- Tool detection
- Capability requests/approvals
- Change impact detection
- Validation results

Events are append-only, like AURA's existing AuditStore.
They provide the data foundation for change impact tracking and
engineering activity timelines.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..config import aura_path
from ..jsonutil import dumps_compact
from .domain import (
    EngineeringEventRecord,
    EngineeringEventType,
    new_id,
)

MAX_EVENTS = 10000


class EngineeringEventStore:
    """Append-only engineering event store.

    Persistence: JSONL file (one event per line, like AuditStore).
    """

    def __init__(self, project_id: str, home: Path | None = None) -> None:
        self._project_id = project_id
        self._home = home or aura_path()
        self._dir = self._home / "engineering-events" / project_id
        self._file = self._dir / "events.jsonl"

    # ── Persistence ─────────────────────────────────────────────────────

    def _load_all(self) -> list[EngineeringEventRecord]:
        if not self._file.exists():
            return []
        records = []
        for line in self._file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                import json
                data = json.loads(line)
                records.append(EngineeringEventRecord.from_dict(data))
            except Exception:
                continue  # skip malformed lines
        return records[-MAX_EVENTS:]

    # ── Append ──────────────────────────────────────────────────────────

    def append(self, event: EngineeringEventRecord) -> None:
        """Append an event to the log."""
        self._dir.mkdir(parents=True, exist_ok=True)
        with open(self._file, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(dumps_compact(event.to_dict()) + "\n")

    def record(
        self,
        event_type: EngineeringEventType,
        project_id: str = "",
        actor: str = "",
        agent: str = "",
        capability: str = "",
        artifact_id: str = "",
        node_id: str = "",
        outcome: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> EngineeringEventRecord:
        """Create and append an event record."""
        event = EngineeringEventRecord(
            id=new_id("evt"),
            event_type=event_type,
            project_id=project_id or self._project_id,
            actor=actor,
            agent=agent,
            capability=capability,
            artifact_id=artifact_id,
            node_id=node_id,
            outcome=outcome,
            metadata=metadata or {},
        )
        self.append(event)
        return event

    # ── Queries ─────────────────────────────────────────────────────────

    def list_events(
        self,
        event_type: EngineeringEventType | None = None,
        artifact_id: str | None = None,
        node_id: str | None = None,
        agent: str | None = None,
        limit: int = 100,
    ) -> list[EngineeringEventRecord]:
        """Query events with optional filters."""
        events = self._load_all()
        if event_type:
            events = [e for e in events if e.event_type == event_type]
        if artifact_id:
            events = [e for e in events if e.artifact_id == artifact_id]
        if node_id:
            events = [e for e in events if e.node_id == node_id]
        if agent:
            events = [e for e in events if e.agent == agent]
        return events[-limit:]

    def events_for_artifact(self, artifact_id: str) -> list[EngineeringEventRecord]:
        """All events related to a specific artifact."""
        return self.list_events(artifact_id=artifact_id, limit=1000)

    def recent_events(self, limit: int = 20) -> list[EngineeringEventRecord]:
        """Most recent events."""
        return self.list_events(limit=limit)

    def count(self) -> int:
        if not self._file.exists():
            return 0
        return sum(1 for line in self._file.read_text(encoding="utf-8").splitlines() if line.strip())
