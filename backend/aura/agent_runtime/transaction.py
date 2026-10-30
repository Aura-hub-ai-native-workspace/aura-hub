"""Snapshot, manifest and restore for one agent configuration change.

A snapshot records, for every file a change may write, whether the file existed,
its original bytes (kept in the backup store), and a checksum. After a change is
applied and verified, a manifest also records the checksum each file had then.

Restore semantics, used by both automatic rollback and manual restore:
  * Every file is checked before anything is written. If any file no longer
    matches the state the change left behind, the whole restore is refused and
    nothing is touched. A user's later edit is never overwritten silently.
  * Each backup is checked against its recorded checksum before use.
  * Restore is idempotent: files already at their original state are left alone.
  * Each file is verified after it is written. Per-file results are reported.
"""

from __future__ import annotations

from .tmpname import unique_sibling
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from aura.agent_runtime.model import checksum

# Outcome labels reported on ConfigurationChange.outcome.
APPLIED_VERIFIED = "applied_verified"
BACKUP_FAILED = "backup_failed"
APPLY_FAILED = "apply_failed"
VERIFY_FAILED = "verify_failed"
MANIFEST_FAILED = "manifest_failed"
ROLLBACK_NOT_NEEDED = "not_needed"
ROLLBACK_SUCCEEDED = "rollback_succeeded"
ROLLBACK_FAILED = "rollback_failed"
ROLLBACK_REFUSED = "rollback_refused"
RESTORE_SUCCEEDED = "restore_succeeded"
RESTORE_FAILED = "restore_failed"
RESTORE_REFUSED = "restore_refused"
RESTORE_NO_MANIFEST = "no_manifest"
RESTORE_INTEGRITY_FAILED = "backup_integrity_failed"


class SnapshotError(RuntimeError):
    """A required backup could not be taken or read back intact."""


@dataclass(frozen=True)
class FileSnapshot:
    path: Path
    existed: bool
    checksum: str | None     # checksum of the original bytes (None when absent)
    content: bytes           # original bytes (b"" when absent)
    backup_id: str | None = None


@dataclass
class Snapshot:
    agent_id: str
    files: list[FileSnapshot] = field(default_factory=list)


@dataclass
class RollbackReport:
    """The overall outcome plus what happened to each file."""
    outcome: str
    files: dict[str, str] = field(default_factory=dict)   # path -> per-file status
    detail: str = ""


def file_checksum(path: Path) -> str | None:
    """Checksum of the file as it is now, or None when it does not exist."""
    try:
        return checksum(path.read_bytes())
    except FileNotFoundError:
        return None


def take_snapshot(backup, agent_id: str, paths: list[Path]) -> Snapshot:
    """Snapshot every path or raise SnapshotError. Nothing is written to the
    configuration files here. Each backup is read back and compared before use.
    """
    snap = Snapshot(agent_id=agent_id)
    for path in paths:
        existed = path.exists()
        try:
            raw = path.read_bytes() if existed else b""
        except OSError as exc:
            raise SnapshotError(f"cannot read {path}: {exc}") from exc
        try:
            _, backup_id = backup.backup(agent_id, path)
            stored = backup.restore(backup_id)
        except Exception as exc:
            raise SnapshotError(f"backup of {path} failed: {exc}") from exc
        if stored != raw:
            raise SnapshotError(f"backup of {path} did not read back intact")
        snap.files.append(FileSnapshot(
            path=path, existed=existed,
            checksum=checksum(raw) if existed else None,
            content=raw, backup_id=backup_id))
    return snap


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = unique_sibling(path)
    tmp.write_bytes(data)
    if path.exists():
        os.chmod(tmp, path.stat().st_mode & 0o777)
    else:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def rollback_detailed(snap: Snapshot, expected: dict[Path, str | None] | None,
                      on_conflict: str = "refuse") -> RollbackReport:
    """Restore the snapshot and report what happened to each file.

    ``expected`` maps each path to the checksum this change left behind, read
    right after the change. ``expected=None`` means the change raised before it
    could be read; a file is then restored only if it differs from its original.

    ``on_conflict="refuse"`` (the default) stops the whole restore if any file
    no longer matches ``expected``. ``"overwrite"`` restores it anyway and is
    only for callers that have decided to discard the newer change.
    """
    if on_conflict not in ("refuse", "overwrite"):
        raise ValueError(f"unknown conflict policy {on_conflict!r}")
    per_file: dict[str, str] = {}
    pending: list[FileSnapshot] = []
    for item in snap.files:
        now = file_checksum(item.path)
        if now == item.checksum:
            per_file[str(item.path)] = "already_original"
            continue
        if expected is not None and now != expected.get(item.path) \
                and on_conflict == "refuse":
            per_file[str(item.path)] = "conflict"
            return RollbackReport(
                outcome=ROLLBACK_REFUSED, files=per_file,
                detail=f"{item.path} changed after this change wrote it; "
                       "nothing was restored")
        pending.append(item)
    if not pending:
        return RollbackReport(outcome=ROLLBACK_NOT_NEEDED, files=per_file)

    for item in pending:
        try:
            if item.existed:
                _write_atomic(item.path, item.content)
            else:
                item.path.unlink(missing_ok=True)
            per_file[str(item.path)] = "restored"
        except OSError as exc:
            per_file[str(item.path)] = f"failed: {exc}"[:200]
            return RollbackReport(
                outcome=ROLLBACK_FAILED, files=per_file,
                detail=f"writing {item.path} failed; earlier files may already be restored")

    for item in snap.files:                 # verify the restored state
        if file_checksum(item.path) != item.checksum:
            per_file[str(item.path)] = "verify_mismatch"
            return RollbackReport(
                outcome=ROLLBACK_FAILED, files=per_file,
                detail=f"{item.path} does not match its original state after restore")
    return RollbackReport(outcome=ROLLBACK_SUCCEEDED, files=per_file)


def rollback(snap: Snapshot, expected: dict[Path, str | None] | None,
             on_conflict: str = "refuse") -> str:
    """The outcome string only. Kept for callers that need just the label."""
    return rollback_detailed(snap, expected, on_conflict).outcome


# ── Manifests: which files a verified apply wrote ─────────────────────────


def _manifest_dir(store_root: Path, agent_id: str) -> Path:
    return store_root / agent_id / "manifests"


def write_manifest(store_root: Path, snap: Snapshot,
                   applied: dict[Path, str | None]) -> Path:
    """Record a verified apply so a later manual restore can reproduce it."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory = _manifest_dir(store_root, snap.agent_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    body = {
        "agentId": snap.agent_id,
        "createdAt": stamp,
        "files": [{
            "path": str(item.path),
            "existed": item.existed,
            "checksum": item.checksum,
            "backupId": item.backup_id,
            "appliedChecksum": applied.get(item.path),
        } for item in snap.files],
    }
    path = directory / f"{stamp}.json"
    tmp = unique_sibling(path)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(body, indent=2, sort_keys=True))
    os.replace(tmp, path)
    return path


def load_latest_manifest(store_root: Path, agent_id: str) -> dict | None:
    directory = _manifest_dir(store_root, agent_id)
    if not directory.exists():
        return None
    manifests = sorted(directory.glob("*.json"))
    if not manifests:
        return None
    try:
        return json.loads(manifests[-1].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def snapshot_from_manifest(backup, manifest: dict) -> tuple[Snapshot, dict[Path, str | None]]:
    """Rebuild a snapshot from a manifest, checking each backup's integrity.

    Raises ValueError when a backup is missing or does not match its checksum.
    """
    snap = Snapshot(agent_id=manifest["agentId"])
    applied: dict[Path, str | None] = {}
    for entry in manifest["files"]:
        path = Path(entry["path"])
        if entry["existed"]:
            if not entry.get("backupId"):
                raise ValueError(f"no backup recorded for {path}")
            content = backup.restore(entry["backupId"])
            if checksum(content) != entry["checksum"]:
                raise ValueError(f"backup of {path} fails its integrity check")
        else:
            content = b""
        snap.files.append(FileSnapshot(
            path=path, existed=entry["existed"], checksum=entry["checksum"],
            content=content, backup_id=entry.get("backupId")))
        applied[path] = entry.get("appliedChecksum")
    return snap, applied
