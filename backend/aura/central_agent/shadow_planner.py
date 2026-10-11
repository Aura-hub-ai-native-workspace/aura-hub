"""Laya shadow planner — a candidate plan, recorded and never executed.

Laya is AURA's planning model. In SHADOW mode it proposes a plan for the
same request the authoritative TaskPlanner has already planned, and the
two are compared. Nothing Laya produces can reach execution:

- The candidate is validated by ``TaskPlanner.plan_from_model``, which is
  pure: it reads the capability and node registries and builds an object.
  It performs no dispatch, approval, permission or persistence.
- The candidate is written to an evidence record. It is never returned to
  the caller, never stored in the session's ``activePlan``, and the record
  carries ``executed: False`` as a literal.
- Failures (model unavailable, unusable output, schema rejection, internal
  error) are captured in the record. They never raise into the request.
- Shadow runs use their own ``RoutedModelPort`` instance when one can be
  built, so shadow failures cannot open a circuit or change the health
  state the authoritative planner depends on.

Disabled by default. Enable with ``AURA_LAYA_SHADOW=1``.

Comparison reports raw, separately-named measures, not a single quality
score. A score would hide which dimension disagrees.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from ..config import aura_home
from ..contracts import AgentIntent, TaskPlan
from ..jsonutil import read_json_file, write_json_atomic
from .planner import PlanningError
from .provider_bridge import ProviderBridge, redact_secrets

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
ENV_FLAG = "AURA_LAYA_SHADOW"
#: Bounded: one initial call plus at most one retry on a transient failure.
MAX_ATTEMPTS = 2
#: Oldest records are pruned beyond this many, across all sessions.
RECORD_CAP = 200

#: Categories where retrying cannot help. Configuration, not transience.
_PERMANENT = frozenset({
    "PROVIDER_NOT_CONFIGURED", "PROVIDER_UNSUPPORTED", "MODEL_NOT_CONFIGURED",
})

ShadowStatus = Literal[
    "validated", "schema-rejected", "model-failed", "internal-error"]

_SAFE_ID = re.compile(r"[^A-Za-z0-9_.-]")


def shadow_enabled(env: dict[str, str] | None = None) -> bool:
    """True only for an explicit opt-in. Anything else is off."""
    value = (env if env is not None else os.environ).get(ENV_FLAG, "")
    return value.strip().lower() in ("1", "true", "yes", "on")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ShadowPlanRecord(BaseModel):
    """Typed evidence for one shadow planning attempt. ``extra=forbid`` so
    a record cannot grow fields that were never reviewed."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: int = SCHEMA_VERSION
    shadowId: str
    sessionId: str
    requestId: str | None = None
    authoritativePlanId: str | None = None
    createdAt: str
    purpose: Literal["shadow-plan"] = "shadow-plan"
    provider: str = "unknown"
    model: str = "unknown"
    latencyMs: float | None = None
    attempts: int = 0
    status: ShadowStatus
    errorCategory: str | None = None
    error: str | None = None
    candidate: dict | None = None
    candidateSummary: dict | None = None
    comparison: dict | None = None
    governance: dict | None = None
    executed: Literal[False] = False


def summarize_plan(plan: TaskPlan) -> dict[str, Any]:
    """Structural measures of a plan. Identical inputs give identical output."""
    tasks = list(plan.tasks)
    cap_of = {t.id: (t.capabilityId or "") for t in tasks}
    edges = sorted(
        [cap_of.get(dep, ""), cap_of[t.id]]
        for t in tasks for dep in t.dependsOn)
    covered: set[str] = set()
    for criterion in plan.acceptance or []:
        named = (criterion.expect or {}).get("tasks")
        covered.update(named if named is not None else cap_of.keys())
    return {
        "taskCount": len(tasks),
        "capabilities": sorted(cap_of.values()),
        "dependencyEdges": edges,
        "workerRoles": sorted(t.workerRole or "" for t in tasks),
        "nodePins": sorted(t.nodeId or "" for t in tasks),
        "highRiskTasks": sum(1 for t in tasks if t.risk == "high"),
        "acceptanceCriteria": len(plan.acceptance or []),
        "acceptanceCoverage": round(len(covered & set(cap_of)) / len(tasks), 3)
        if tasks else 0.0,
    }


def compare_summaries(authoritative: dict, candidate: dict) -> dict[str, Any]:
    """Per-dimension agreement between two plan summaries. Raw measures only."""
    return {
        "taskCountDelta": candidate["taskCount"] - authoritative["taskCount"],
        "sameCapabilities": candidate["capabilities"] == authoritative["capabilities"],
        "sameDependencyStructure": candidate["dependencyEdges"] == authoritative["dependencyEdges"],
        "sameWorkerRoles": candidate["workerRoles"] == authoritative["workerRoles"],
        "sameNodePins": candidate["nodePins"] == authoritative["nodePins"],
        "sameHighRiskCount": candidate["highRiskTasks"] == authoritative["highRiskTasks"],
        "acceptanceCoverageAuthoritative": authoritative["acceptanceCoverage"],
        "acceptanceCoverageCandidate": candidate["acceptanceCoverage"],
    }


class ShadowPlanStore:
    """Shadow records as JSON files under the AURA home.

    Layout: ``<home>/agent/shadow_plans/<sessionId>/<shadowId>.json``. The
    session directory is sanitized so an id cannot escape the store root.
    Files are owner-readable only and pruned to ``max_records``.
    """

    def __init__(self, home: Path | None = None,
                 max_records: int = RECORD_CAP) -> None:
        self._home = home
        self._max = max_records

    @property
    def root(self) -> Path:
        return (self._home or aura_home()) / "agent" / "shadow_plans"

    def _session_dir(self, session_id: str) -> Path:
        return self.root / (_SAFE_ID.sub("-", session_id) or "session")

    def write(self, record: ShadowPlanRecord) -> Path:
        path = self._session_dir(record.sessionId) / f"{record.shadowId}.json"
        write_json_atomic(path, record.model_dump())
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        self._prune()
        return path

    def list(self, session_id: str | None = None) -> list[dict]:
        base = self._session_dir(session_id) if session_id else self.root
        if not base.exists():
            return []
        out = []
        for path in sorted(base.rglob("*.json")):
            value = read_json_file(path, None)
            if isinstance(value, dict):
                out.append(value)
        return out

    def _prune(self) -> None:
        if not self.root.exists():
            return
        files = sorted(self.root.rglob("*.json"),
                       key=lambda p: p.stat().st_mtime)
        for stale in files[:max(0, len(files) - self._max)]:
            try:
                stale.unlink()
            except OSError:
                pass


def isolated_port(port: Any) -> Any:
    """A separate RoutedModelPort over the same provider specs, when possible.

    Own health, circuit and telemetry state: a shadow failure cannot open a
    circuit the authoritative planner would then see. Ports that are not
    RoutedModelPort (tests, scripted ports) are returned unchanged.
    """
    from .model_routing import RoutedModelPort

    if isinstance(port, RoutedModelPort):
        return RoutedModelPort(list(port.providers),
                               sovereign_policy=getattr(port, "_sovereign_policy", None),
                               post=getattr(port, "_post", None))
    return port


class ShadowPlanner:
    """Runs candidate planning in the background and records the outcome."""

    def __init__(self, port: Any, store: ShadowPlanStore, *,
                 enabled: bool = True, max_attempts: int = MAX_ATTEMPTS) -> None:
        self.port = port
        self.store = store
        self.enabled = bool(enabled and port is not None)
        self.max_attempts = max(1, min(int(max_attempts), MAX_ATTEMPTS))
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laya-shadow")

    def observe(self, *, intent: AgentIntent, system: str, user: str,
                session_id: str, request_id: str | None,
                authoritative_plan: TaskPlan | None,
                planner: Any) -> Future | None:
        """Schedule one shadow run. Returns None when disabled.

        The return value is for tests and diagnostics only. Callers must not
        use it to make decisions: nothing it produces is a plan to execute.
        """
        if not self.enabled:
            return None
        return self._pool.submit(
            self._job, intent, system, user, session_id, request_id,
            authoritative_plan, planner)

    def wait(self, timeout: float | None = None) -> None:
        """Block until queued shadow work drains. Tests use this; production does not."""
        self._pool.submit(lambda: None).result(timeout=timeout)

    # ── background job ───────────────────────────────────────────────

    def _job(self, intent, system, user, session_id, request_id,
             authoritative_plan, planner) -> ShadowPlanRecord:
        base = {"shadowId": f"shadow-{uuid.uuid4().hex[:12]}",
                "sessionId": session_id, "requestId": request_id,
                "authoritativePlanId": getattr(authoritative_plan, "planId", None),
                "createdAt": _now()}
        try:
            record = self._evaluate(base, intent, system, user, session_id,
                                    request_id, authoritative_plan, planner)
        except Exception as exc:  # noqa: BLE001 — shadow must never escape
            record = ShadowPlanRecord(
                **base, status="internal-error",
                errorCategory="INTERNAL", error=_clip(f"{type(exc).__name__}: {exc}"))
        try:
            self.store.write(record)
        except Exception:  # noqa: BLE001 — a write failure is logged, not raised
            logger.warning("shadow plan record could not be written", exc_info=True)
        return record

    def _evaluate(self, base, intent, system, user, session_id, request_id,
                  authoritative_plan, planner) -> ShadowPlanRecord:
        bridge = ProviderBridge(self.port)
        result = None
        attempts = 0
        for attempts in range(1, self.max_attempts + 1):
            result = bridge.complete_json("plan", system, user,
                                          session_id=session_id, request_id=request_id)
            if result.ok or result.error_category in _PERMANENT:
                break
        assert result is not None
        identity = {"provider": result.provider, "model": result.model,
                    "latencyMs": result.latencyMs, "attempts": attempts}
        if not result.ok:
            return ShadowPlanRecord(
                **base, **identity, status="model-failed",
                errorCategory=result.error_category,
                error=_clip(result.error))

        proposal = result.data
        try:
            candidate = planner.plan_from_model(intent, session_id, _now(), proposal)
        except PlanningError as exc:
            return ShadowPlanRecord(
                **base, **identity, status="schema-rejected",
                errorCategory="SCHEMA", error=_clip(str(exc)),
                candidate=redact_secrets(proposal))
        except Exception as exc:  # noqa: BLE001
            return ShadowPlanRecord(
                **base, **identity, status="schema-rejected",
                errorCategory="SCHEMA",
                error=_clip(f"{type(exc).__name__}: {exc}"),
                candidate=redact_secrets(proposal))

        summary = summarize_plan(candidate)
        return ShadowPlanRecord(
            **base, **identity, status="validated",
            candidate=redact_secrets(proposal),
            candidateSummary=summary,
            comparison=(compare_summaries(summarize_plan(authoritative_plan), summary)
                        if authoritative_plan is not None else None),
            governance=_governance(candidate, planner))


def _governance(candidate: TaskPlan, planner: Any) -> dict[str, Any]:
    """Checks the candidate against the same registries the authority uses.
    These are observations. They grant nothing and reject nothing here."""
    known_caps = planner.known_capability_ids()
    known_nodes = planner.known_node_ids()
    caps = {t.capabilityId for t in candidate.tasks if t.capabilityId}
    nodes = {t.nodeId for t in candidate.tasks if t.nodeId}
    try:
        type(planner).validate(candidate)
        structurallyValid = True
    except PlanningError:
        structurallyValid = False
    return {
        "capabilitiesKnown": caps <= known_caps,
        "nodePinsKnown": nodes <= known_nodes,
        "structureValid": structurallyValid,
        # An observation for review. Approval is decided by the authority
        # layer, never by this record.
        "highRiskTaskPresent": any(t.risk == "high" for t in candidate.tasks),
    }


def _clip(text: str | None, limit: int = 300) -> str | None:
    if text is None:
        return None
    return str(redact_secrets(text))[:limit]
