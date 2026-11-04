"""ConfigurationBackupManager — snapshot and restore agent config files.

Backups are stored under {store_dir}/{agent_id}/{timestamp}.backup
with a companion {timestamp}.meta.json (checksum, agent_id, path, timestamp).
No secret values appear in the meta file.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aura.agent_runtime.model import checksum


class ConfigurationBackupManager:

    def __init__(self, store_dir: Path) -> None:
        self._root = store_dir
        self._root.mkdir(parents=True, exist_ok=True)

    def backup(self, agent_id: str, config_path: str | Path) -> tuple[bytes, str]:
        """Snapshot current config. Returns (raw_bytes, backup_id).
        backup_id is "{agent_id}/{timestamp}" for use in restore().
        """
        path = Path(config_path)
        if not path.exists():
            raw = b""
        else:
            raw = path.read_bytes()

        dest_dir = self._root / agent_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        # The name is the timestamp, so two backups in one clock tick (Windows'
        # clock is coarse) would overwrite each other. Claim the name exclusively
        # and step one microsecond forward on a clash: names stay unique and
        # still sort in the order the backups were taken.
        when = datetime.now(timezone.utc)
        while True:
            ts = when.strftime("%Y%m%dT%H%M%S%fZ")
            try:
                with open(dest_dir / f"{ts}.backup", "xb") as fh:
                    fh.write(raw)
                break
            except FileExistsError:
                when += timedelta(microseconds=1)
        backup_id = f"{agent_id}/{ts}"
        meta = {
            "agentId": agent_id,
            "configPath": str(path),
            "backupId": backup_id,
            "timestamp": ts,
            "checksum": checksum(raw),
            "sizeBytes": len(raw),
        }
        (dest_dir / f"{ts}.meta.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )
        return raw, backup_id

    def restore(self, backup_id: str) -> bytes:
        """Load backup bytes by backup_id. Raises FileNotFoundError if absent."""
        agent_id, ts = backup_id.split("/", 1)
        path = self._root / agent_id / f"{ts}.backup"
        if not path.exists():
            raise FileNotFoundError(f"Backup not found: {backup_id}")
        return path.read_bytes()

    def latest_backup_id(self, agent_id: str) -> str | None:
        """Return the most recent backup_id for an agent, or None."""
        agent_dir = self._root / agent_id
        if not agent_dir.exists():
            return None
        backups = sorted(agent_dir.glob("*.backup"))
        if not backups:
            return None
        ts = backups[-1].stem
        return f"{agent_id}/{ts}"

    def list_backups(self, agent_id: str) -> list[dict]:
        """Return metadata for all backups of an agent (newest first)."""
        agent_dir = self._root / agent_id
        if not agent_dir.exists():
            return []
        metas = []
        for meta_file in sorted(agent_dir.glob("*.meta.json"), reverse=True):
            try:
                metas.append(json.loads(meta_file.read_text(encoding="utf-8")))
            except Exception:
                pass
        return metas
