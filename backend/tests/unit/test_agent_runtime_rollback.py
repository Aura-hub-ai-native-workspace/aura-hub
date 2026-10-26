"""Service-level apply, verify, backup and rollback for agent configuration.

The contract under test: a configuration change never reports success unless
the applied state verifies; a change never starts without a verified backup;
and a rollback restores only what this change wrote, and says what happened.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aura.agent_runtime import service as service_mod
from aura.agent_runtime.adapters import kilo as kilo_mod
from aura.agent_runtime.model import (
    AgentRecord,
    AuthType,
    ConfigStatus,
    ConfigurationChange,
    RuntimeConfig,
    checksum,
)
from aura.agent_runtime.service import AgentRuntimeService
from _agent_fakes import FakeAdapter, FakeRegistry

RUNTIME = RuntimeConfig(
    base_url="http://127.0.0.1:11434/v1",
    model_id="qwen2.5-coder:1.5b",
    auth_type=AuthType.KEYLESS,
    network_class="local",
)


# ── Kilo: the backup must cover the file the adapter writes ──────────────


def test_kilo_restore_brings_back_the_advisory_file_not_the_jsonc(tmp_path, monkeypatch):
    config = tmp_path / "kilo.jsonc"
    advisory = tmp_path / "aura-runtime-env.sh"
    config.write_text('{ "theme": "dark" } // user settings\n', encoding="utf-8")
    original_advisory = (
        '# AURA-managed runtime env for Kilo Code\n'
        'export ANTHROPIC_BASE_URL="http://10.0.0.5:11434/v1"\n'
    )
    advisory.write_text(original_advisory, encoding="utf-8")
    original_config = config.read_bytes()

    monkeypatch.setattr(kilo_mod, "_CONFIG_PATH", config)
    monkeypatch.setattr(kilo_mod, "_ADVISORY_PATH", advisory)
    monkeypatch.setattr(kilo_mod.shutil, "which",
                        lambda name: "/usr/bin/kilo" if name == "kilo" else None)

    svc = AgentRuntimeService(store_dir=tmp_path / "backups")
    applied = svc.apply_agent("kilo", RUNTIME)
    assert applied.status == ConfigStatus.OK
    assert "127.0.0.1" in advisory.read_text(encoding="utf-8")

    restored = svc.restore_agent("kilo")
    assert restored.status == ConfigStatus.OK
    assert advisory.read_text(encoding="utf-8") == original_advisory
    # The user's JSONC config was never the thing being written, so it is untouched.
    assert config.read_bytes() == original_config


# ── Service-level apply behaviour with a controllable adapter ───────────


def _service(tmp_path: Path, adapter: FakeAdapter) -> AgentRuntimeService:
    svc = AgentRuntimeService(store_dir=tmp_path / "backups")
    svc._registry = FakeRegistry(adapter)
    return svc


@pytest.fixture
def target(tmp_path):
    path = tmp_path / "config.json"
    path.write_bytes(b"ORIGINAL\n")
    return path


def test_successful_apply_is_reported_only_after_verification(tmp_path, target):
    adapter = FakeAdapter(target)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.OK
    assert change.outcome == "applied_verified"
    assert target.read_bytes() == b"NEW\n"


def test_backup_failure_stops_the_change_before_anything_is_written(tmp_path, target):
    adapter = FakeAdapter(target)
    svc = _service(tmp_path, adapter)

    def broken_backup(agent_id, path):
        raise OSError("disk full")

    svc._backup.backup = broken_backup
    change = svc.apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "backup_failed"
    assert "no configuration was changed" in change.note
    assert adapter.apply_calls == 0
    assert target.read_bytes() == b"ORIGINAL\n"


def test_verification_failure_rolls_back_to_the_original_bytes(tmp_path, target):
    adapter = FakeAdapter(target, verify_status=ConfigStatus.ERROR)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "verify_failed; rollback rollback_succeeded"
    assert target.read_bytes() == b"ORIGINAL\n"


def test_rollback_failure_is_reported_and_never_as_success(tmp_path, target, monkeypatch):
    from aura.agent_runtime import transaction

    def failing_write(path, data):
        raise OSError("read-only file system")

    monkeypatch.setattr(transaction, "_write_atomic", failing_write)
    adapter = FakeAdapter(target, verify_status=ConfigStatus.ERROR)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "verify_failed; rollback rollback_failed"
    assert target.read_bytes() == b"NEW\n"  # honest: the change is still in place


def test_exception_after_partial_write_is_rolled_back(tmp_path, target):
    adapter = FakeAdapter(target, partial_then_raise=True)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "apply_failed; rollback rollback_succeeded"
    assert target.read_bytes() == b"ORIGINAL\n"


def test_verify_exception_is_treated_as_failed_verification(tmp_path, target):
    adapter = FakeAdapter(target, verify_raises=ValueError("unreadable"))
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "verify_failed; rollback rollback_succeeded"
    assert target.read_bytes() == b"ORIGINAL\n"


def test_rollback_refuses_to_overwrite_a_user_edit_made_after_apply(tmp_path, target):
    def user_edits(path):
        path.write_bytes(b"USER EDIT\n")

    adapter = FakeAdapter(target, verify_status=ConfigStatus.ERROR,
                          verify_side_effect=user_edits)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.status == ConfigStatus.ERROR
    assert change.outcome == "verify_failed; rollback rollback_refused"
    assert target.read_bytes() == b"USER EDIT\n"


def test_rollback_removes_a_file_the_change_created(tmp_path):
    path = tmp_path / "created.env"
    adapter = FakeAdapter(path, verify_status=ConfigStatus.ERROR)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.outcome == "verify_failed; rollback rollback_succeeded"
    assert not path.exists()


def test_companion_files_are_backed_up_and_restored_together(tmp_path, target):
    companion = tmp_path / "secret.key"
    companion.write_bytes(b"OLD-KEY\n")
    adapter = FakeAdapter(target, companions=[companion], verify_status=ConfigStatus.ERROR)
    change = _service(tmp_path, adapter).apply_agent("fake", RUNTIME)
    assert change.outcome == "verify_failed; rollback rollback_succeeded"
    assert target.read_bytes() == b"ORIGINAL\n"
    assert companion.read_bytes() == b"OLD-KEY\n"


def test_rollback_is_idempotent(tmp_path, target):
    from aura.agent_runtime import transaction
    from aura.agent_runtime.backup import ConfigurationBackupManager

    snap = transaction.take_snapshot(ConfigurationBackupManager(tmp_path / "b"),
                                     "fake", [target])
    target.write_bytes(b"CHANGED\n")
    assert transaction.rollback(snap, expected=None) == "rollback_succeeded"
    assert transaction.rollback(snap, expected=None) == "not_needed"
    assert target.read_bytes() == b"ORIGINAL\n"
