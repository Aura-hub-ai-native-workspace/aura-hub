"""Runtime verification — the ported Fabric driving REAL persisted state.

Proves, on disk, in one story:
  1. a gated invocation persists a PENDING approval the moment it is asked;
  2. no execution record exists for something that has not run;
  3. a human decision is audited immediately;
  4. a fresh process restores pending state + audit tail and can spend;
  5. single-use spend leaves the approvals file empty afterwards.
"""

from __future__ import annotations

import asyncio
import json

from aura.fabric import CapabilityFabric
from aura.jsonutil import read_json_file, read_jsonl


class Host:
    def permissions_for(self, _cap, _ctx):
        return {"read": True, "write": True, "execute": True, "autonomous": True}

    def node_available(self, _cap):
        return True

    async def request_approval(self, _request, _ctx):
        return False  # always park; decisions come from decide_approval()


class WriteExecutor:
    capabilityId = "filesystem.write"

    async def run(self, _inv):
        return {"ok": True, "detail": "wrote", "output": {"bytes": 2}}

    async def verify(self, _inv, _last):
        return {"passed": True, "kind": "read-back", "detail": "matches"}

def _build(home, events):
    f = CapabilityFabric(Host())
    f.listen(events.append)
    f.register(WriteExecutor())

    ap_file = home / "fabric-approvals.json"
    au_file = home / "fabric-audit.jsonl"

    def a_load():
        raw = read_json_file(ap_file, [])
        return [r for r in raw if isinstance(r, dict) and r.get("state") == "pending"
                and r.get("items") and isinstance(r["items"][0].get("capabilityId"), str)]

    def a_save(reqs):
        import os
        ap_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = f"{ap_file}.{os.getpid()}.tmp"
        tmp_path = __import__("pathlib").Path(tmp)
        tmp_path.write_text(json.dumps(reqs, indent=2), encoding="utf-8")
        os.replace(tmp_path, ap_file)

    def au_load():
        return read_jsonl(au_file)

    def au_append(rec):
        au_file.parent.mkdir(parents=True, exist_ok=True)
        with open(au_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")

    f.attach_approval_store(a_load, a_save)
    f.attach_audit_store(au_load, au_append)
    return f


CTX = {"actor": {"kind": "agent", "id": "agent:workflow"}, "projectId": "p",
       "missionId": "m", "taskId": "t"}


def test_full_runtime_story(tmp_path):
    events: list[dict] = []

    # ── process 1: invoke parks; nothing ran yet ────────────────────────────
    fabric = _build(tmp_path, events)
    r1 = asyncio.run(fabric.invoke(
        "filesystem.write", {"path": "src/a.ts", "content": "hi"}, dict(CTX)))
    assert r1["outcome"] == "awaiting-approval" and "attempts" in r1
    assert r1["attempts"] == 0                      # nothing executed
    assert all(e["type"] != "invocation.started" for e in events)

    ap_file = tmp_path / "fabric-approvals.json"
    au_file = tmp_path / "fabric-audit.jsonl"
    pending_on_disk = json.loads(ap_file.read_text())
    assert len(pending_on_disk) == 1 and pending_on_disk[0]["state"] == "pending"
    # A PARKED invocation is audited too (settle runs for awaiting-approval):
    # the trail says "asked, waiting", with attempts=0 proving nothing ran.
    parked_audit = [json.loads(x) for x in au_file.read_text().splitlines() if x.strip()]
    assert len(parked_audit) == 1
    assert parked_audit[0]["outcome"] == "awaiting-approval"
    assert parked_audit[0]["approvalId"] == r1["approvalId"]

    # ── process 1 ends HERE without deciding (crash/close semantics) ────────
    # Decided grants NEVER persist (pending-only store), so the honest
    # cross-restart flow is: pending survives, decision happens after.

    # ── process 2: restart restores the pending question + audit tail ───────
    events2: list[dict] = []
    fabric2 = _build(tmp_path, events2)
    aid = r1["approvalId"]
    assert fabric2.approval_by_id(aid) is not None          # restored from disk
    started = [e for e in events2 if e["type"].startswith("invocation")]
    assert not started                                       # fresh process, quiet

    # human grants IN THE NEW PROCESS, then the SAME call is re-made by the
    # workflow engine; the standing grant is spent once, exactly once.
    decided = fabric2.decide_approval(aid, granted=True)
    assert decided and decided["state"] == "granted"
    decision_records = [r for r in fabric2.audit_log if r.get("approvalDecision")]
    assert len(decision_records) == 1

    r2 = asyncio.run(fabric2.invoke(
        "filesystem.write", {"path": "src/a.ts", "content": "hi"},
        {**CTX, "approvalId": aid}))
    assert r2["outcome"] == "succeeded"
    assert r2["verification"]["passed"] is True
    assert any(e["type"] == "invocation.started" for e in events2)
    assert any(e["type"] == "verification.passed" for e in events2)

    # single-use + pending-only: approvals file holds NOTHING after the spend
    on_disk_after = json.loads(ap_file.read_text())
    assert on_disk_after == []

    # audit trail carries: parked-leg record, human decision, execution record
    exec_records = [r for r in fabric2.audit_log
                    if r.get("capabilityId") == "filesystem.write"
                    and r.get("approvalDecision") is None
                    and r.get("outcome") == "succeeded"]
    assert len(exec_records) == 1
    rec = exec_records[0]
    assert rec["decision"] == "ask-user"                     # gate that opened it
    assert rec["decisionRule"] == "risk-default:medium"
    assert rec["verified"] is True
    assert rec["inputSummary"] == "path=src/a.ts content=hi"

    assert rec["inputSummary"] == "path=src/a.ts content=hi"
