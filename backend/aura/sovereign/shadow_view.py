"""Request-scoped candidate snapshot for shadow evaluation. Read-only, bounded, redacted.

Given one user request and its authoritative plan, this builds the candidate view
for that request's task type: the registry records that can serve the task, each
assessed for policy eligibility, task readiness and dispatchability on the request's
execution path. It never changes the registry, the policy, the ledger, or the router.

Guarantees, each covered by tests:
  * The execution path comes from the authoritative plan. A plan with no model-using
    work is "unsupported"; an absent plan is "unknown", and readiness is withheld.
  * Spend is read through a read-only reader with a busy timeout. It never creates the
    database file and never writes a row or a reservation. Limitation: in WAL mode a
    read can create the -wal and -shm sidecar files when none exist (see usage_ledger).
  * The deadline is best-effort. The only unbounded-looking step is the registry query,
    which is in memory and proportional to the registry size; the ledger wait is bounded
    by its busy timeout.
  * Candidates and spend figures come from the same read, so they agree.
  * With the policy-routing flag on, the authoritative choice is not computed here,
    because the flagged router path would open a writable ledger.
  * Failures become a stable status code. Errors carry type names only, never paths,
    addresses, credentials or request content.
  * Serialised output has no endpoint addresses, no credential or configuration paths,
    and no user request text.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from aura.sovereign.evidence import DEFAULT_POLICY
from aura.sovereign.inventory_state import (
    PATH_UNKNOWN,
    PATH_UNSUPPORTED,
    PATH_WORKER_CLI,
    assess_candidate,
)
from aura.sovereign.laya_view import CandidateView, GrantSpend, build_view
from aura.sovereign.model_router import (
    SOVEREIGN_NETWORK_CLASSES,
    ModelRouter,
    TaskClassifier,
    policy_routing_enabled,
)

MAX_VIEW_CANDIDATES = 50
#: Starting TTLs, owned by evidence.DEFAULT_POLICY. Kept here as names for compatibility.
METADATA_TTL_S = DEFAULT_POLICY.metadata_ttl_s
MAX_REASON_CHARS = 200
DEFAULT_LEDGER_BUSY_MS = 500
DEFAULT_DEADLINE_S = 2.0

STATUS_OK = "ok"
STATUS_NO_CANDIDATES = "no-candidates"
STATUS_LEDGER_BUSY = "ledger-busy"
STATUS_LEDGER_UNAVAILABLE = "ledger-unavailable"
STATUS_LEDGER_ABSENT = "ledger-absent"
STATUS_TIMEOUT = "timeout"

_WORKER_CAPABILITY = "agent.delegate"


@dataclass(frozen=True)
class RequestView:
    task_type: str
    view: CandidateView | None
    status: str
    execution_path: str = PATH_UNKNOWN


def execution_path_for_plan(plan) -> tuple[str, str]:
    """The execution path this request will use, from its authoritative plan.

    Returns (path, reason). Only a delegated task reaches a model through a worker,
    so any agent.delegate task means the worker path. A plan made only of direct
    capabilities calls no model. No plan means the path cannot be determined.
    """
    if plan is None:
        return PATH_UNKNOWN, "no authoritative plan supplied"
    tasks = getattr(plan, "tasks", None)
    if tasks is None:
        return PATH_UNKNOWN, "authoritative plan has no task list"
    capabilities = {getattr(t, "capabilityId", None) for t in tasks}
    if _WORKER_CAPABILITY in capabilities:
        return PATH_WORKER_CLI, "plan delegates to a worker (agent.delegate)"
    if not capabilities or None in capabilities:
        return PATH_UNKNOWN, "plan has tasks without a capability"
    return PATH_UNSUPPORTED, "plan calls no model (direct capabilities only)"


def build_request_view(registry, message: str, *, plan=None,
                       now: float | None = None, wall_now: float | None = None,
                       policy=None, sovereign=None, ledger_path=None,
                       busy_timeout_ms: int = DEFAULT_LEDGER_BUSY_MS,
                       deadline_s: float = DEFAULT_DEADLINE_S,
                       clock=time.monotonic, wall_clock=time.time) -> RequestView:
    """The snapshot for one request. Reads only; never raises for an expected failure."""
    from aura.sovereign.candidate_policy import EndpointPolicy
    from aura.sovereign.policy import load_sovereign_policy
    from aura.sovereign.policy_config import load_model_policy
    from aura.sovereign.usage_ledger import (
        LedgerBusy,
        LedgerUnavailable,
        read_spent_bounded,
    )

    started = clock()
    classifier = TaskClassifier()
    task_type = classifier.classify(message)
    required = classifier.required_capabilities(task_type)
    now = clock() if now is None else now
    wall_now = wall_clock() if wall_now is None else wall_now
    path, _path_reason = execution_path_for_plan(plan)

    model_policy = policy if policy is not None else load_model_policy()
    sovereign_policy = sovereign if sovereign is not None else load_sovereign_policy()

    spend_read = None
    spent: dict = {}
    if model_policy.grants:
        if ledger_path is None:
            from aura.config import aura_path
            ledger_path = aura_path("agent", "usage.sqlite3")
        try:
            spend_read = read_spent_bounded(ledger_path, model_policy.grants,
                                            busy_timeout_ms=busy_timeout_ms, clock=wall_clock)
        except LedgerBusy:
            return RequestView(task_type, None, STATUS_LEDGER_BUSY, path)
        except LedgerUnavailable:
            return RequestView(task_type, None, STATUS_LEDGER_UNAVAILABLE, path)
        spent = dict(spend_read.spent)
        if clock() - started > deadline_s:
            return RequestView(task_type, None, STATUS_TIMEOUT, path)

    records = registry.query(required_caps=required,
                             network_classes=SOVEREIGN_NETWORK_CLASSES,
                             healthy_only=False)[:MAX_VIEW_CANDIDATES]

    endpoints: dict[str, EndpointPolicy] = dict(model_policy.endpoints)
    # Configured here means: declared in the policy file, or discovered from a
    # configured endpoint (the registry is populated only from configured endpoints).
    configured = frozenset(endpoints) | frozenset(r.endpoint_id for r in records)

    assessments = [
        assess_candidate(
            rec, task_caps=required, policy=sovereign_policy, endpoints=endpoints,
            grants=model_policy.grants, spent_by_grant=spent,
            configured_endpoints=configured,
            capability_overrides=model_policy.overrides,
            now=now, probe_ttl=DEFAULT_POLICY.reachability_ttl_s, metadata_ttl=METADATA_TTL_S,
            path=path)
        for rec in records]

    # The authoritative choice is shown only when the legacy router decides. With the
    # flag on, the flagged path would open a writable ledger, so it is not computed here.
    # Three distinct states, so a reader can tell them apart:
    #   not-computed          the flag is on, so this view does not run the router;
    #   legacy-router         the legacy router ran, and authoritativeChoice is its answer
    #                         (null here means it validly found no candidate);
    #   legacy-router-error   the legacy router raised, so there is no answer at all.
    authoritative = None
    basis = "not-computed"
    if not policy_routing_enabled():
        basis = "legacy-router"
        try:
            decision = ModelRouter(registry)._route_legacy(message, None, None)
            if decision.record is not None:
                authoritative = (decision.record.endpoint_id, decision.record.model_name)
        except Exception:  # noqa: BLE001 — recorded as an error basis, type name only
            authoritative = None
            basis = "legacy-router-error"

    spend_rows: list[GrantSpend] = []
    if spend_read is not None:
        for grant in model_policy.grants:
            key = (grant.endpoint_id, grant.model_name)
            used = float(spend_read.spent.get(key, 0.0))
            spend_rows.append(GrantSpend(
                endpoint_id=grant.endpoint_id, model_name=grant.model_name,
                spent=round(used, 9), spend_cap=grant.spend_cap,
                available=round(grant.spend_cap - used, 9),
                observed_at=spend_read.observed_at))

    if clock() - started > deadline_s:
        return RequestView(task_type, None, STATUS_TIMEOUT, path)

    view = build_view(required_tags=required, assessments=assessments,
                      authoritative_choice=authoritative,
                      spend=spend_rows,
                      spend_observed_at=(spend_read.observed_at if spend_read else None),
                      authoritative_basis=basis)
    status = STATUS_OK if assessments else STATUS_NO_CANDIDATES
    if spend_read is not None and spend_read.status == "ledger-absent":
        status = f"{status}; {STATUS_LEDGER_ABSENT}"
    return RequestView(task_type, view, status, path)


def _clip(text) -> str:
    # Imported here: the central-agent package imports the sovereign package, so a
    # module-level import would be circular.
    from aura.central_agent.shadow_planner import scrub_text
    return scrub_text(str(text))[:MAX_REASON_CHARS]


def view_to_record(view: CandidateView) -> dict:
    """A JSON-ready, redacted copy of the snapshot. Contains no endpoint addresses."""
    return {
        "requiredTags": list(view.required_tags),
        "authoritativeChoice": (list(view.authoritative_choice)
                                if view.authoritative_choice is not None else None),
        "authoritativeBasis": _clip(view.authoritative_basis),
        "spendObservedAt": view.spend_observed_at,
        "spend": [
            {
                "endpointId": _clip(g.endpoint_id),
                "modelName": _clip(g.model_name),
                "spent": g.spent,
                "spendCap": g.spend_cap,
                "available": g.available,
                "observedAt": g.observed_at,
            }
            for g in view.spend],
        "candidates": [
            {
                "endpointId": _clip(snap.endpoint_id),
                "modelName": _clip(snap.model_name),
                "networkClass": _clip(snap.network_class),
                "executionPath": _clip(snap.execution_path),
                "reachableFreshness": _clip(snap.reachable_freshness),
                "metadataFreshness": _clip(snap.metadata_freshness),
                "reachableAgeSeconds": snap.reachable_age_seconds,
                "metadataAgeSeconds": snap.metadata_age_seconds,
                "reachableFailureAgeSeconds": snap.reachable_failure_age_seconds,
                "metadataFailureAgeSeconds": snap.metadata_failure_age_seconds,
                "taskCapabilities": [
                    {"tag": _clip(ev.tag), "provenance": _clip(ev.provenance)}
                    for ev in snap.task_capabilities],
                "policyEligible": snap.policy_eligible,
                "exclusion": (_clip(snap.exclusion) if snap.exclusion else None),
                "dispatchSupported": snap.dispatch_supported,
                "dispatchReason": _clip(snap.dispatch_reason),
                "grantValid": snap.grant_valid,
                "grantAvailable": snap.grant_available,
                "taskReady": snap.task_ready,
                "notReadyReasons": [_clip(r) for r in snap.not_ready_reasons],
            }
            for snap in view.candidates
        ],
    }
