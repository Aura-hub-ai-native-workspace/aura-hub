"""Laya shadow planner — a candidate plan, recorded and never executed.

Laya is AURA's planning model. In SHADOW mode it proposes a plan for the
same request the authoritative TaskPlanner has already planned, and the
two are compared. Nothing Laya produces can reach execution:

- The candidate is validated by ``TaskPlanner.plan_from_model``, which is
  pure: it reads the capability and node registries and builds an object.
  It performs no dispatch, permission or persistence.
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

import json
import logging
import os
import re
import threading
import time
import uuid
from collections import deque
from concurrent.futures import Future
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict

from ..config import aura_home
from ..contracts import AgentIntent, TaskPlan
from ..jsonutil import read_json_file
from .intent import _NO_MODIFY_RE
from .planner import PlanningError
from .provider_bridge import _SENSITIVE_KEY_RE, ProviderBridge

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
ENV_FLAG = "AURA_LAYA_SHADOW"
#: Bounded: one initial call plus at most one retry on a transient failure.
MAX_ATTEMPTS = 2
#: Oldest records are pruned beyond this many, across all sessions.
RECORD_CAP = 200
#: At most this many shadow runs in flight. A slow model cannot build a backlog.
MAX_CONCURRENT = 2
#: Sliding-window budget of shadow runs per minute. Shares provider quota with
#: the authoritative planner, so it is capped deliberately.
MAX_PER_MINUTE = 10
#: The request text forwarded to the shadow model is bounded.
PROMPT_CHAR_CAP = 4000
#: Opt-in raw capture of unusable model replies (never on by default).
RAW_ENV_FLAG = "AURA_SHADOW_CAPTURE_RAW"
RAW_CAP_FILES = 50
RAW_CAP_CHARS = 65536

#: Categories where retrying cannot help. Configuration, not transience.
_PERMANENT = frozenset({
    "PROVIDER_NOT_CONFIGURED", "PROVIDER_UNSUPPORTED", "MODEL_NOT_CONFIGURED",
})

ShadowStatus = Literal[
    "validated", "schema-rejected", "model-failed", "internal-error", "skipped"]

_SAFE_ID = re.compile(r"[^A-Za-z0-9_.-]")


def shadow_enabled(env: dict[str, str] | None = None) -> bool:
    """True only for an explicit opt-in. Anything else is off."""
    value = (env if env is not None else os.environ).get(ENV_FLAG, "")
    return value.strip().lower() in ("1", "true", "yes", "on")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


#: Known secret SHAPES only. Plan identifiers and dependency labels are not
#: secrets, so the generic "long token-looking string" rule of redact_secrets
#: is deliberately NOT used here: it erased the very ids the evaluation needed
#: to show (see PR #68 evaluation, three invalid candidates).
_SECRET_SHAPES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=\-]{8,}", re.IGNORECASE),
    re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*\S+"),
    re.compile(r"\b[A-Fa-f0-9]{40,}\b"),
]


def scrub_text(text: str) -> str:
    """Replace secret-shaped substrings. Identifiers and labels are untouched."""
    out = text
    for pattern in _SECRET_SHAPES:
        out = pattern.sub("[REDACTED]", out)
    return out


def scrub_structure(value: Any) -> Any:
    """Recursively scrub a candidate or proposal before it is stored.

    Values under secret-named keys are replaced whole. Strings are scrubbed
    for known secret shapes. Everything else (ids, dependsOn labels,
    capability ids, node ids) is kept, so a reviewer can see what the model
    actually proposed.
    """
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if _SENSITIVE_KEY_RE.search(str(k))
                    else scrub_structure(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub_structure(v) for v in value]
    if isinstance(value, str):
        return scrub_text(value)
    return value


#: Rejection reasons, classified from the validator's own messages. Used to
#: count WHY candidates fail, not only that they did.
_REJECTION_PATTERNS = [
    ("unknown-dependency", re.compile(r"depends on unknown")),
    ("self-dependency", re.compile(r"depends on itself")),
    ("dependency-cycle", re.compile(r"cycle")),
    ("duplicate-id", re.compile(r"duplicate")),
    ("acceptance-unknown-task", re.compile(r"acceptance covers unknown")),
    ("unknown-capability", re.compile(r"unknown capability")),
    ("unsupported-field", re.compile(r"unsupported fields")),
    ("scope-widening", re.compile(r"expands beyond")),
    ("duplicate-scope", re.compile(r"repeats a scope path")),
    ("unbounded-scope", re.compile(
        r"not a bounded|scopePaths|scope paths?|non-string scope")),
    ("invalid-node", re.compile(r"nodeId|node", re.IGNORECASE)),
]


def classify_rejection(message: str) -> str:
    for label, pattern in _REJECTION_PATTERNS:
        if pattern.search(message):
            return label
    return "other"


#: Verbs a read-only request may use for a direct capability. Allowlist, so
#: an unknown or new capability is refused under a read-only constraint.
READ_ONLY_VERBS = frozenset({
    "status", "list", "read", "inspect", "search", "get", "show", "describe",
    "view", "find", "diff", "log", "query", "info", "check", "summarize",
})
READ_ONLY_ROLE = "research"


def read_only_request(intent: AgentIntent, user: str,
                      authoritative_plan: TaskPlan | None) -> bool:
    """A request is read-only when the user states a no-modify constraint,
    or when the authority itself plans only research delegations. The
    authority's classification is reused, not a second policy."""
    text = " ".join([intent.goal, *intent.constraints, user])
    if _NO_MODIFY_RE.search(text):
        return True
    if authoritative_plan is None:
        return False
    delegated = [t for t in authoritative_plan.tasks
                 if t.capabilityId == "agent.delegate"]
    return bool(delegated) and all(
        t.workerRole == READ_ONLY_ROLE for t in delegated)


def read_only_conflict(candidate: TaskPlan) -> tuple[str, str] | None:
    """The first way a candidate breaks a read-only constraint, as (class,
    message), or None. Fails closed: only research delegations and read-verb
    direct capabilities pass. Nothing is rewritten."""
    for task in candidate.tasks:
        if task.capabilityId == "agent.delegate":
            if task.workerRole != READ_ONLY_ROLE:
                label = ("read-only-role" if task.workerRole
                         else "read-only-unset-role")
                return label, (
                    f"read-only request: task {task.id} uses worker role "
                    f"{task.workerRole!r}; only {READ_ONLY_ROLE!r} is allowed")
        else:
            verb = (task.capabilityId or "").rsplit(".", 1)[-1]
            if verb not in READ_ONLY_VERBS:
                return "read-only-capability", (
                    f"read-only request: task {task.id} uses capability "
                    f"{task.capabilityId!r}, which is not a read capability")
    return None


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
    #: Sizes, offsets and status words about an unusable reply. Never text.
    diagnostics: dict | None = None
    #: Relative path of an opt-in raw capture, when one was written.
    rawCapturePath: str | None = None
    #: Redacted, read-only candidate snapshot for this request (see sovereign.shadow_view).
    candidateView: dict | None = None
    #: "ok", "no-candidates", "not-provided", or "unavailable: <bounded reason>".
    candidateViewStatus: str | None = None
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
        directory = self._session_dir(record.sessionId)
        # Owner-only from creation. Creating the file with the default mode and
        # chmod-ing afterwards leaves a window where candidate text is readable.
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        os.chmod(directory, 0o700)
        path = directory / f"{record.shadowId}.json"
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(record.model_dump(), ensure_ascii=False,
                                indent=2, sort_keys=True))
        os.replace(tmp, path)
        os.chmod(path, 0o600)
        self._prune()
        return path

    def write_raw(self, record_session: str, shadow_id: str,
                  text: str) -> str:
        """Opt-in capture of an unusable reply. Scrubbed, capped, owner-only,
        and the oldest captures are removed past RAW_CAP_FILES. Returns the
        path relative to the store root."""
        directory = self._session_dir(record_session)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        os.chmod(directory, 0o700)
        path = directory / f"{shadow_id}.raw.txt"
        body = scrub_text(text)[:RAW_CAP_CHARS]
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
        raws = sorted(self.root.rglob("*.raw.txt"),
                      key=lambda p: p.stat().st_mtime)
        for old in raws[:-RAW_CAP_FILES]:
            old.unlink(missing_ok=True)
        return str(path.relative_to(self.root))

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


def _new_base(session_id: str, request_id: str | None,
              authoritative_plan: TaskPlan | None) -> dict[str, Any]:
    return {"shadowId": f"shadow-{uuid.uuid4().hex[:12]}",
            "sessionId": session_id, "requestId": request_id,
            "authoritativePlanId": getattr(authoritative_plan, "planId", None),
            "createdAt": _now()}


class ShadowPlanner:
    """Runs candidate planning in the background and records the outcome.

    Bounded three ways: at most ``max_concurrent`` runs in flight, at most
    ``max_per_minute`` runs started per sliding minute, and each run makes at
    most ``max_attempts`` model calls. Work over budget is recorded as
    ``skipped`` rather than queued. Threads are daemons, so a stalled provider
    cannot hold process exit.
    """

    def __init__(self, port: Any, store: ShadowPlanStore, *,
                 enabled: bool = True, max_attempts: int = MAX_ATTEMPTS,
                 max_concurrent: int = MAX_CONCURRENT,
                 max_per_minute: int = MAX_PER_MINUTE,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.port = port
        self.store = store
        self.enabled = bool(enabled and port is not None)
        self.max_attempts = max(1, min(int(max_attempts), MAX_ATTEMPTS))
        self._slots = threading.BoundedSemaphore(max(1, int(max_concurrent)))
        self._max_per_minute = max(1, int(max_per_minute))
        self._clock = clock
        self._lock = threading.Lock()
        self._started: deque[float] = deque()
        self._threads: list[threading.Thread] = []
        self.skipped = 0

    def _admit(self) -> bool:
        now = self._clock()
        with self._lock:
            while self._started and now - self._started[0] >= 60.0:
                self._started.popleft()
            if len(self._started) >= self._max_per_minute:
                return False
            if not self._slots.acquire(blocking=False):
                return False
            self._started.append(now)
            return True

    def observe(self, *, intent: AgentIntent, system: str, user: str,
                session_id: str, request_id: str | None,
                authoritative_plan: TaskPlan | None,
                planner: Any,
                candidate_view_provider: Callable[[], Any] | None = None) -> Future | None:
        """Schedule one shadow run. Returns None when disabled.

        The Future is for tests and diagnostics only. Callers must not use it
        to make decisions: nothing it resolves to is a plan to execute.
        """
        if not self.enabled:
            return None
        user = scrub_text(user)[:PROMPT_CHAR_CAP]
        base = _new_base(session_id, request_id, authoritative_plan)
        future: Future = Future()
        if not self._admit():
            self.skipped += 1
            record = ShadowPlanRecord(
                **base, status="skipped", errorCategory="BUDGET",
                error="shadow budget exhausted (concurrency or rate limit)")
            self._persist(record)
            future.set_result(record)
            return future
        thread = threading.Thread(
            target=self._run,
            args=(future, base, intent, system, user, session_id, request_id,
                  authoritative_plan, planner, candidate_view_provider),
            name="laya-shadow", daemon=True)
        with self._lock:
            self._threads.append(thread)
        thread.start()
        return future

    def wait(self, timeout: float | None = None) -> None:
        """Block until in-flight shadow work finishes. Tests and evaluation only."""
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(timeout)
        with self._lock:
            self._threads = [t for t in self._threads if t.is_alive()]

    # ── background job ───────────────────────────────────────────────

    def _run(self, future: Future, base, intent, system, user, session_id,
             request_id, authoritative_plan, planner,
             candidate_view_provider=None) -> None:
        try:
            future.set_result(self._job(base, intent, system, user, session_id,
                                        request_id, authoritative_plan, planner,
                                        candidate_view_provider))
        except BaseException as exc:  # noqa: BLE001 — surfaced on the future only
            future.set_exception(exc)
        finally:
            self._slots.release()

    def _persist(self, record: ShadowPlanRecord) -> None:
        try:
            self.store.write(record)
        except Exception:  # noqa: BLE001 — a write failure is logged, not raised
            logger.warning("shadow plan record could not be written", exc_info=True)

    def _job(self, base, intent, system, user, session_id, request_id,
             authoritative_plan, planner, candidate_view_provider=None) -> ShadowPlanRecord:
        try:
            record = self._evaluate(base, intent, system, user, session_id,
                                    request_id, authoritative_plan, planner)
        except Exception as exc:  # noqa: BLE001 — shadow must never escape
            record = ShadowPlanRecord(
                **base, status="internal-error",
                errorCategory="INTERNAL",
                error=_clip(f"{type(exc).__name__}: {exc}"))
        view, view_status = self._candidate_view(candidate_view_provider)
        record = record.model_copy(update={"candidateView": view,
                                           "candidateViewStatus": view_status})
        self._persist(record)
        return record

    @staticmethod
    def _candidate_view(provider) -> tuple[dict | None, str]:
        """Build the redacted snapshot. Any failure is a bounded status, never an exception.

        Runs on the shadow thread, so a slow or broken view cannot delay the request.
        """
        if provider is None:
            return None, "not-provided"
        try:
            from aura.sovereign.shadow_view import view_to_record
            result = provider()
            status = str(getattr(result, "status", "ok"))
            view = getattr(result, "view", None)
            return (view_to_record(view) if view is not None else None), status[:200]
        except Exception as exc:  # noqa: BLE001 — diagnostics only
            return None, _clip(f"unavailable: {type(exc).__name__}")

    def _evaluate(self, base, intent, system, user, session_id, request_id,
                  authoritative_plan, planner) -> ShadowPlanRecord:
        bridge = ProviderBridge(self.port)
        result = None
        attempts = 0
        for attempts in range(1, self.max_attempts + 1):
            result = bridge.complete_plan_json("plan", system, user,
                                               session_id=session_id, request_id=request_id)
            if result.ok or result.error_category in _PERMANENT:
                break
        assert result is not None
        identity = {"provider": result.provider, "model": result.model,
                    "latencyMs": result.latencyMs, "attempts": attempts}
        if not result.ok:
            raw_path = None
            if os.environ.get(RAW_ENV_FLAG) == "1" and result.raw_response:
                raw_path = self.store.write_raw(
                    base["sessionId"], base["shadowId"], result.raw_response)
            return ShadowPlanRecord(
                **base, **identity, status="model-failed",
                errorCategory=result.error_category,
                error=_clip(result.error),
                diagnostics=result.diagnostics,
                rawCapturePath=raw_path)

        proposal = result.data
        try:
            candidate = planner.plan_from_model(intent, session_id, _now(), proposal)
        except PlanningError as exc:
            return ShadowPlanRecord(
                **base, **identity, status="schema-rejected",
                errorCategory=f"SCHEMA:{classify_rejection(str(exc))}",
                error=_clip(str(exc)),
                candidate=scrub_structure(proposal))
        except Exception as exc:  # noqa: BLE001
            return ShadowPlanRecord(
                **base, **identity, status="schema-rejected",
                errorCategory=f"SCHEMA:{classify_rejection(str(exc))}",
                error=_clip(f"{type(exc).__name__}: {exc}"),
                candidate=scrub_structure(proposal))

        if read_only_request(intent, user, authoritative_plan):
            conflict = read_only_conflict(candidate)
            if conflict is not None:
                label, message = conflict
                # Rejected, not rewritten: the candidate is kept as evidence.
                return ShadowPlanRecord(
                    **base, **identity, status="schema-rejected",
                    errorCategory=f"SCHEMA:{label}",
                    error=_clip(message),
                    candidate=scrub_structure(proposal))

        summary = summarize_plan(candidate)
        return ShadowPlanRecord(
            **base, **identity, status="validated",
            candidate=scrub_structure(proposal),
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
        # An observation for review. Permission is decided by the authority
        # layer, never by this record.
        "highRiskTaskPresent": any(t.risk == "high" for t in candidate.tasks),
    }


def _clip(text: str | None, limit: int = 300) -> str | None:
    if text is None:
        return None
    return scrub_text(str(text))[:limit]
