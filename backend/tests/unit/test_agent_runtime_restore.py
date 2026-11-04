"""Manual restore uses the same multi-file, conflict-checked semantics as rollback."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aura.agent_runtime import transaction
from aura.agent_runtime.adapters import opencode as opencode_mod
from aura.agent_runtime.model import AuthType, ConfigStatus, RuntimeConfig
from aura.agent_runtime.service import AgentRuntimeService
from _agent_fakes import FakeAdapter, FakeRegistry

RUNTIME = RuntimeConfig(base_url="http://127.0.0.1:11434/v1",
                        model_id="m", auth_type=AuthType.KEYLESS, network_class="local")


def _service(tmp_path: Path, adapter) -> AgentRuntimeService:
    svc = AgentRuntimeService(store_dir=tmp_path / "backups")
    svc._registry = FakeRegistry(adapter)
    return svc


@pytest.fixture
def files(tmp_path):
    config = tmp_path / "config.json"
    key = tmp_path / "secret.key"
    config.write_bytes(b"ORIGINAL-CONFIG\n")
    key.write_bytes(b"OLD-KEY\n")
    return config, key


def _apply_verified(svc, config, key):
    change = svc.apply_agent("fake", RUNTIME)
    assert change.outcome == "applied_verified", change.note
    assert config.read_bytes() == b"NEW\n" and key.read_bytes() == b"COMPANION-NEW\n"
    return change


def test_manual_restore_covers_every_file_the_apply_wrote(tmp_path, files):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    _apply_verified(svc, config, key)

    restored = svc.restore_agent("fake")
    assert restored.status == ConfigStatus.OK
    assert restored.outcome == "restore_succeeded"
    assert config.read_bytes() == b"ORIGINAL-CONFIG\n"
    assert key.read_bytes() == b"OLD-KEY\n"


def test_partial_write_failure_during_restore_is_reported_per_file(tmp_path, files, monkeypatch):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    _apply_verified(svc, config, key)

    real_write = transaction._write_atomic
    calls = {"n": 0}

    def second_write_fails(path, data):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        real_write(path, data)

    monkeypatch.setattr(transaction, "_write_atomic", second_write_fails)
    change = svc.restore_agent("fake")
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "restore_failed"
    assert "earlier files may already be restored" in change.note
    assert config.read_bytes() == b"ORIGINAL-CONFIG\n"  # first file was restored
    assert key.read_bytes() == b"COMPANION-NEW\n"       # second file was not
    assert "writing" in change.note  # the failing file is named, not silent


def test_user_edit_to_any_file_refuses_the_whole_restore(tmp_path, files):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    _apply_verified(svc, config, key)
    key.write_bytes(b"USER-ROTATED-KEY\n")

    change = svc.restore_agent("fake")
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "restore_refused"
    assert "nothing was restored" in change.note
    assert config.read_bytes() == b"NEW\n"                # untouched, even though it was clean
    assert key.read_bytes() == b"USER-ROTATED-KEY\n"      # the user's edit is kept


def test_explicit_overwrite_policy_restores_despite_a_user_edit(tmp_path, files):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    _apply_verified(svc, config, key)
    key.write_bytes(b"USER-ROTATED-KEY\n")

    change = svc.restore_agent("fake", on_conflict="overwrite")
    assert change.status == ConfigStatus.OK
    assert config.read_bytes() == b"ORIGINAL-CONFIG\n"
    assert key.read_bytes() == b"OLD-KEY\n"


def test_restore_is_idempotent(tmp_path, files):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    _apply_verified(svc, config, key)

    first = svc.restore_agent("fake")
    second = svc.restore_agent("fake")
    assert first.outcome == "restore_succeeded"
    assert second.status == ConfigStatus.OK
    assert second.outcome == "not_needed"
    assert config.read_bytes() == b"ORIGINAL-CONFIG\n"
    assert key.read_bytes() == b"OLD-KEY\n"


def test_restore_without_a_recorded_apply_changes_nothing(tmp_path, files):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    change = svc.restore_agent("fake")
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "no_manifest"
    assert config.read_bytes() == b"ORIGINAL-CONFIG\n"


def test_tampered_backup_is_refused_before_anything_is_written(tmp_path, files):
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    _apply_verified(svc, config, key)

    backups = sorted((tmp_path / "backups").rglob("*.backup"))
    tampered = next(p for p in backups if p.read_bytes() == b"OLD-KEY\n")
    tampered.write_bytes(b"ATTACKER\n")

    change = svc.restore_agent("fake")
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "backup_integrity_failed"
    assert config.read_bytes() == b"NEW\n"
    assert key.read_bytes() == b"COMPANION-NEW\n"


def test_failure_to_record_the_manifest_undoes_the_apply(tmp_path, files, monkeypatch):
    from aura.agent_runtime import service as service_mod

    def no_manifest(*args, **kwargs):
        raise OSError("manifest store read-only")

    monkeypatch.setattr(service_mod, "write_manifest", no_manifest)
    config, key = files
    svc = _service(tmp_path, FakeAdapter(config, companions=[key]))
    change = svc.apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "manifest_failed; rollback rollback_succeeded"
    assert config.read_bytes() == b"ORIGINAL-CONFIG\n"
    assert key.read_bytes() == b"OLD-KEY\n"


def test_rollback_report_names_each_file(tmp_path, files):
    config, key = files
    snap = transaction.take_snapshot(
        AgentRuntimeService(store_dir=tmp_path / "b")._backup, "fake", [config, key])
    config.write_bytes(b"CHANGED\n")
    key.write_bytes(b"CHANGED-KEY\n")
    report = transaction.rollback_detailed(snap, expected=None)
    assert report.outcome == "rollback_succeeded"
    assert set(report.files.values()) == {"restored"}


# ── OpenCode: the API-key file must be restored with the configuration ──


@pytest.fixture
def opencode_paths(tmp_path, monkeypatch):
    config = tmp_path / "opencode.json"
    key = tmp_path / "aura-private.key"
    config.write_text(json.dumps({"provider": {}}), encoding="utf-8")
    key.write_text("previous-key-file", encoding="utf-8")
    monkeypatch.setattr(opencode_mod, "_CONFIG_PATH", config)
    monkeypatch.setattr(opencode_mod, "_KEY_FILE", key)
    monkeypatch.setattr(opencode_mod.shutil, "which",
                        lambda name: "/usr/bin/opencode" if name == "opencode" else None)
    return config, key


def test_opencode_restore_restores_the_api_key_file_too(tmp_path, opencode_paths):
    config, key = opencode_paths
    original_config = config.read_bytes()
    svc = AgentRuntimeService(store_dir=tmp_path / "backups")

    applied = svc.apply_agent("opencode", RUNTIME)
    assert applied.outcome == "applied_verified", applied.note
    assert key.read_text(encoding="utf-8") == "keyless"  # apply rewrote the key file

    restored = svc.restore_agent("opencode")
    assert restored.status == ConfigStatus.OK, restored.note
    assert key.read_text(encoding="utf-8") == "previous-key-file"
    assert config.read_bytes() == original_config
