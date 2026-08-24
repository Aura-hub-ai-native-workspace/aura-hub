"""Python-side persistence invariants that the cross-language script excludes
(scale retention, CSPRNG tokens, schedule-state file), plus focused
corruption/atomicity checks against live stores.
"""

from __future__ import annotations

import json

from aura.persistence.automation import load_schedule_state, save_schedule_state
from aura.persistence.runs import WorkflowRunStore
from aura.persistence.workflows import WorkflowStore
from aura.jsonutil import read_json_file


def _mk_run(store: WorkflowRunStore, wf_id: str, i: int, state="succeeded") -> dict:
    run = store.create({
        "workflowId": wf_id, "versionId": "v1", "workflowName": "W",
        "projectId": "p", "projectPath": "/p",
        "trigger": {"kind": "manual", "by": "user"},
    })
    run["state"] = state
    store.save(run)
    return run


def test_retention_prunes_oldest_terminal_past_200(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    store = WorkflowRunStore()
    for i in range(203):
        _mk_run(store, "wf-x", i)
    summaries = store.list("wf-x")
    assert len(summaries) == 200                      # capped
    # non-terminal runs are NEVER pruned even when oldest
    pinned = _mk_run(store, "wf-x", 999, state="awaiting-approval")
    for i in range(5):
        _mk_run(store, "wf-x", 1000 + i)
    ids = {s["id"] for s in store.list("wf-x")}
    assert pinned["id"] in ids                        # parked run survived


def test_index_is_cache_rebuilt_from_authority(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    store = WorkflowRunStore()
    a = _mk_run(store, "wf-a", 1)
    b = _mk_run(store, "wf-b", 2)
    idx = tmp_path / "workflow-runs" / "index.json"
    assert idx.exists() and len(json.loads(idx.read_text())["runs"]) == 2

    # corrupt cache → list() silently rebuilds from run files (the truth)
    idx.write_text("{broken", encoding="utf-8")
    got = store.list()
    assert {r["id"] for r in got} == {a["id"], b["id"]}
    fresh = json.loads(idx.read_text())
    assert fresh["version"] == 1 and len(fresh["runs"]) == 2


def test_atomic_write_leaves_no_tmp_and_survives_crash_shape(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    ws = WorkflowStore()
    wf = ws.create({"name": "X", "nodes": [], "edges": []})
    leftovers = [p.name for p in (tmp_path / "workflows").iterdir()]
    assert leftovers == [f"{wf['id']}.json"]          # no *.tmp residue after rename


def test_corrupt_workflow_file_degrades_to_null(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    ws = WorkflowStore()
    wf = ws.create({"name": "Y", "nodes": [], "edges": []})
    f = tmp_path / "workflows" / f"{wf['id']}.json"
    f.write_text('{"half', encoding="utf-8")
    assert ws.get(wf["id"]) is None                   # readJsonFile fallback semantics
    assert ws.list() == []                            # listing skips unusable


def test_schedule_state_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    assert load_schedule_state() == {}                # observed idle shape on disk
    save_schedule_state({"rule-1": {"missedCount": 3, "lastMissedAt": "2026-08-24T09:00:00.000Z"}})
    again = load_schedule_state()
    assert again["rule-1"]["missedCount"] == 3
    # byte format matches frozen writer (pretty, indent 2, no trailing newline)
    raw = (tmp_path / "automation" / "schedule-state.json").read_text()
    assert raw == json.dumps(json.loads(raw), indent=2, ensure_ascii=False)


def test_webhook_token_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    ws = WorkflowStore()
    wf = ws.create({"name": "T", "nodes": [], "edges": []})
    assert wf.get("webhookToken") is None             # lazily minted only
    t1 = ws.ensureWebhookToken(wf["id"])
    assert t1 and len(t1) == 48                       # randomBytes(24).hex
    assert ws.ensureWebhookToken(wf["id"]) == t1      # idempotent until rotated
    t2 = ws.rotateWebhookToken(wf["id"])
    assert t2 != t1
    assert ws.verifyWebhookToken(wf["id"], t2)["id"] == wf["id"]
    assert ws.verifyWebhookToken(wf["id"], t1) is None
    dup = ws.duplicate(wf["id"])                      # copies NEVER inherit tokens
    assert dup.get("webhookToken") is None
