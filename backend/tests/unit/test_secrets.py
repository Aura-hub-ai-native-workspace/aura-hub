"""Secrets subsystem — frozen behavior from ai-service/secrets.ts.

Negative controls: values never persist plaintext, never survive in
summaries after redaction, missing refs fail loudly, corruption fails safe.
"""
from __future__ import annotations

import json
import os

import pytest

from aura.secrets import REDACTION, REFERENCE, SecretStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.delenv("AURA_SECRET_SEED", raising=False)
    return SecretStore()


def test_set_list_has_remove_roundtrip(store):
    info = store.set("TOKEN_A", "abcdef123456", note="ci")
    assert info["name"] == "TOKEN_A" and info["length"] == 12 and info["note"] == "ci"
    assert store.has("TOKEN_A")
    names = [i["name"] for i in store.list()]
    assert names == ["TOKEN_A"]
    assert store.remove("TOKEN_A") is True
    assert store.remove("TOKEN_A") is False and not store.has("TOKEN_A")


def test_name_validation_and_empty_value(store):
    with pytest.raises(RuntimeError, match="letters, numbers"):
        store.set("bad name!", "x")
    with pytest.raises(RuntimeError, match="needs a value"):
        store.set("OK", "")


def test_value_never_persisted_plaintext(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    s = SecretStore()
    s.set("K", "super-secret-value-9")
    raw = (tmp_path / "secrets.json").read_text()
    assert "super-secret-value-9" not in raw          # SECURITY: no plaintext at rest
    assert s._reveal("K") == "super-secret-value-9"   # but decryptable with the seed


def test_missing_reference_fails_loudly(store):
    with pytest.raises(RuntimeError) as ei:
        store.resolve("call {{secret:NOPE_X}} now")
    m = str(ei.value)
    assert "NOPE_X" in m and "Settings → Secrets" in m
    # and never returns the literal reference as if it were a value


def test_redaction_visible_marker_longest_first(store):
    store.set("SHORT", "abcd1234")
    store.set("LONG", "abcd1234and-more-secret-tail")
    scrub = store.redactor()
    out = scrub("leak abcd1234and-more-secret-tail then abcd1234")
    assert out.count(REDACTION) == 2                   # longest-first: both fully covered
    assert "abcd1234and-more" not in out


def test_short_values_are_not_redacted(store):
    store.set("TINY", "ab")                            # <4 chars: not a credential
    scrub = store.redactor()
    assert scrub("keep ab intact") == "keep ab intact"


def test_restart_persistence_and_touch(store):
    s = SecretStore()
    s.set("K2", "value-for-restart-7")
    s2 = SecretStore()                                 # fresh instance == restart
    r = s2.resolve("x={{secret:K2}} y={{secret:K2}}")
    assert r["used"] == ["K2", "K2"]   # TS parity: used accumulates per replacement
    info = [i for i in s2.list() if i["name"] == "K2"][0]
    assert info["lastUsedAt"] is not None              # touch persisted


def test_corruption_fails_safe_as_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    s = SecretStore(); s.set("K3", "value-abc-12345678")
    f = tmp_path / "secrets.json"
    doc = json.loads(f.read_text())
    doc["secrets"]["K3"]["tag"] = "00" * 16            # tamper → GCM fail
    f.write_text(json.dumps(doc))
    with pytest.raises(RuntimeError, match="not stored: K3"):
        s.resolve("{{secret:K3}}")


def test_env_seed_moves_key_without_file_seed(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_SECRET_SEED", "aa" * 32)
    s = SecretStore(); s.set("E1", "env-seeded-value-99")
    monkeypatch.delenv("AURA_SECRET_SEED")
    # seed gone from env → file has none (env mode never wrote one) → unreadable
    with pytest.raises(RuntimeError, match="not stored: E1"):
        s.resolve("{{secret:E1}}")
    monkeypatch.setenv("AURA_SECRET_SEED", "aa" * 32)
    assert s.resolve("{{secret:E1}}")["text"] == "env-seeded-value-99"


def test_reference_regex_conservative():
    assert REFERENCE.fullmatch("{{secret:has space}}") is None   # space invalid in name
    assert len(REFERENCE.findall("{{secret:" + "x" * 65 + "}}")) == 0  # >64 chars rejected
    assert len(REFERENCE.findall("{{secret:A}} {{secret:B}}")) == 2
