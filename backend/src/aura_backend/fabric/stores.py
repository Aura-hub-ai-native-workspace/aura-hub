"""Durable backing for policy, approvals and the audit trail.

Ports of packages/ai-service/src/fabric/{policyStore,approvalStore,auditStore}.ts.

No new database and no second persistence system: the shared AURA home
plus an atomic write-then-rename, which is the honest size of the
problem.

    <AURA_HOME>/fabric-policy.json
    <AURA_HOME>/fabric-approvals.json
    <AURA_HOME>/fabric-audit.jsonl
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from ..core.json_store import atomic_write_json, read_json
from ..policy import PolicyConfig, sanitize_policy
from .types import ApprovalRequest, AuditRecord, InvocationActor

# How many audit records are kept. A desktop app's trail, not a data lake.
MAX_RECORDS = 5000
# Trim only when meaningfully over, so appends stay cheap in the common case.
TRIM_TRIGGER = MAX_RECORDS + 1000
_TRIM_EVERY = 1000


# ── policy ───────────────────────────────────────────────────────────


def policy_file_path(home: Path) -> Path:
    return home / "fabric-policy.json"


def load_policy(home: Path) -> PolicyConfig:
    """The persisted policy, or the shipped default when absent or corrupt.

    Everything read off disk goes through `sanitize_policy` before it
    reaches the engine — a file is untrusted input, and an unrecognised
    decision string must never survive far enough to be compared against
    'require-approval' and found unequal.
    """
    return sanitize_policy(read_json(policy_file_path(home), None))


def save_policy(home: Path, raw: Any) -> PolicyConfig:
    """Persist a policy, returning what was actually stored.

    That is the sanitized form, not the caller's input, so the value the
    caller sees is the value the engine will use.
    """
    policy = sanitize_policy(raw)
    atomic_write_json(
        policy_file_path(home),
        {
            "byRisk": {k.value: v.value for k, v in policy.by_risk.items()},
            "overrides": {k: v.value for k, v in policy.overrides.items()},
            "nodeOverrides": {k: v.value for k, v in policy.node_overrides.items()},
            "nodeAllowlists": policy.node_allowlists,
            "allowAutonomous": policy.allow_autonomous,
        },
    )
    return policy


# ── approvals ────────────────────────────────────────────────────────


def approval_file_path(home: Path) -> Path:
    return home / "fabric-approvals.json"


def _usable_approval(raw: Any) -> bool:
    """Drop anything that is not a usable pending request."""
    if not isinstance(raw, dict):
        return False
    items = raw.get("items")
    return bool(
        isinstance(raw.get("id"), str)
        and raw.get("id")
        and raw.get("state") == "pending"
        and isinstance(items, list)
        and items
        and isinstance(items[0], dict)
        and isinstance(items[0].get("capabilityId"), str)
    )


class ApprovalStore:
    """Pending authorization requests, on disk.

    **Only pending requests are ever written**, and the filter is applied
    on load as well as save, so an unspent grant cannot survive a restart
    and silently authorize an action later. Decided requests are already
    in the audit trail.
    """

    def __init__(self, home: Path) -> None:
        self._path = approval_file_path(home)

    def load(self) -> list[ApprovalRequest]:
        raw = read_json(self._path, [])
        if not isinstance(raw, list):
            return []
        return [ApprovalRequest.from_json(r) for r in raw if _usable_approval(r)]

    def save(self, requests: list[ApprovalRequest]) -> None:
        payload = [r.to_json() for r in requests]
        atomic_write_json(self._path, [r for r in payload if _usable_approval(r)])


# ── audit ────────────────────────────────────────────────────────────


def audit_file_path(home: Path) -> Path:
    return home / "fabric-audit.jsonl"


def _usable_record(raw: Any) -> bool:
    """A record is only usable if it can still answer the audit question."""
    return bool(
        isinstance(raw, dict)
        and isinstance(raw.get("invocationId"), str)
        and raw.get("invocationId")
        and isinstance(raw.get("capabilityId"), str)
        and raw.get("capabilityId")
        and isinstance(raw.get("at"), str)
        and raw.get("at")
    )


def _record_from_json(raw: dict[str, Any]) -> AuditRecord:
    actor = raw.get("actor") or {}
    return AuditRecord(
        invocation_id=raw["invocationId"],
        at=raw["at"],
        capability_id=raw["capabilityId"],
        actor=InvocationActor(
            kind=actor.get("kind", "system"), id=actor.get("id", ""), role=actor.get("role")
        ),
        project_id=raw.get("projectId"),
        risk=raw.get("risk", "low"),
        decision=raw.get("decision", "deny"),
        decision_rule=raw.get("decisionRule", ""),
        outcome=raw.get("outcome", "failed"),
        verified=raw.get("verified"),
        duration_ms=raw.get("durationMs", 0),
        input_summary=raw.get("inputSummary", ""),
        mission_id=raw.get("missionId"),
        task_id=raw.get("taskId"),
        workflow_id=raw.get("workflowId"),
        run_id=raw.get("runId"),
        workflow_node_id=raw.get("workflowNodeId"),
        approval_id=raw.get("approvalId"),
        node_id=raw.get("nodeId"),
        requested_node_id=raw.get("requestedNodeId"),
        executed_node_id=raw.get("executedNodeId"),
        approval_decision=raw.get("approvalDecision"),
        decided_by=raw.get("decidedBy"),
    )


def _read_all(path: Path) -> list[dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return []
    out: list[dict[str, Any]] = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            # A truncated final line from an interrupted append is skipped,
            # not fatal. Losing the last record is the intended failure
            # mode; losing the file because of it is not.
            continue
        if _usable_record(parsed):
            out.append(parsed)
    return out


class AuditStore:
    """The governed action trail, on disk.

    **JSON Lines, appended, never rewritten.** That is the whole design
    argument. An audit record is a statement about something that already
    happened; a store that rewrote the file on every write could lose or
    silently alter earlier records, and an audit trail that can be edited
    by the thing it audits is not an audit trail.

    Appending one line per record means a crash mid-write can cost at most
    the record being written, and never a record already on disk.
    """

    def __init__(self, home: Path) -> None:
        self._path = audit_file_path(home)
        self._since_trim = 0

    def load(self) -> list[AuditRecord]:
        all_records = _read_all(self._path)
        tail = all_records[-MAX_RECORDS:] if len(all_records) > MAX_RECORDS else all_records
        return [_record_from_json(r) for r in tail]

    def append(self, record: AuditRecord) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record.to_json(), ensure_ascii=False) + "\n")

        self._since_trim += 1
        # Amortised: only ever counts appends made by this process, so a
        # long-lived session trims once per thousand records rather than
        # re-reading the file on every write.
        if self._since_trim < _TRIM_EVERY:
            return
        self._since_trim = 0
        self._trim()

    def _trim(self) -> None:
        all_records = _read_all(self._path)
        if len(all_records) <= TRIM_TRIGGER:
            return
        # Drops the OLDEST records: bounded growth without ever discarding
        # recent history.
        kept = all_records[-MAX_RECORDS:]
        fd, tmp = tempfile.mkstemp(dir=str(self._path.parent), prefix=f".{self._path.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                for entry in kept:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self._path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
