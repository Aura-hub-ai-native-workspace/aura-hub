"""Explicit lifecycle states for inventory candidates. Pure: no I/O, no probes.

The six states are independent facts. None implies another:

  discovered        an observation exists in the registry. Authorises nothing.
  configured        the operator declared the endpoint. Says nothing about reachability.
  reachable         a health probe succeeded recently. Says nothing about capability.
  metadata_verified the server reported capabilities or context. Name hints are not this.
  policy_eligible   the candidate filter accepts it for one task under the active policy.
  task_ready        every requirement for one task holds on fresh, non-hint evidence,
                    and the execution path can account for its cost.

Each state carries its evidence kind (observed, declared, verified, inferred,
failed, unknown), its freshness (fresh, stale, none), its source and a detail.
Stale or missing evidence is reported as unknown (None), never as True.

Dispatchability is an assessment of an execution path, not a property of the
model. It is evaluated separately and feeds task_ready.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from enum import Enum
from typing import Mapping

from aura.sovereign.candidate_policy import (
    CandidateInput,
    CostState,
    EndpointPolicy,
    Fact,
    Provenance,
    TaskRequest,
    candidate_from_record,
    cost_state_for,
    filter_candidates,
    resolve_tag,
)
from aura.sovereign.evidence import age, classify, metadata_times, probe_times
from aura.sovereign.policy import SovereignPolicy

# Evidence kinds
OBSERVED = "observed"
DECLARED = "declared"
VERIFIED = "verified"
INFERRED = "inferred"
FAILED = "failed"
UNKNOWN = "unknown"

# Freshness. Evidence-bearing facts report fresh | stale | failed | unknown.
# Facts that are not evidence (configuration, policy) report NOT_APPLICABLE.
FRESH = "fresh"
STALE = "stale"
FAILED_FRESHNESS = "failed"
UNKNOWN_FRESHNESS = "unknown"
NOT_APPLICABLE = "n/a"

# Execution paths. The path is a property of the request's authoritative plan, not of
# the model. See shadow_view.execution_path_for_plan.
PATH_AURA_MEDIATED = "aura-mediated"   # AURA's own model port makes the call (no call path uses it yet)
PATH_WORKER_CLI = "worker-cli"         # agent.delegate: a worker process makes the call
PATH_UNSUPPORTED = "unsupported"       # the plan dispatches no model-using work
PATH_UNKNOWN = "unknown"               # the plan is not available; the path cannot be determined
EXECUTION_PATHS = (PATH_AURA_MEDIATED, PATH_WORKER_CLI, PATH_UNSUPPORTED, PATH_UNKNOWN)

#: Paths that can account for a billable call. None is proven yet, so paid is unsupported
#: on both. Changing this requires a tested usage parser per provider and a reviewed proof.
METERED_PATHS: frozenset = frozenset()

_HINT = "name-hint"


class StateName(str, Enum):
    DISCOVERED = "discovered"
    CONFIGURED = "configured"
    REACHABLE = "reachable"
    METADATA_VERIFIED = "metadata_verified"
    POLICY_ELIGIBLE = "policy_eligible"
    TASK_READY = "task_ready"


@dataclass(frozen=True)
class StateFact:
    name: StateName
    value: bool | None            # None = unknown, never a default True or False
    evidence: str                 # OBSERVED | DECLARED | VERIFIED | INFERRED | FAILED | UNKNOWN
    freshness: str                # fresh | stale | failed | unknown | n/a
    source: str = ""
    detail: str = ""


@dataclass(frozen=True)
class DispatchAssessment:
    path: str
    supported: bool
    reason: str


@dataclass(frozen=True)
class CandidateAssessment:
    endpoint_id: str
    model_name: str
    states: Mapping[StateName, StateFact]
    dispatch: DispatchAssessment
    task_ready: bool
    not_ready_reasons: tuple = ()
    exclusion: str | None = None           # the policy exclusion code, if not eligible
    grant_available: float | None = None   # remaining cap under the exact grant, paid only
    grant_valid: bool | None = None        # whether an applicable grant exists with headroom
    network_class: str = ""
    execution_path: str = ""
    reachable_freshness: str = ""
    metadata_freshness: str = ""
    #: Age of each piece of evidence when the assessment was made; None when never observed.
    reachable_age_seconds: float | None = None           # since the last successful probe
    metadata_age_seconds: float | None = None            # since the last successful metadata read
    reachable_failure_age_seconds: float | None = None   # since the last failed probe
    metadata_failure_age_seconds: float | None = None    # since the last failed metadata read
    #: (tag, provenance) per required tag. Provenance is one of
    #: verified | operator | name-hint | absent | unknown.
    tag_provenance: tuple = ()


def dispatch_for(path: str, cost: CostState) -> DispatchAssessment:
    """Can this execution path account for a call at this cost state?

    Never inferred from policy eligibility. Unsupported and unknown paths are never
    dispatchable, whatever the cost.
    """
    if path == PATH_UNKNOWN:
        return DispatchAssessment(path, False, "execution path unknown; readiness withheld")
    if path == PATH_UNSUPPORTED:
        return DispatchAssessment(path, False, "the plan dispatches no model-using work")
    if path == PATH_AURA_MEDIATED:
        # No AURA call path sends a candidate's request to a model, so nothing on this path
        # is dispatchable, free or paid, until one exists and is tested.
        return DispatchAssessment(path, False,
                                  "no AURA-mediated execution path exists yet")
    if path not in (PATH_AURA_MEDIATED, PATH_WORKER_CLI):
        return DispatchAssessment(path, False, f"unrecognised execution path {path!r}")
    if cost is CostState.FREE_VERIFIED:
        return DispatchAssessment(path, True, "free: nothing to meter")
    if cost is CostState.UNKNOWN:
        return DispatchAssessment(path, False, "cost unknown; not treated as free")
    # PAID
    if path == PATH_WORKER_CLI:
        return DispatchAssessment(path, False, "paid-dispatch-not-metered")
    if path in METERED_PATHS:
        return DispatchAssessment(path, True, "metered path")
    return DispatchAssessment(path, False,
                              "no provider usage accounting on this path yet")


def _combined_freshness(*parts: str) -> str:
    """Readiness is only as fresh as its least fresh input. Failed beats stale beats unknown."""
    for worst in (FAILED_FRESHNESS, STALE, UNKNOWN_FRESHNESS):
        if worst in parts:
            return worst
    return FRESH


def _probe_state(record, now: float, ttl: float) -> StateFact:
    """Reachability from explicit probe evidence only. Discovery counts only as an observed probe."""
    success, failure, category = probe_times(record)
    state = classify(success, failure, now, ttl)
    if state == UNKNOWN:
        return StateFact(StateName.REACHABLE, None, UNKNOWN, UNKNOWN_FRESHNESS,
                         detail="never probed")
    if state == FAILED:
        # The category, never raw text. A newer failure overrides any older success.
        return StateFact(StateName.REACHABLE, False, FAILED, FAILED_FRESHNESS,
                         source="health probe",
                         detail=category or "probe-failed")
    if state == STALE:
        return StateFact(StateName.REACHABLE, None, OBSERVED, STALE, source="health probe",
                         detail=f"last successful probe {now - success:.0f}s ago, "
                                f"older than {ttl:.0f}s")
    return StateFact(StateName.REACHABLE, True, OBSERVED, FRESH, source="health probe")


def _metadata_state(record, now: float, ttl: float) -> StateFact:
    """Server metadata only. Operator overrides are declarations, not metadata."""
    server_sources = {tag for tag, src in record.capability_sources.items() if src != _HINT}
    has_server_evidence = bool(server_sources) or record.context_length > 0 \
        or bool(record.verified_absent)
    success, failure, category = metadata_times(record)
    if not has_server_evidence:
        # A discovery timestamp is not metadata. Without server-reported fields, the only
        # evidence is a name hint, unless a metadata read has failed.
        if failure is not None:
            return StateFact(StateName.METADATA_VERIFIED, None, FAILED, FAILED_FRESHNESS,
                             source="ollama:/api/show", detail=category or "metadata-failed")
        return StateFact(StateName.METADATA_VERIFIED, None, INFERRED, UNKNOWN_FRESHNESS,
                         detail="only name hints; no server metadata observed")
    state = classify(success, failure, now, ttl)
    if state == FAILED:
        # The last metadata read failed. Earlier server data is not current evidence.
        return StateFact(StateName.METADATA_VERIFIED, None, FAILED, FAILED_FRESHNESS,
                         source="ollama:/api/show", detail=category or "metadata-failed")
    if state == UNKNOWN:
        return StateFact(StateName.METADATA_VERIFIED, None, UNKNOWN, UNKNOWN_FRESHNESS,
                         detail="metadata never read")
    if state == STALE:
        return StateFact(StateName.METADATA_VERIFIED, None, VERIFIED, STALE,
                         source="ollama:/api/show", detail="metadata older than its ttl")
    return StateFact(StateName.METADATA_VERIFIED, True, VERIFIED, FRESH,
                     source="ollama:/api/show")


def _tag_provenance(record, tag: str, overrides: Mapping[str, bool]) -> str:
    if tag in overrides:
        return "operator"
    if tag in record.verified_absent:
        return "absent"
    if tag not in record.capabilities:
        return "unknown"
    source = record.capability_sources.get(tag, "")
    if source in (_HINT, ""):
        return "name-hint"
    return "verified"


def _tag_status(record, tag: str, overrides: Mapping[str, bool]) -> tuple[bool, str]:
    """Whether one required tag is established for readiness, and why not if not.

    Name hints never establish readiness. An operator override may. A verified
    absence is never overridden to present.
    """
    if tag in overrides:
        if overrides[tag]:
            return True, ""
        return False, f"{tag} disabled by operator override"
    if tag in record.verified_absent:
        return False, f"{tag} verified absent"
    if tag not in record.capabilities:
        return False, f"{tag} not reported"
    source = record.capability_sources.get(tag, "")
    if source == _HINT or source == "":
        return False, f"{tag} rests on a name hint only"
    return True, ""


def _candidate_with_overrides(record, overrides: Mapping[str, bool]) -> CandidateInput:
    """The record's candidate, with operator overrides merged by the same precedence
    rules as the rest of the policy (see resolve_tag)."""
    base = candidate_from_record(record)
    caps = dict(base.capabilities)
    for tag in set(caps) | set(overrides) | set(record.verified_absent):
        existing = caps.get(tag)
        verified = None
        inferred = None
        if tag in record.verified_absent:
            verified = Fact(False, Provenance.VERIFIED, "ollama:/api/show")
        elif existing is not None and existing.provenance is Provenance.VERIFIED:
            verified = existing
        elif existing is not None and existing.provenance is Provenance.INFERRED:
            # Keep the hint's provenance: the legacy eligibility exception depends on it.
            inferred = True
        fact = resolve_tag(tag, verified, overrides.get(tag), inferred)
        if fact.value is not None:
            caps[tag] = fact
    return dataclasses.replace(base, capabilities=caps)


def assess_candidate(record, *, task_caps: frozenset, policy: SovereignPolicy,
                     endpoints: Mapping[str, EndpointPolicy],
                     grants=(), spent_by_grant: Mapping | None = None,
                     configured_endpoints: frozenset = frozenset(),
                     capability_overrides: Mapping[str, Mapping[str, bool]] | None = None,
                     now: float, probe_ttl: float, metadata_ttl: float,
                     path: str = PATH_UNKNOWN,
                     max_output_tokens: int = 1024) -> CandidateAssessment:
    """Assess one registry record for one task on one execution path."""
    overrides = (capability_overrides or {}).get(record.endpoint_id, {})
    states: dict[StateName, StateFact] = {}

    states[StateName.REACHABLE] = _probe_state(record, now, probe_ttl)
    states[StateName.METADATA_VERIFIED] = _metadata_state(record, now, metadata_ttl)

    # Discovery is an observation of when the endpoint was seen. Its freshness is the
    # freshness of that probe evidence, and it authorises nothing.
    states[StateName.DISCOVERED] = StateFact(
        StateName.DISCOVERED, True, OBSERVED, states[StateName.REACHABLE].freshness,
        source="registry discovery",
        detail="an observation only; it authorises nothing")

    is_configured = record.endpoint_id in configured_endpoints
    states[StateName.CONFIGURED] = StateFact(
        StateName.CONFIGURED, True if is_configured else None,
        DECLARED if is_configured else UNKNOWN, NOT_APPLICABLE, source="operator configuration",
        detail="" if is_configured else "no operator declaration for this endpoint")

    # Policy eligibility for this task, from the same filter the flagged router uses.
    candidate: CandidateInput = _candidate_with_overrides(record, overrides)
    result = filter_candidates(
        [candidate], TaskRequest(required_tags=task_caps, max_output_tokens=max_output_tokens,
                                 spent_by_grant=dict(spent_by_grant or {})),
        policy, endpoints, grants)
    cost = cost_state_for(record.network_class, endpoints.get(record.endpoint_id))
    exclusion = result.excluded[0].reason if result.excluded else None
    eligible = bool(result.eligible) and is_configured
    if not is_configured and exclusion is None:
        exclusion = "not-configured"
    states[StateName.POLICY_ELIGIBLE] = StateFact(
        StateName.POLICY_ELIGIBLE, eligible, DECLARED, NOT_APPLICABLE, source="candidate policy",
        detail=exclusion or "")

    grant = next((g for g in grants if (g.endpoint_id, g.model_name)
                  == (record.endpoint_id, record.model_name)), None)
    grant_available = grant_valid = None
    if cost is CostState.PAID and grant is not None:
        spent = float((spent_by_grant or {}).get((grant.endpoint_id, grant.model_name), 0.0))
        grant_available = round(grant.spend_cap - spent, 9)
        price = endpoints[record.endpoint_id].price_per_1k_tokens if \
            record.endpoint_id in endpoints else None
        estimate = (price * max_output_tokens / 1000.0) if price else None
        grant_valid = estimate is not None and estimate <= grant_available

    dispatch = dispatch_for(path, cost)

    # Task readiness: every condition must hold on fresh, non-hint evidence.
    reasons: list[str] = []
    if not eligible:
        reasons.append(f"policy: {exclusion or 'not eligible'}")
    if not dispatch.supported:
        reasons.append(f"dispatch: {dispatch.reason}")
    if states[StateName.REACHABLE].value is not True:
        reasons.append(f"reachable: {states[StateName.REACHABLE].freshness} / "
                       f"{states[StateName.REACHABLE].detail or 'not confirmed'}")
    if states[StateName.METADATA_VERIFIED].value is not True:
        reasons.append("metadata: not verified fresh")
    for tag in sorted(task_caps):
        ok, why = _tag_status(record, tag, overrides)
        if not ok:
            reasons.append(f"capability: {why}")
    task_ready = not reasons
    states[StateName.TASK_READY] = StateFact(
        StateName.TASK_READY, task_ready,
        VERIFIED if task_ready else UNKNOWN,
        _combined_freshness(states[StateName.REACHABLE].freshness,
                            states[StateName.METADATA_VERIFIED].freshness),
        detail="" if task_ready else "; ".join(reasons))

    return CandidateAssessment(
        endpoint_id=record.endpoint_id, model_name=record.model_name,
        states=dict(states), dispatch=dispatch, task_ready=task_ready,
        not_ready_reasons=tuple(reasons), exclusion=exclusion,
        grant_available=grant_available, grant_valid=grant_valid,
        network_class=record.network_class,
        execution_path=path,
        reachable_freshness=states[StateName.REACHABLE].freshness,
        metadata_freshness=states[StateName.METADATA_VERIFIED].freshness,
        reachable_age_seconds=age(probe_times(record)[0], now),
        metadata_age_seconds=age(metadata_times(record)[0], now),
        reachable_failure_age_seconds=age(probe_times(record)[1], now),
        metadata_failure_age_seconds=age(metadata_times(record)[1], now),
        tag_provenance=tuple((t, _tag_provenance(record, t, overrides))
                             for t in sorted(task_caps)))
