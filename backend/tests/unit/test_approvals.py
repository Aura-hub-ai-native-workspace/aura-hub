"""Approval ledger invariant tests — the frozen semantics, locked.

TS reference: capability-fabric/src/fabric.ts:336–670 + approvalStore.ts.
End-to-end invoke() differential lands at Phase 4 (see status ledger).
"""

from __future__ import annotations

from aura.approvals import ApprovalLedger, approval_key, usable_pending

CTX_MISSION = {"missionId": "m1", "taskId": "t1", "projectId": "p1"}
CTX_RUN = {"runId": "wr-1", "workflowNodeId": "n-ag"}
FP = "8d7839564ce695cfa9e0421c10a55d06"  # frozen V1 vector


def _request(rid="apr-x", state="pending", **kw):
    base = {
        "id": rid,
        "state": state,
        "requestedAt": "2026-08-24T10:00:00.000Z",
        "summary": "s",
        "items": [{"invocationId": "inv-1", "capabilityId": "filesystem.write",
                   "title": "t", "detail": "d", "risk": "medium",
                   "irreversible": False, "fingerprint": FP}],
        "rule": "risk-default:medium",
        "projectId": "p1",
    }
    base.update(kw)
    return base


def test_approval_key_identity_shapes():
    assert approval_key("c", CTX_MISSION, "inv-9") == "m1:t1:c"
    assert approval_key("c", CTX_RUN, "inv-9") == "wr-1:n-ag:c"
    assert approval_key("c", {}, "inv-9") == "inv:inv-9"
    # mission/task wins over run identity
    both = {**CTX_MISSION, **CTX_RUN}
    assert approval_key("c", both, "i") == "m1:t1:c"


def test_decide_is_once_only_and_audits():
    audit: list[dict] = []
    led = ApprovalLedger(audit_append=audit.append)
    req = _request()
    led.register(approval_key("filesystem.write", CTX_MISSION, "inv-1"), req)

    out = led.decide(req["id"], granted=False, decided_by="user", reason="no")
    assert out and out["state"] == "denied" and out["decidedBy"] == "user"

    # second decision finds nothing pending — replay is harmless
    assert led.decide(req["id"], granted=True) is None

    # exact audit projection of a human decision (fabric.ts:385–405)
    rec = audit[0]
    assert rec["decision"] == "ask-user"                      # gate rule was risk-default
    assert rec["decisionRule"] == "risk-default:medium"
    assert rec["outcome"] == "denied"
    assert rec["approvalDecision"] == "denied"
    assert rec["verified"] is None and rec["durationMs"] == 0
    assert rec["inputSummary"] == "decision reason: no"


def test_irreversible_floor_decision_label_in_audit():
    audit: list[dict] = []
    led = ApprovalLedger(audit_append=audit.append)
    req = _request(rule="irreversible-floor")
    led.register("k", req)
    led.decide(req["id"], granted=True)
    assert audit[0]["decision"] == "require-approval"
    assert audit[0]["outcome"] == "awaiting-approval"


def test_consume_single_use():
    led = ApprovalLedger()
    req = _request(state="granted")
    led.register("k", req)
    assert led.consume(req["id"]) is not None
    assert led.consume(req["id"]) is None                    # replay refused
    pending_only = _request(state="pending")
    led.replace("k2", pending_only)
    assert led.consume(pending_only["id"]) is None           # pending cannot be spent


def test_named_approval_usability_requires_all_three():
    led = ApprovalLedger()
    good = _request(state="granted")
    assert ApprovalLedger.named_approval_usable(good, "filesystem.write", FP)

    assert not ApprovalLedger.named_approval_usable(good, "other.cap", FP)          # wrong cap
    assert not ApprovalLedger.named_approval_usable(good, "filesystem.write", "0" * 32)  # wrong args
    spent = dict(good); spent["consumedAt"] = "2026-08-24T11:00:00.000Z"
    assert not ApprovalLedger.named_approval_usable(spent, "filesystem.write", FP)  # already spent
    denied = dict(good); denied["state"] = "denied"
    assert not ApprovalLedger.named_approval_usable(denied, "filesystem.write", FP) # never granted
    assert not ApprovalLedger.named_approval_usable(None, "filesystem.write", FP)   # gone


def test_pending_only_persistence_roundtrip(tmp_path):
    from aura.jsonutil import dumps_pretty
    f = tmp_path / "fabric-approvals.json"

    def save(items): f.write_text(dumps_pretty([r for r in items]), encoding="utf-8")
    def load(): return __import__("json").loads(f.read_text()) if f.exists() else []

    led1 = ApprovalLedger()
    led1.attach_store(load, save)
    p = _request()
    g = _request(rid="apr-g", state="granted", consumedAt="2026-08-24T10:30:00.000Z")
    led1.register(approval_key("filesystem.write", CTX_MISSION, "i"), p)   # has run/mission ids? mission ctx
    led1.register("k2", g)   # granted → must NOT persist

    raw = load()
    assert len(raw) == 1 and raw[0]["id"] == "apr-x"       # only pending hit disk

    led2 = ApprovalLedger()
    led2.attach_store(load, save)                          # restart restores pending only
    assert [r["id"] for r in led2.pending()] == ["apr-x"]
    assert led2.by_id("apr-g") is None                     # unspent grant did NOT survive


def test_restore_skips_unusable_entries():
    led = ApprovalLedger()
    junk = [{"state": "pending"}, {"id": "apr-noitems", "state": "pending", "items": []},
            "string", {"id": "apr-ok", "state": "pending", "items": [{"capabilityId": "c"}]}]
    seen: list = []
    for j in junk:
        if usable_pending(j):
            seen.append(j)
    assert len(seen) == 1 and seen[0]["id"] == "apr-ok"
