"""jsonutil — Node-compatible serialization byte-parity unit tests.

Expected strings here are what JSON.stringify produces in Node 22 (verified
against the runtime during Phase 0 fixture generation).
"""

from __future__ import annotations

import json

from aura.jsonutil import (
    append_jsonl,
    dumps_compact,
    dumps_pretty,
    read_json_file,
    read_jsonl,
    write_json_atomic,
)


def test_compact_matches_node():
    assert dumps_compact({"a": 1, "b": [1, 2], "c": {"d": "x"}}) == '{"a":1,"b":[1,2],"c":{"d":"x"}}'
    assert dumps_compact([]) == "[]"
    assert dumps_compact({}) == "{}"
    assert dumps_compact({"s": "héllo"}) == '{"s":"héllo"}'  # ensure_ascii=False
    assert dumps_compact({"n": None, "t": True}) == '{"n":null,"t":true}'


def test_pretty_matches_node_two_space_indent():
    obj = {"a": 1, "b": {"c": [1, 2]}, "d": []}
    expected = '{\n  "a": 1,\n  "b": {\n    "c": [\n      1,\n      2\n    ]\n  },\n  "d": []\n}'
    assert dumps_pretty(obj) == expected
    assert not dumps_pretty(obj).endswith("\n")


def test_atomic_write_and_tolerant_read(tmp_path):
    f = tmp_path / "store.json"
    write_json_atomic(f, {"x": 1}, pid=4242)
    assert f.read_text(encoding="utf-8") == '{\n  "x": 1\n}'
    assert list(tmp_path.glob("*.tmp")) == [], "tmp file must not survive rename"

    # corrupt file → fallback, never raises (persist.ts semantics)
    f.write_text("{broken", encoding="utf-8")
    assert read_json_file(f, {"fallback": True}) == {"fallback": True}
    assert read_json_file(tmp_path / "missing.json", []) == []


def test_jsonl_append_read_and_truncated_tail(tmp_path):
    f = tmp_path / "trail.jsonl"
    append_jsonl(f, {"i": 1})
    append_jsonl(f, {"i": 2})
    raw = f.read_text(encoding="utf-8")
    assert raw == '{"i":1}\n{"i":2}\n'
    with open(f, "a", encoding="utf-8") as fh:
        fh.write('{"i":3')  # simulated interrupted append
    loaded = read_jsonl(f)
    assert [r["i"] for r in loaded] == [1, 2]  # truncated line skipped, not fatal


def test_compact_roundtrips_through_json_module_equivalence():
    payload = {"k": ["v", 3, None, True], "nested": {"z": 1, "a": 2}}
    assert json.loads(dumps_compact(payload)) == payload
