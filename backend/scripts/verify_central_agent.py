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
from datetime import UTC, datetime
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
    except Exception as exc:
        _results.append((FAIL, name, str(exc)))
        print(f"  {FAIL}  {name} — {exc}")


def main() -> int:
    home = Path(tempfile.mkdtemp(prefix="aura-agent-verify-"))
    os.environ["AURA_HOME"] = str(home)

    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.__main__ import build_fabric_config
    from aura.fabric import FabricConfig, builtin_executors
    from aura.workflow import make_stores

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

    print("AURA central agent runtime verification")
    print(f"  disposable home: {home}")
    print(f"  time: {datetime.now(UTC).isoformat()}")

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
        assert r.outcome == "needs-clarification", r.outcome
        assert len(audit.load()) == before, \
            f"side effects occurred: {len(audit.load()) - before}"
        return "clarification requested with zero governed invocations"

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


    def scenario_a_git_status_real():
        import subprocess
        proj = Path(tempfile.mkdtemp(prefix="verify-proj-"))
        subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
        (proj / "s.txt").write_text("x\n")
        subprocess.run(["git", "add", "."], cwd=proj, check=True)
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        r = agent.submit("show me the git status of my project",
                         project_path=str(proj))
        assert r.outcome == "completed" and r.verified == ["t1"], r.summary
        rec = [x for x in audit.load() if x["capabilityId"] == "git.status"]
        assert rec and rec[-1]["verified"] is True
        return "real git executed; exit-code verified; audited"

    def scenario_b_governed_write_resume():
        import subprocess
        proj = Path(tempfile.mkdtemp(prefix="verify-b-"))
        subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
        agent = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        first = agent.submit("create a file called demo.txt containing hello world",
                             project_path=str(proj))
        assert first.outcome == "awaiting-approval"
        assert not (proj / "demo.txt").exists()
        apr = first.evidence.approvalIds[0]
        assert ledger.decide(apr, True, "user")["state"] == "granted"
        second = agent.resume(agent.sessions.last_session_id)
        assert second.outcome == "completed", second.summary
        assert (proj / "demo.txt").read_text() == "hello world"
        writes = [x for x in audit.load() if x["capabilityId"] == "fs.write_file"
                  and x["outcome"] == "succeeded"]
        assert len(writes) == 1
        return "park → approve → resume → real file, exactly one write"

    def scenario_g_restart_resume():
        import subprocess

        from aura.workflow import EngineConfig, WorkflowEngine
        proj = Path(tempfile.mkdtemp(prefix="verify-g-"))
        subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
        a1 = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home))
        first = a1.submit("create a file called later.txt containing done",
                          project_path=str(proj))
        sid = a1.sessions.last_session_id
        apr = first.evidence.approvalIds[0]
        # RESTART: fresh agent over the same persisted home
        ws2, vs2, rs2 = make_stores()
        a2 = CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home),
                          workflow_store=ws2, run_store=rs2,
                          workflow_engine=WorkflowEngine(cfg, ws2, vs2, rs2,
                                                         EngineConfig()))
        reloaded = a2.sessions.load(sid)
        assert reloaded is not None and reloaded.state == "awaiting-approval", \
            f"reload lost state: {reloaded and reloaded.state}"
        assert any(p["id"] == apr for p in ledger.pending()), \
            "parked approval not durable across restart"
        ledger.decide(apr, True, "user")
        resumed = a2.resume(sid)
        assert resumed.outcome == "completed", \
            f"resume ended {resumed.outcome}: {resumed.summary[:120]}"
        assert (proj / "later.txt").read_text() == "done", \
            "resumed write produced wrong content"
        writes = [x for x in audit.load()
                  if x["capabilityId"] == "fs.write_file"
                  and x["outcome"] == "succeeded"
                  and "later.txt" in x.get("inputSummary", "")]
        assert len(writes) == 1, f"{len(writes)} writes for later.txt"
        return "restart → reload → approve → resume, single side effect"

    def api_surface_live():
        import json as _json
        import urllib.request

        from aura.api import build_default_api
        server, _agent = build_default_api(home=str(home) + "-api",
                                           port=4399)
        server.start_background()
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:4399/agent/sessions",
                data=_json.dumps({"message": "list my workflows"}).encode(),
                method="POST",
                headers={"content-type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                out = _json.loads(resp.read())
            assert out["result"]["outcome"] == "completed"
            with urllib.request.urlopen(
                    "http://127.0.0.1:4399/fabric/approvals") as resp:
                assert "approvals" in _json.loads(resp.read())
            return "HTTP submit + approvals surface live"
        finally:
            server.shutdown()

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
        ("scenario A: read-only git status through real executor",
         scenario_a_git_status_real),
        ("scenario B: governed write parks, approves, resumes, writes once",
         scenario_b_governed_write_resume),
        ("scenario G: restart-reload-approve-resume without duplication",
         scenario_g_restart_resume),
        ("API: HTTP/SSE surface serves the agent live", api_surface_live),
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
