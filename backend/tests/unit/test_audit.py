"""Audit store tests — append-only, caps, trim-oldest, truncated-tail tolerance."""

from __future__ import annotations

import json

from aura.audit import AuditStore
from aura.jsonutil import dumps_compact


def _rec(i: int) -> dict:
    return {"invocationId": f"inv{i}", "at": "2026-08-24T10:00:00.000Z",
            "capabilityId": "c", "actor": {"kind": "system", "id": "s"},
            "projectId": None, "risk": "low", "decision": "auto-execute",
            "decisionRule": "risk-default:low", "outcome": "succeeded",
            "verified": True, "durationMs": 1, "inputSummary": ""}


def test_append_load_and_truncated_tail(tmp_path):
    f = tmp_path / "fabric-audit.jsonl"
    store = AuditStore(f)
    store.append(_rec(1))
    store.append(_rec(2))
    with open(f, "a", encoding="utf-8") as fh:
        fh.write('{"invocationId": "inv3"')  # interrupted append
    loaded = store.load()
    assert [r["invocationId"] for r in loaded] == ["inv1", "inv2"]


def test_unusable_lines_skipped_on_load(tmp_path):
    f = tmp_path / "a.jsonl"
    lines = [_rec(1), {"invocationId": "", "at": "x", "capabilityId": "c"},
             {"nope": 1}, _rec(2)]
    f.write_text("".join(dumps_compact(l) + "\n" for l in lines), encoding="utf-8")
    assert [r["invocationId"] for r in AuditStore(f).load()] == ["inv1", "inv2"]


def test_trim_drops_oldest_only_past_trigger(tmp_path, monkeypatch):
    """Trim fires only when count > TRIM_TRIGGER (6000), keeps newest 5000."""
    f = tmp_path / "big.jsonl"
    records = [_rec(i) for i in range(6001)]
    f.write_text("".join(dumps_compact(r) + "\n" for r in records), encoding="utf-8")

    store = AuditStore(f)
    store._since_trim = 999          # next append crosses the 1000 check
    store.append(_rec(9999))

    kept = [json.loads(ln) for ln in f.read_text().split("\n") if ln.strip()]
    assert len(kept) == 5000
    assert kept[-1]["invocationId"] == "inv9999"
    # 6002 records − 5000 kept = 1002 dropped from the front
    assert kept[0]["invocationId"] == "inv1002"

    # Below trigger: no trim even after the periodic check
    f2 = tmp_path / "small.jsonl"
    f2.write_text("".join(dumps_compact(_rec(i)) + "\n" for i in range(50)), encoding="utf-8")
    s2 = AuditStore(f2)
    s2._since_trim = 999
    s2.append(_rec(51))
    assert len([ln for ln in f2.read_text().split("\n") if ln.strip()]) == 51


def test_load_caps_at_5000_without_rewriting(tmp_path):
    f = tmp_path / "huge.jsonl"
    n = 5100
    f.write_text("".join(dumps_compact(_rec(i)) + "\n" for i in range(n)), encoding="utf-8")
    before = f.read_text()
    loaded = AuditStore(f).load()
    assert len(loaded) == 5000 and loaded[0]["invocationId"] == "inv100"
    assert f.read_text() == before   # load never rewrites the trail
