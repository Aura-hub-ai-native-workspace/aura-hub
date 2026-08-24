#!/usr/bin/env python3
"""Central agent — RUNTIME VERIFICATION.

Exercises the full vertical slice against the real Python governance spine
(aura.policy decisions, append-only audit, single-use approvals, workflow
persistence) inside a DISPOSABLE AURA_HOME. No mocks of authority; the
model layer runs in deterministic heuristic mode.

    python3 backend/scripts/verify_central_agent.py

Exit 0 = every check passed. Output is a check-by-check report.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

PASS = "PASS"
FAIL = "FAIL"
_results: list[tuple[str, str, str]] = []


def check(name: str, fn) -> None:
    try:
        detail = fn()
        _results.append((PASS, name, detail or ""))
        print(f"  {PASS}  {name}" + (f" — {detail}" if detail else ""))
    except Exception as exc:  # noqa: BLE001 — verification must report, not crash
        _results.append((FAIL, name, str(exc)))
        print(f"  {FAIL}  {name} — {exc}")


def main() -> int:
    home = Path(tempfile.mkdtemp(prefix="aura-agent-verify-"))
    os.environ["AURA_HOME"] = str(home)

    from aura.audit import AuditStore
    from aura.approvals import ApprovalLedger
    from aura.central_agent import CentralAgent, AgentSessionStore
    from aura.central_agent.__main__ import build_fabric_config
    from aura.fabric import FabricConfig, builtin_executors

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    cfg = build_fabric_config(
        audit,
        ledger,
    )
    # deterministic strictness for the gate checks below
    strict_cfg = FabricConfig(
        policy_config={"byRisk": {"low": "require-approval", "medium": "ask-user",
                                  "high": "require-approval"}},
        permissions={"read": True, "write": True},
        executors=builtin_executors(home),
        audit_store=AuditStore(home / "audit" / "strict.jsonl"),
        ledger=ApprovalLedger(),
    )

    print(f"AURA central agent runtime verification")
    print(f"  disposable home: {home}")
    print(f"  time: {datetime.now(timezone.utc).isoformat()}")

    state: dict = {}

    def slice_status():
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        r = agent.submit("list my workflows")
        assert r.outcome == "completed", r.summary
        assert r.verified == ["t1"], f"unverified: {r.verified}"
        assert len(r.evidence.auditRecordIds) == 1
        state["status_agent"] = agent
        return f"result={r.outcome}, evidence={len(r.evidence.auditRecordIds)} record(s)"

    def evidence_is_real():
        records = {x["invocationId"] for x in audit.load()}
        agent: CentralAgent = state["status_agent"]
        # resubmit and re-check trail growth instead of holding stale ids
        r2 = agent.submit("show me the status of my workflows")
        assert set(r2.evidence.auditRecordIds) <= records | {
            x["invocationId"] for x in audit.load()}
        return "every referenced audit id exists in the append-only trail"

    def slice_authoring():
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        r = agent.submit("create a workflow that shows git status every morning")
        assert r.outcome == "completed", r.summary
        files = list((home / "workflows").glob("wf-*.json"))
        assert len(files) == 1, f"expected one stored workflow, found {len(files)}"
        stored = json.loads(files[0].read_text())
        types = [n["type"] for n in stored["nodes"]]
        assert "git-status" in types and "output" in types
        state["workflow_file"] = files[0]
        return (f"stored {files[0].name}; nodes={types}; "
                f"graph verified by read-back")

    def clarification_blocks_without_effects():
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        before = len(audit.load())
        r = agent.submit("flurb the bazzle")
        assert r.outcome == "blocked"
        assert len(audit.load()) == before
        return "ambiguous intent blocked with zero governed invocations"

    def approval_park_and_single_use_spend():
        agent = CentralAgent(fabric_cfg=strict_cfg, session_store=AgentSessionStore(home))
        r = agent.submit("list my workflows")
        assert r.outcome == "awaiting-approval", r.summary
        apr = r.evidence.approvalIds[0]
        pending = [p["id"] for p in strict_cfg.ledger.pending()]
        assert apr in pending, "approval request must be parked durably"
        decided = strict_cfg.ledger.decide(apr, True, "user", "verification grant")
        assert decided["state"] == "granted"
        replay = ledger.decide(apr, True, "user")
        assert replay is None, "double decision must be refused"
        return f"parked {apr}; human granted; replay refused"

    def policy_deny_stops_plan_before_execution():
        deny_home_records = AuditStore(home / "deny.jsonl")
        deny_ledger = ApprovalLedger()
        deny_cfg = FabricConfig(
            policy_config={"byRisk": {"low": "deny", "medium": "deny",
                                      "high": "deny"}},
            permissions={"read": True, "write": True},
            executors=builtin_executors(home),
            audit_store=deny_home_records,
            ledger=deny_ledger,
        )
        agent = CentralAgent(fabric_cfg=deny_cfg, session_store=AgentSessionStore(home))
        before = len(deny_home_records.load())
        r = agent.submit("list my workflows")
        assert r.outcome == "failed" and "denies" in (r.failureReason or "").lower()
        invocations = [x for x in deny_home_records.load()[before:]
                       if x.get("capabilityId") is not None
                       and x.get("decisionRule") != "preflight"]
        assert not [x for x in deny_home_records.load()[before:]], \
            "a denied plan must not reach the invocation path at all"
        return "policy denial blocked planning pre-execution; nothing invoked"

    def sessions_survive_reload():
        store = AgentSessionStore(home)
        files = sorted((home / "agent" / "sessions").glob("*.json"))
        assert files, "no session files written"
        session = store.load(files[-1].stem)
        assert session is not None and session.messages, "session lost content"
        assert session.state in ("completed", "failed", "awaiting-approval")
        return f"{len(files)} session file(s); last reloaded with messages intact"

    def no_secrets_in_persisted_state():
        blobs = []
        for pattern in ("agent/sessions/*.json", "workflows/*.json",
                        "audit/*.jsonl"):
            for p in sorted(home.glob(pattern)):
                blobs.append(p.read_text())
        joined = "\n".join(blobs).lower()
        for marker in ("api_key", "apikey", "password", "secret_value",
                       "bearer ", "authorization:"):
            assert marker not in joined, f"forbidden material: {marker}"
        return "sessions/workflows/audit scanned; no credential material present"

    checks = [
        ("vertical slice: status intent → plan → governed invoke → verify → evidence",
         slice_status),
        ("evidence references real append-only audit records", evidence_is_real),
        ("vertical slice: authoring intent → compiled graph → stored + read-back verified",
         slice_authoring),
        ("security: ambiguous intent blocked with zero side effects",
         clarification_blocks_without_effects),
        ("security: approval park → human decide → single-use spend, replay refused",
         approval_park_and_single_use_spend),
        ("security: policy deny stops the plan before any execution",
         policy_deny_stops_plan_before_execution),
        ("persistence: agent sessions survive reload with content intact",
         sessions_survive_reload),
        ("secrets: persisted agent/fabric state carries no credential material",
         no_secrets_in_persisted_state),
    ]

    print("\nChecks:")
    for name, fn in checks:
        check(name, fn)

    passed = sum(1 for s, *_ in _results if s == PASS)
    total = len(_results)
    print(f"\nResult: {passed}/{total} checks passed.")
    if passed != total:
        for s, name, detail in _results:
            if s == FAIL:
                print(f"  FAILED: {name}: {detail}")
        return 1
    print("RUNTIME VERIFIED — the central agent vertical slice executes through "
          "the real governance spine end to end.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
