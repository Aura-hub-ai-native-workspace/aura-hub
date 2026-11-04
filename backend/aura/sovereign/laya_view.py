"""Read-only candidate view for Laya, and a checker for Laya's recommendations.

Laya receives a frozen snapshot of what the authoritative policy, lifecycle and
dispatch assessments already decided. It can recommend one candidate from that
snapshot. Nothing in this module can authorise spend, grant permission, change
policy or inventory, or dispatch work. The router never imports this module, so
a recommendation cannot affect a routing decision.

When Laya's recommendation differs from the authoritative choice, the difference
is recorded as a Disagreement. The authoritative decision is never replaced.
"""

from __future__ import annotations

from dataclasses import dataclass

from aura.sovereign.inventory_state import CandidateAssessment, StateName

MAX_RATIONALE_CHARS = 280


@dataclass(frozen=True)
class TagEvidence:
    tag: str
    provenance: str          # verified | operator | inferred | unknown | absent
    detail: str = ""


@dataclass(frozen=True)
class CandidateSnapshot:
    endpoint_id: str
    model_name: str
    network_class: str
    task_capabilities: tuple          # tuple[TagEvidence, ...]
    policy_eligible: bool
    exclusion: str | None
    dispatch_supported: bool
    dispatch_reason: str
    grant_valid: bool | None
    grant_available: float | None
    task_ready: bool
    not_ready_reasons: tuple          # tuple[str, ...]
    execution_path: str = ""
    reachable_freshness: str = ""
    metadata_freshness: str = ""
    reachable_age_seconds: float | None = None
    metadata_age_seconds: float | None = None
    reachable_failure_age_seconds: float | None = None
    metadata_failure_age_seconds: float | None = None


@dataclass(frozen=True)
class GrantSpend:
    """Spend for one exact grant, from the same read that produced the candidates' figures."""
    endpoint_id: str
    model_name: str
    spent: float
    spend_cap: float
    available: float
    observed_at: float


@dataclass(frozen=True)
class CandidateView:
    required_tags: tuple              # sorted tuple[str, ...]
    candidates: tuple                 # tuple[CandidateSnapshot, ...]
    authoritative_choice: tuple | None  # (endpoint_id, model_name) or None
    spend: tuple = ()                   # tuple[GrantSpend, ...]
    spend_observed_at: float | None = None
    #: How authoritative_choice was obtained: "legacy-router" or "not-computed".
    authoritative_basis: str = "not-computed"

    def find(self, endpoint_id: str, model_name: str) -> CandidateSnapshot | None:
        for snap in self.candidates:
            if snap.endpoint_id == endpoint_id and snap.model_name == model_name:
                return snap
        return None


@dataclass(frozen=True)
class LayaRecommendation:
    """A recommendation only. It has no fields for spend, permission, policy or dispatch."""
    endpoint_id: str
    model_name: str
    rationale: str = ""


@dataclass(frozen=True)
class Disagreement:
    kind: str                          # see KINDS
    laya: tuple | None
    authoritative: tuple | None


KINDS = (
    "same",                            # Laya chose what the authority chose
    "different-candidate",             # both chose, different candidates
    "laya-not-in-view",                # Laya named a candidate the view does not contain
    "laya-not-ready",                  # Laya named a candidate that is not task-ready
    "authority-none-laya-suggested",   # the authority chose nothing; Laya did
)


@dataclass(frozen=True)
class ReviewResult:
    valid: bool
    errors: tuple = ()
    disagreement: Disagreement | None = None


def _tag_evidence(assessment: CandidateAssessment, tag: str) -> TagEvidence:
    provenance = dict(assessment.tag_provenance).get(tag, "unknown")
    return TagEvidence(tag, provenance)


def build_view(*, required_tags, assessments, authoritative_choice=None,
               spend=(), spend_observed_at=None,
               authoritative_basis="not-computed") -> CandidateView:
    """Snapshot assessments into frozen values. Later changes to the source do not reach the view."""
    required = tuple(sorted(required_tags))
    snaps = []
    for a in assessments:
        snaps.append(CandidateSnapshot(
            endpoint_id=str(a.endpoint_id),
            model_name=str(a.model_name),
            network_class=str(a.network_class),
            task_capabilities=tuple(_tag_evidence(a, t) for t in required),
            policy_eligible=bool(a.states[StateName.POLICY_ELIGIBLE].value),
            exclusion=a.exclusion,
            dispatch_supported=bool(a.dispatch.supported),
            dispatch_reason=str(a.dispatch.reason),
            grant_valid=a.grant_valid,
            grant_available=a.grant_available,
            task_ready=bool(a.task_ready),
            not_ready_reasons=tuple(a.not_ready_reasons),
            execution_path=str(a.execution_path),
            reachable_freshness=str(a.reachable_freshness),
            metadata_freshness=str(a.metadata_freshness),
            reachable_age_seconds=a.reachable_age_seconds,
            metadata_age_seconds=a.metadata_age_seconds,
            reachable_failure_age_seconds=a.reachable_failure_age_seconds,
            metadata_failure_age_seconds=a.metadata_failure_age_seconds,
        ))
    choice = tuple(authoritative_choice) if authoritative_choice is not None else None
    return CandidateView(required_tags=required, candidates=tuple(snaps),
                         authoritative_choice=choice, spend=tuple(spend),
                         spend_observed_at=spend_observed_at,
                         authoritative_basis=authoritative_basis)


def review_recommendation(view: CandidateView, rec: LayaRecommendation) -> ReviewResult:
    """Check a recommendation against the view. Never changes the view or any decision."""
    errors: list[str] = []
    if not isinstance(rec, LayaRecommendation):
        return ReviewResult(False, ("not a LayaRecommendation",), None)
    if not isinstance(rec.rationale, str) or len(rec.rationale) > MAX_RATIONALE_CHARS:
        return ReviewResult(False, (f"rationale must be text of at most "
                                    f"{MAX_RATIONALE_CHARS} characters",), None)
    snap = view.find(rec.endpoint_id, rec.model_name)
    laya_key = (rec.endpoint_id, rec.model_name)
    auth = view.authoritative_choice

    if snap is None:
        errors.append("recommended candidate is not in the view; Laya cannot add candidates")
        return ReviewResult(False, tuple(errors),
                            Disagreement("laya-not-in-view", laya_key, auth))
    if not snap.task_ready:
        errors.append("recommended candidate is not task-ready: "
                      + "; ".join(snap.not_ready_reasons))
        return ReviewResult(False, tuple(errors),
                            Disagreement("laya-not-ready", laya_key, auth))

    if auth is None:
        kind = "authority-none-laya-suggested"
    elif tuple(auth) == laya_key:
        kind = "same"
    else:
        kind = "different-candidate"
    disagreement = None if kind == "same" else Disagreement(kind, laya_key, auth)
    return ReviewResult(True, (), disagreement)
