from __future__ import annotations

import json

from aura_backend.core.json_store import JsonStore, atomic_write_json, read_json


def test_round_trip(tmp_path):
    p = tmp_path / "a" / "b.json"
    atomic_write_json(p, {"x": 1})
    assert read_json(p) == {"x": 1}


def test_missing_file_yields_the_default(tmp_path):
    assert read_json(tmp_path / "nope.json", default=[]) == []


def test_corrupted_persistence_yields_the_default_instead_of_crashing(tmp_path):
    p = tmp_path / "broken.json"
    p.write_text("{not json", encoding="utf-8")
    assert read_json(p, default={"recovered": True}) == {"recovered": True}


def test_write_leaves_no_temp_files_behind(tmp_path):
    p = tmp_path / "s.json"
    store = JsonStore(p, default={})
    store.save({"n": 1})
    store.update(lambda v: {**v, "n": v["n"] + 1})
    assert json.loads(p.read_text()) == {"n": 2}
    assert [f.name for f in tmp_path.iterdir()] == ["s.json"]
