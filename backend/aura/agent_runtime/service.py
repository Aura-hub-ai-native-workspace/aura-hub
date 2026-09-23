"""AgentRuntimeService — orchestrate AI agent runtime configuration.

Public API:
  discover()                         → list[AgentRecord]
  apply_all(runtime)                 → list[ConfigurationChange]
  apply_agent(agent_id, runtime)     → ConfigurationChange
  restore_agent(agent_id)            → ConfigurationChange
  check_drift(runtime)               → list[ConfigurationDrift]
  runtime_summary()                  → dict   (safe for API, no secrets)
"""

from __future__ import annotations

from pathlib import Path

from aura.agent_runtime.backup import ConfigurationBackupManager
from aura.agent_runtime.drift import DriftDetector
from aura.agent_runtime.model import (
    AgentRecord,
    ConfigStatus,
    ConfigurationChange,
    ConfigurationDrift,
    RuntimeConfig,
)
from aura.agent_runtime.registry import AgentRuntimeRegistry


class AgentRuntimeService:

    def __init__(
        self,
        store_dir: Path | None = None,
        sovereign_policy=None,
    ) -> None:
        home = store_dir or (Path.home() / ".aura" / "agent-runtime-backups")
        self._backup = ConfigurationBackupManager(home)
        self._registry = AgentRuntimeRegistry()
        self._drift = DriftDetector()
        self._sovereign_policy = sovereign_policy
        self._last_runtime: RuntimeConfig | None = None

    def _check_sovereign(self, runtime: RuntimeConfig) -> None:
        if self._sovereign_policy is None:
            return
        if not self._sovereign_policy.allows(runtime.network_class):
            raise ValueError(
                f"Sovereign mode blocks configuring agents for a "
                f"{runtime.network_class!r} runtime ({runtime.base_url}). "
                "Only local/private runtimes are permitted."
            )

    def discover(self) -> list[AgentRecord]:
        return self._registry.discover()

    def apply_all(self, runtime: RuntimeConfig) -> list[ConfigurationChange]:
        self._check_sovereign(runtime)
        self._last_runtime = runtime
        changes: list[ConfigurationChange] = []
        for record in self._registry.installed():
            change = self.apply_agent(record.agent_id, runtime)
            changes.append(change)
        return changes

    def apply_agent(self, agent_id: str, runtime: RuntimeConfig) -> ConfigurationChange:
        self._check_sovereign(runtime)
        self._last_runtime = runtime
        adapter = self._registry.adapter_for(agent_id)
        if adapter is None:
            return ConfigurationChange(
                agent_id=agent_id,
                operation="apply",
                status=ConfigStatus.ERROR,
                fields_changed=[],
                previous_checksum=None,
                new_checksum=None,
                note=f"No adapter found for agent_id={agent_id!r}",
            )
        record = adapter.readCurrentConfig()
        if not record.detected:
            return ConfigurationChange(
                agent_id=agent_id,
                operation="apply",
                status=ConfigStatus.NOT_INSTALLED,
                fields_changed=[],
                previous_checksum=None,
                new_checksum=None,
                note="Agent not installed; skipped.",
            )
        # Back up before applying
        if record.config_path:
            try:
                self._backup.backup(agent_id, record.config_path)
            except Exception as exc:
                pass  # Backup failure is non-fatal; proceed with apply

        try:
            return adapter.apply(runtime)
        except Exception as exc:
            return ConfigurationChange(
                agent_id=agent_id,
                operation="apply",
                status=ConfigStatus.ERROR,
                fields_changed=[],
                previous_checksum=None,
                new_checksum=None,
                note=str(exc),
            )

    def restore_agent(self, agent_id: str) -> ConfigurationChange:
        backup_id = self._backup.latest_backup_id(agent_id)
        if backup_id is None:
            return ConfigurationChange(
                agent_id=agent_id,
                operation="restore",
                status=ConfigStatus.ERROR,
                fields_changed=[],
                previous_checksum=None,
                new_checksum=None,
                note="No backup found for this agent.",
            )
        backup_bytes = self._backup.restore(backup_id)
        adapter = self._registry.adapter_for(agent_id)
        if adapter is None:
            return ConfigurationChange(
                agent_id=agent_id,
                operation="restore",
                status=ConfigStatus.ERROR,
                fields_changed=[],
                previous_checksum=None,
                new_checksum=None,
                note=f"No adapter for agent_id={agent_id!r}",
            )
        try:
            return adapter.restore(backup_bytes)
        except Exception as exc:
            return ConfigurationChange(
                agent_id=agent_id,
                operation="restore",
                status=ConfigStatus.ERROR,
                fields_changed=[],
                previous_checksum=None,
                new_checksum=None,
                note=str(exc),
            )

    def check_drift(self, runtime: RuntimeConfig) -> list[ConfigurationDrift]:
        records = self._registry.installed()
        return self._drift.check_all(records, runtime)

    def runtime_summary(self) -> dict:
        """Safe for API responses — no secrets, no key values."""
        records = self.discover()
        installed = [r for r in records if r.detected]
        return {
            "installedCount": len(installed),
            "totalDiscovered": len(records),
            "agents": [r.to_dict() for r in records],
            "lastRuntime": self._last_runtime.to_dict() if self._last_runtime else None,
        }
