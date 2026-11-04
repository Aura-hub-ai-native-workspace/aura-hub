"""Policy-aware candidate filter for model selection. Pure: no I/O, no network.

Given candidate models and an explicit policy, returns which candidates may be
used for a task and why every other candidate was excluded. It decides
eligibility only. It does not rank candidates, call a model, grant permission,
or record spending. Those belong to the caller and to the execution layer.

Rules, applied in order to each candidate:

1. Sovereignty (hard boundary). The active SovereignPolicy must allow the
   endpoint's network class. Endpoint-level configuration cannot override it.
2. Cloud. A cloud endpoint is eligible only when the operator has enabled that
   endpoint by name. Nothing is enabled by default.
3. Capability. Each required tag must be backed by provenance the policy
   accepts. Verified and operator-declared values count. Inferred values count
   only for tags listed in LEGACY_INFERRED_TAGS, and unknown values never count.
4. Cost. FREE_VERIFIED needs no authorization. PAID needs an applicable grant
   with a bounded price and enough remaining spend cap. UNKNOWN is treated as
   paid, never as free.
5. Health. A candidate known to be unhealthy is excluded.

Only the first failing rule is reported, so each exclusion has one reason.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping

from aura.sovereign.policy import SovereignPolicy


class Provenance(str, Enum):
    VERIFIED = "verified"      # read from the server or another authoritative source
    OPERATOR = "operator"      # declared in operator configuration
    INFERRED = "inferred"      # heuristic from the model name; a hint, never proof
    UNKNOWN = "unknown"        # no evidence either way


class CostState(str, Enum):
    FREE_VERIFIED = "free_verified"
    PAID = "paid"
    UNKNOWN = "unknown"


#: Tags a required capability may be satisfied by when the only evidence is a
#: name heuristic. Kept deliberately short and temporary:
#:   code-generation: coding routing depends on it and no verified source exists yet.
#:   text-generation: every completion-capable model has it, and the name heuristic
#:       adds it to every name. Without this, an unreachable metadata endpoint
#:       would block all routing.
#: json-mode, vision and embedding are NOT listed. A name alone must not make them true.
LEGACY_INFERRED_TAGS = frozenset({"code-generation", "text-generation"})

#: Provenance accepted for a required tag. Inferred is accepted only for the
#: legacy tags above.
_ACCEPTED_FOR_REQUIRED = frozenset({Provenance.VERIFIED, Provenance.OPERATOR})


@dataclass(frozen=True)
class Fact:
    """One capability value with its provenance. ``value`` None means unknown."""
    value: bool | None
    provenance: Provenance
    source: str = ""
    note: str = ""


def resolve_tag(tag: str, verified: Fact | None, operator: bool | None,
                inferred: bool | None) -> Fact:
    """Combine evidence for one capability tag.

    Precedence:
      * A verified value stands. An operator may restrict it (False) but cannot
        claim a capability the server verifiably lacks; that conflict is kept
        visible as a note and resolves to False.
      * With no verified value, an operator declaration stands.
      * With neither, an inferred hint is recorded as inferred.
      * Otherwise the value is unknown.
    """
    if verified is not None and verified.value is not None:
        if operator is False:
            return Fact(False, Provenance.OPERATOR, "operator restriction")
        if operator is True and verified.value is False:
            return Fact(False, Provenance.VERIFIED, verified.source,
                        note=f"operator claimed {tag!r}; server says otherwise")
        return verified
    if operator is not None:
        return Fact(operator, Provenance.OPERATOR, "operator configuration")
    if inferred is not None:
        return Fact(inferred, Provenance.INFERRED, "name heuristic")
    return Fact(None, Provenance.UNKNOWN)


@dataclass(frozen=True)
class PaidGrant:
    """An explicit standing authorization. Scope is exact: one endpoint and one model."""
    endpoint_id: str
    model_name: str
    spend_cap: float          # total the operator allows under this grant
    granted_by: str = "operator-config"


@dataclass(frozen=True)
class EndpointPolicy:
    """Operator-declared policy for one endpoint. Nothing here is inferred."""
    endpoint_id: str
    network_class: str                    # local | private | cloud | unknown
    cloud_enabled: bool = False           # only meaningful for cloud endpoints
    declared_free: bool = False           # operator says this endpoint bills nothing
    declared_paid: bool = False           # operator says this endpoint bills per use
    price_per_1k_tokens: float | None = None   # operator-declared price ceiling, if any


@dataclass(frozen=True)
class CandidateInput:
    endpoint_id: str
    model_name: str
    network_class: str
    capabilities: Mapping[str, Fact]
    healthy: bool | None = None


@dataclass(frozen=True)
class TaskRequest:
    required_tags: frozenset
    max_output_tokens: int = 1024
    #: Price-bounding inputs: spend already recorded under each grant, supplied by the caller.
    spent_by_grant: Mapping[tuple[str, str], float] = field(default_factory=dict)


@dataclass(frozen=True)
class Exclusion:
    endpoint_id: str
    model_name: str
    reason: str          # a stable code, see REASONS
    detail: str = ""


@dataclass(frozen=True)
class Eligible:
    endpoint_id: str
    model_name: str
    cost_state: CostState
    estimated_max_cost: float | None      # None for free_verified; bounded value for paid
    grant: PaidGrant | None               # the grant used, if any


@dataclass
class FilterResult:
    eligible: list[Eligible] = field(default_factory=list)
    excluded: list[Exclusion] = field(default_factory=list)


REASONS = (
    "sovereignty-blocked",
    "cloud-not-enabled",
    "capability-unverified",
    "unhealthy",
    "cost-unknown",
    "paid-needs-authorization",
    "paid-price-unbounded",
    "spend-cap-exceeded",
)


def cost_state_for(network_class: str, endpoint: EndpointPolicy | None) -> CostState:
    """Derive the cost state. Only structural or explicitly declared free is FREE_VERIFIED.

    A "local" runtime (loopback) bills nothing, so it is FREE_VERIFIED without
    any operator entry. Any other endpoint is free only when the operator
    declares it so; that is operator evidence, not measured billing. A declared
    price makes it PAID. Everything else is UNKNOWN, which is never free.
    """
    if endpoint is not None and (endpoint.declared_paid
                                 or endpoint.price_per_1k_tokens is not None):
        return CostState.PAID
    if endpoint is not None and endpoint.declared_free:
        return CostState.FREE_VERIFIED
    if network_class == "local":
        return CostState.FREE_VERIFIED
    return CostState.UNKNOWN


def _capability_ok(candidate: CandidateInput, tag: str) -> tuple[bool, str]:
    fact = candidate.capabilities.get(tag)
    if fact is None or fact.value is not True:
        return False, f"{tag} not present"
    if fact.provenance in _ACCEPTED_FOR_REQUIRED:
        return True, ""
    if fact.provenance is Provenance.INFERRED and tag in LEGACY_INFERRED_TAGS:
        return True, "legacy inferred tag"
    return False, f"{tag} provenance is {fact.provenance.value}"


def filter_candidates(candidates, request: TaskRequest, policy: SovereignPolicy,
                      endpoints: Mapping[str, EndpointPolicy],
                      grants: list[PaidGrant] | tuple = ()) -> FilterResult:
    """Decide eligibility for each candidate. Deterministic and side-effect free."""
    result = FilterResult()
    for cand in candidates:
        endpoint = endpoints.get(cand.endpoint_id)
        network = endpoint.network_class if endpoint else cand.network_class

        def exclude(reason: str, detail: str = "") -> None:
            result.excluded.append(Exclusion(cand.endpoint_id, cand.model_name, reason, detail))

        # 1. Sovereignty is a hard boundary and is checked first.
        if not policy.allows(network):
            exclude("sovereignty-blocked", f"network class {network!r} not allowed")
            continue

        # 2. Cloud must be enabled for this endpoint by name.
        if network == "cloud" and not (endpoint and endpoint.cloud_enabled):
            exclude("cloud-not-enabled", "cloud endpoints must be enabled per endpoint")
            continue

        # 3. Capability provenance.
        blocked = None
        for tag in sorted(request.required_tags):
            ok, why = _capability_ok(cand, tag)
            if not ok:
                blocked = why
                break
        if blocked is not None:
            exclude("capability-unverified", blocked)
            continue

        # 4. Health.
        if cand.healthy is False:
            exclude("unhealthy", "last health check failed")
            continue

        # 5. Cost.
        cost = cost_state_for(network, endpoint)
        if cost is CostState.FREE_VERIFIED:
            result.eligible.append(Eligible(cand.endpoint_id, cand.model_name, cost, None, None))
            continue
        if cost is CostState.UNKNOWN:
            exclude("cost-unknown", "unknown cost is not treated as free")
            continue
        # PAID: needs a bounded price and an applicable grant with cap headroom.
        price = endpoint.price_per_1k_tokens
        if price is None or price < 0:
            exclude("paid-price-unbounded", "no operator-declared price ceiling")
            continue
        estimate = round(price * request.max_output_tokens / 1000.0, 6)
        grant = next((g for g in grants
                      if g.endpoint_id == cand.endpoint_id and g.model_name == cand.model_name),
                     None)
        if grant is None:
            exclude("paid-needs-authorization",
                    "no standing grant; per-request authorization required")
            continue
        spent = float(request.spent_by_grant.get((grant.endpoint_id, grant.model_name), 0.0))
        if spent + estimate > grant.spend_cap:
            exclude("spend-cap-exceeded",
                    f"spent {spent:.6f} + estimate {estimate:.6f} > cap {grant.spend_cap:.6f}")
            continue
        result.eligible.append(Eligible(cand.endpoint_id, cand.model_name, cost, estimate, grant))
    return result


def candidate_from_record(record, network_class: str | None = None) -> CandidateInput:
    """Build a candidate from a sovereign ModelRecord, keeping its provenance.

    A tag the record lists with a name-hint source becomes INFERRED. A tag listed
    with any other source becomes VERIFIED. A tag not listed is UNKNOWN, not false.
    The record keeps only positive evidence, so a verified absence is not known here.
    """
    caps: dict[str, Fact] = {}
    sources = getattr(record, "capability_sources", {}) or {}
    for tag in record.capabilities:
        source = sources.get(tag, "")
        if source == "name-hint":
            caps[tag] = Fact(True, Provenance.INFERRED, "name heuristic")
        else:
            caps[tag] = Fact(True, Provenance.VERIFIED, source or "registry")
    health = getattr(record, "healthy", None)
    return CandidateInput(
        endpoint_id=record.endpoint_id, model_name=record.model_name,
        network_class=network_class or record.network_class,
        capabilities=caps, healthy=health)
