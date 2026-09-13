"""Phase 1.2: FabricConfig construction contracts.

Two paths exist and both are intentional:

1. NORMAL path — `build_fabric_config` wires a live CapabilityFabric;
   governed invocation works and policy overrides flow through
   `sanitized_policy` into authority preflight.
2. DIRECT path — a hand-rolled `FabricConfig` without `fabric=` is
   valid for pre-execution checks (policy denial never invokes), but
   any real invocation fails CLOSED with an honest RuntimeError rather
   than executing unwired.

These pin the distinction the verify script tripped over: strict gate
checks must use path 1, never a fabric-less config.
"""

from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent.__main__ import build_fabric_config
from aura.fabric import FabricConfig, invoke_fabric


def _stores(home: Path):
    audit = AuditStore(home / "audit.jsonl")
    return audit, ApprovalLedger(audit_append=audit.append)


def test_factory_wires_live_fabric_by_default(tmp_path: Path) -> None:
    audit, ledger = _stores(tmp_path)
    cfg = build_fabric_config(audit, ledger)
    assert cfg.fabric is not None
    assert cfg.policy_config == {}
    assert "git.status" in cfg.executors


def test_factory_honors_policy_override(tmp_path: Path) -> None:
    audit, ledger = _stores(tmp_path)
    strict = {"byRisk": {"low": "require-approval"}}
    cfg = build_fabric_config(audit, ledger, policy_config=strict)
    assert cfg.fabric is not None
    merged = cfg.sanitized_policy()
    assert merged["byRisk"]["low"] == "require-approval"
    # defaults survive alongside the override (merge, not replace)
    assert merged["byRisk"]["high"] == "require-approval"
    assert merged["byRisk"]["medium"] == "ask-user"


def test_strict_policy_parks_through_canonical_factory(tmp_path: Path) -> None:
    from aura.central_agent import AgentSessionStore, CentralAgent

    home = tmp_path
    audit, _ = _stores(home)
    cfg = build_fabric_config(
        audit, ApprovalLedger(),
        policy_config={"byRisk": {"low": "require-approval",
                                  "medium": "ask-user",
                                  "high": "require-approval"}})
    agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
    r = agent.submit("list my workflows")
    assert r.outcome == "awaiting-approval", r.summary
    assert r.evidence.approvalIds, "parked run must name its approval"


def test_fabricless_config_fails_closed_on_invoke(tmp_path: Path) -> None:
    audit, ledger = _stores(tmp_path)
    cfg = FabricConfig(permissions={"read": True}, executors={},
                       audit_store=audit, ledger=ledger)
    assert cfg.fabric is None
    with pytest.raises(RuntimeError, match="no CapabilityFabric wired"):
        invoke_fabric("git.status", {}, {"actor": {"kind": "agent"}}, cfg)


def test_git_status_audit_is_honest_null_check(tmp_path: Path) -> None:
    """git.status has no executor-level verifier BY DESIGN (parity with
    the TS reference, which omits `verify` where no check exists). The
    audit record must carry verified=None — an honest null check — and
    must never be upgraded to a pass without a real verifier."""
    from aura.central_agent import AgentSessionStore, CentralAgent

    home = tmp_path
    audit, ledger = _stores(home)
    cfg = build_fabric_config(audit, ledger)
    agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
    r = agent.submit("show me git status")
    assert r.outcome in ("completed", "failed"), r.summary
    recs = [x for x in audit.load() if x.get("capabilityId") == "git.status"]
    assert recs, "git.status must audit its record"
    assert recs[-1]["verified"] is None, recs[-1]
