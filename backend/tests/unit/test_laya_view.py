"""Slice D: Laya's read-only view. Laya can recommend; it cannot decide, grant, or spend.

Proofs covered here: the view is frozen and independent of its sources; a
recommendation is checked against the view and cannot add candidates; a paid
candidate can be recommended only if the authoritative assessment already says it
is ready (which it never is today); disagreements are recorded and the authority's
choice is untouched; and the router neither imports nor changes with the view.
"""

from __future__ import annotations

import dataclasses
import inspect
from pathlib import Path

import pytest

from aura.sovereign import laya_view as lv
from aura.sovereign import model_router as mr
from aura.sovereign.candidate_policy import EndpointPolicy
from aura.sovereign.inventory_state import assess_candidate
from aura.sovereign.model_registry import ModelRecord
from aura.sovereign.policy import SovereignPolicy
from aura.sovereign.policy_config import parse_model_policy

NOW = 1000.0
TEXT = frozenset({"text-generation"})


def _rec(model, endpoint="ep", network="local", healthy=True, caps=None):
    caps = caps if caps is not None else {"text-generation": "ollama:/api/show"}
    return ModelRecord(
        id=f"{endpoint}/{model}", model_name=model, endpoint_id=endpoint,
        base_url="http://127.0.0.1:11434", network_class=network,
        capabilities=frozenset(caps), capability_sources=dict(caps),
        healthy=healthy, last_checked=NOW, metadata_checked=NOW)


def _assess(rec, endpoints, grants=(), configured=None):
    return assess_candidate(
        rec, task_caps=TEXT, policy=SovereignPolicy(), endpoints=endpoints, grants=grants,
        configured_endpoints=frozenset(configured) if configured is not None
        else frozenset({rec.endpoint_id}),
        now=NOW, probe_ttl=60.0, metadata_ttl=600.0, path="worker-cli")


@pytest.fixture
def world():
    """Two ready local candidates, one unhealthy, and one paid candidate with a valid grant."""
    policy = parse_model_policy({
        "schemaVersion": 1,
        "endpoints": {
            "paid-api": {"networkClass": "cloud", "cloudEnabled": True,
                         "cost": "paid", "pricePer1kTokens": 0.01}},
        "paidGrants": [{"endpointId": "paid-api", "modelName": "big", "spendCap": 5.0}]})
    endpoints = dict(policy.endpoints)
    endpoints["loopback"] = EndpointPolicy("loopback", "local", declared_free=True)
    records = [
        _rec("alpha", endpoint="loopback"),
        _rec("beta", endpoint="loopback"),
        _rec("sick", endpoint="loopback", healthy=False),
        _rec("big", endpoint="paid-api", network="cloud"),
    ]
    assessments = [_assess(r, endpoints, grants=policy.grants,
                           configured={"loopback", "paid-api"}) for r in records]
    return records, assessments, policy


def _view(assessments, choice=("loopback", "alpha")):
    return lv.build_view(required_tags=TEXT, assessments=assessments,
                         authoritative_choice=choice)


# ── immutability and independence ───────────────────────────────────────


def test_the_view_and_its_snapshots_are_frozen(world):
    _, assessments, _ = world
    view = _view(assessments)
    with pytest.raises(dataclasses.FrozenInstanceError):
        view.authoritative_choice = None
    with pytest.raises(dataclasses.FrozenInstanceError):
        view.candidates[0].task_ready = True
    assert isinstance(view.candidates, tuple)


def test_the_view_does_not_follow_later_changes_to_the_registry(world):
    records, assessments, _ = world
    view = _view(assessments)
    before = view
    records[0].healthy = False                      # mutate the source record
    records[0].capabilities = frozenset()
    assert view == before
    assert view.find("loopback", "alpha").task_ready is True


def test_the_view_has_no_references_back_into_the_assessments(world):
    _, assessments, _ = world
    view = _view(assessments)
    for snap in view.candidates:
        for value in dataclasses.astuple(snap):
            assert not hasattr(value, "states")


# ── recommendations: valid, invalid, and disagreement ───────────────────


def test_recommending_the_authoritative_choice_is_valid_with_no_disagreement(world):
    _, assessments, _ = world
    result = lv.review_recommendation(_view(assessments),
                                      lv.LayaRecommendation("loopback", "alpha"))
    assert result.valid is True and result.disagreement is None


def test_recommending_a_different_ready_candidate_is_recorded_not_applied(world):
    _, assessments, _ = world
    view = _view(assessments)
    result = lv.review_recommendation(view, lv.LayaRecommendation("loopback", "beta"))
    assert result.valid is True
    assert result.disagreement.kind == "different-candidate"
    assert view.authoritative_choice == ("loopback", "alpha")


def test_laya_cannot_add_a_candidate_outside_the_view(world):
    _, assessments, _ = world
    result = lv.review_recommendation(_view(assessments),
                                      lv.LayaRecommendation("elsewhere", "ghost"))
    assert result.valid is False
    assert result.disagreement.kind == "laya-not-in-view"


def test_laya_cannot_recommend_an_unhealthy_candidate(world):
    _, assessments, _ = world
    result = lv.review_recommendation(_view(assessments),
                                      lv.LayaRecommendation("loopback", "sick"))
    assert result.valid is False
    assert result.disagreement.kind == "laya-not-ready"


def test_laya_cannot_recommend_a_paid_candidate_even_with_a_valid_grant(world):
    _, assessments, _ = world
    view = _view(assessments)
    snap = view.find("paid-api", "big")
    assert snap.grant_valid is True and snap.policy_eligible is True
    result = lv.review_recommendation(view, lv.LayaRecommendation("paid-api", "big"))
    assert result.valid is False
    assert result.disagreement.kind == "laya-not-ready"
    assert any("dispatch" in r for r in snap.not_ready_reasons)


def test_when_the_authority_chose_nothing_laya_suggestion_is_recorded_not_adopted(world):
    _, assessments, _ = world
    view = _view(assessments, choice=None)
    result = lv.review_recommendation(view, lv.LayaRecommendation("loopback", "alpha"))
    assert result.valid is True
    assert result.disagreement.kind == "authority-none-laya-suggested"
    assert view.authoritative_choice is None


def test_an_overlong_rationale_is_refused(world):
    _, assessments, _ = world
    result = lv.review_recommendation(
        _view(assessments),
        lv.LayaRecommendation("loopback", "alpha", rationale="x" * (lv.MAX_RATIONALE_CHARS + 1)))
    assert result.valid is False
    assert any("rationale" in e for e in result.errors)


def test_only_a_recommendation_object_is_accepted(world):
    _, assessments, _ = world
    result = lv.review_recommendation(_view(assessments), {"endpoint_id": "loopback"})
    assert result.valid is False


def test_a_recommendation_has_no_fields_for_spend_permission_policy_or_dispatch():
    names = {f.name for f in dataclasses.fields(lv.LayaRecommendation)}
    assert names == {"endpoint_id", "model_name", "rationale"}


def test_reviewing_a_recommendation_does_not_change_the_view(world):
    _, assessments, _ = world
    view = _view(assessments)
    snapshot = dataclasses.asdict(view)
    lv.review_recommendation(view, lv.LayaRecommendation("loopback", "beta"))
    lv.review_recommendation(view, lv.LayaRecommendation("nope", "nope"))
    assert dataclasses.asdict(view) == snapshot


# ── Laya cannot affect authoritative routing ────────────────────────────


def test_the_router_does_not_import_the_laya_view():
    source = inspect.getsource(mr)
    assert "laya_view" not in source
    assert "Laya" not in source


def test_no_execution_path_imports_the_laya_view():
    """Only the observational shadow path may import the view. Routing, execution and
    the API must not, so Laya's view cannot influence what runs."""
    root = Path(lv.__file__).resolve().parents[2]
    allowed = {"laya_view.py", "shadow_view.py"}
    offenders = []
    for path in root.rglob("*.py"):
        if path.name in allowed or "tests" in path.parts:
            continue
        if "laya_view" in path.read_text(encoding="utf-8", errors="ignore"):
            offenders.append(str(path.relative_to(root)))
    assert offenders == []


def test_recording_a_disagreement_leaves_the_router_decision_unchanged(world, monkeypatch):
    records, assessments, policy = world
    monkeypatch.setenv(mr.POLICY_ROUTING_ENV, "1")
    import tempfile

    from aura.sovereign.model_registry import ModelRegistry
    from aura.sovereign.usage_ledger import UsageLedger

    reg = ModelRegistry()
    for r in records[:3]:
        reg.register_manual(r)
    ledger = UsageLedger(Path(tempfile.mkdtemp()) / "u.sqlite3")
    router = mr.ModelRouter(reg, policy=policy, sovereign=SovereignPolicy())
    before = router.route("Summarise this report")
    view = _view(assessments)
    lv.review_recommendation(view, lv.LayaRecommendation("loopback", "beta"))
    after = router.route("Summarise this report")
    assert before.record is after.record
    assert before.reason == after.reason
