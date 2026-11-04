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

from dataclasses import replace
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
from aura.agent_runtime.model_metadata import (
    STATUS_NOT_QUERIED,
    fetch_ollama_metadata,
    unknown,
)
from aura.agent_runtime.registry import AgentRuntimeRegistry
from aura.agent_runtime.transaction import (
    APPLIED_VERIFIED,
    APPLY_FAILED,
    BACKUP_FAILED,
    MANIFEST_FAILED,
    RESTORE_FAILED,
    RESTORE_INTEGRITY_FAILED,
    RESTORE_NO_MANIFEST,
    RESTORE_REFUSED,
    RESTORE_SUCCEEDED,
    ROLLBACK_NOT_NEEDED,
    ROLLBACK_REFUSED,
    ROLLBACK_SUCCEEDED,
    VERIFY_FAILED,
    SnapshotError,
    file_checksum,
    load_latest_manifest,
    rollback,
    rollback_detailed,
    snapshot_from_manifest,
    take_snapshot,
    write_manifest,
)


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

    @staticmethod
    def _with_metadata(runtime: RuntimeConfig):
        """Fill unknown model metadata from the endpoint, for private endpoints only.

        Returns (runtime, metadata). Fields the caller already set are kept.
        Cloud endpoints are never queried here.
        """
        if runtime.network_class not in ("local", "private"):
            return runtime, unknown(runtime.model_id, STATUS_NOT_QUERIED,
                                    "endpoint is not local or private; not queried")
        meta = fetch_ollama_metadata(runtime.base_url, runtime.model_id)
        enriched = replace(
            runtime,
            context_length=(runtime.context_length if runtime.context_length is not None
                            else meta.context_length),
            tool_calling=(runtime.tool_calling if runtime.tool_calling is not None
                          else meta.tool_calling),
        )
        return enriched, meta

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

    @staticmethod
    def to_api_record(record: AgentRecord) -> dict:
        """Map the internal discovery record into the TS AgentRecord shape.

        The desktop contract (ai/centralAgentClient.ts) spells one record in
        camelCase with id/name/status/currentConfig, while this service's
        AgentRecord dataclasses spell it in snake_case with agent_id/
        display_name/config_status/current_base_url, etc. Both routes below
        and the AgentCard renderer depend on the TS shape, so the mapping
        lives here, in one place.

        Nothing is invented: `drift` is 'unknown' because drift is only
        measured after a runtime is applied and checked, never at discovery
        time; `driftFields`/`error` have no measured value of their own;
        `currentConfig` carries only the fields the detector actually found.
        """
        current_config: dict = {}
        if record.current_base_url is not None:
            current_config["baseUrl"] = record.current_base_url
        if record.current_model is not None:
            current_config["modelId"] = record.current_model
        if record.version is not None:
            current_config["version"] = record.version
        if record.binary_path is not None:
            current_config["binaryPath"] = record.binary_path
        return {
            "id": record.agent_id,
            "name": record.display_name,
            "detected": record.detected,
            "configPath": record.config_path,
            "status": record.config_status.value,
            "statusNote": "; ".join(record.notes) if record.notes else "",
            "currentConfig": current_config,
            "drift": "unknown",
            "driftFields": [],
            "error": None,
        }

    def discover_summary(self) -> dict:
        """AgentRuntimeSummary over what discovery actually found.

        Conforms to the frontend's AgentRuntimeSummary (agents + the three
        counts). configuredCount derives from genuinely-readable config
        (OK or PARTIAL); driftedCount is 0 because drift is not measured
        during discovery — rendering 'All in sync' would be a claim this
        stage has not earned.
        """
        records = self._registry.discover()
        return self.summary_from_records(records)

    def summary_from_records(self, records: list[AgentRecord]) -> dict:
        """AgentRuntimeSummary over a discovered set of records.

        Conforms to the frontend's AgentRuntimeSummary (agents + the three
        counts). configuredCount derives from genuinely-readable config
        (OK or PARTIAL); driftedCount is 0 because drift is not measured
        during discovery — rendering 'All in sync' would be a claim this
        stage has not earned.
        """
        installed = [r for r in records if r.detected]
        configured = [
            r for r in records
            if r.detected and r.config_status in (ConfigStatus.OK, ConfigStatus.PARTIAL)
        ]
        return {
            "agents": [self.to_api_record(r) for r in records],
            "installedCount": len(installed),
            "configuredCount": len(configured),
            "driftedCount": 0,
        }

    def apply_all(self, runtime: RuntimeConfig) -> list[ConfigurationChange]:
        self._check_sovereign(runtime)
        self._last_runtime = runtime
        changes: list[ConfigurationChange] = []
        for record in self._registry.installed():
            change = self.apply_agent(record.agent_id, runtime)
            changes.append(change)
        return changes

    def apply_agent(self, agent_id: str, runtime: RuntimeConfig) -> ConfigurationChange:
        """Apply, verify, and roll back on failure. Success is reported only
        when the applied state verifies.

        Order: snapshot every file the change may write (a failed backup stops
        the change before anything is written), apply, read the result back with
        the adapter's verify(), and restore the snapshot if any step fails.
        """
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

        runtime, metadata = self._with_metadata(runtime)
        metadata_note = (f" Model metadata: {metadata.status}"
                         + (f" (context={metadata.context_length}, "
                            f"tools={metadata.tool_calling})"
                            if metadata.status == "verified" else
                            "; unknown fields were omitted, not guessed."))

        paths = self._mutable_paths(adapter, record)
        try:
            snapshot = take_snapshot(self._backup, agent_id, paths)
        except SnapshotError as exc:
            return self._failure(
                agent_id, BACKUP_FAILED,
                f"Backup failed, so no configuration was changed: {exc}")

        try:
            applied = adapter.apply(runtime)
        except Exception as exc:
            # The adapter may have written part of the change before raising.
            rb = rollback(snapshot, expected=None)
            return self._failure(
                agent_id, f"{APPLY_FAILED}; rollback {rb}",
                f"Apply raised {type(exc).__name__}: {exc}")
        if applied.status not in (ConfigStatus.OK, ConfigStatus.PARTIAL):
            rb = rollback(snapshot, expected=None)
            return self._failure(
                agent_id, f"{APPLY_FAILED}; rollback {rb}",
                f"Adapter reported {applied.status.value}: {applied.note}")

        written = {item.path: file_checksum(item.path) for item in snapshot.files}
        try:
            verified = adapter.verify(runtime)
            verify_note = verified.note
            verify_ok = verified.status == ConfigStatus.OK
        except Exception as exc:
            verify_ok = False
            verify_note = f"verify raised {type(exc).__name__}: {exc}"
        if not verify_ok:
            rb = rollback(snapshot, expected=written)
            return self._failure(
                agent_id, f"{VERIFY_FAILED}; rollback {rb}",
                f"Verification failed: {verify_note}")

        # A verified apply must be restorable. If its manifest cannot be
        # written, undo the apply rather than leave an unrecoverable change.
        try:
            write_manifest(self._backup._root, snapshot, written)
        except Exception as exc:
            rb = rollback(snapshot, expected=written)
            return self._failure(
                agent_id, f"{MANIFEST_FAILED}; rollback {rb}",
                f"Could not record the restore manifest: {type(exc).__name__}: {exc}")

        return ConfigurationChange(
            agent_id=agent_id,
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=applied.fields_changed,
            previous_checksum=applied.previous_checksum,
            new_checksum=applied.new_checksum,
            note=(applied.note or "Applied and verified.") + metadata_note,
            outcome=APPLIED_VERIFIED,
        )

    @staticmethod
    def _mutable_paths(adapter, record: AgentRecord) -> list[Path]:
        """Files a change may write: the adapter's declaration, or the config path."""
        declared = list(adapter.mutable_paths())
        if not declared and record.config_path:
            declared = [Path(record.config_path)]
        seen: set[Path] = set()
        unique: list[Path] = []
        for path in declared:
            if path not in seen:
                seen.add(path)
                unique.append(Path(path))
        return unique

    @staticmethod
    def _failure(agent_id: str, outcome: str, note: str) -> ConfigurationChange:
        return ConfigurationChange(
            agent_id=agent_id,
            operation="apply",
            status=ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=note,
            outcome=outcome,
        )

    def restore_agent(self, agent_id: str, on_conflict: str = "refuse") -> ConfigurationChange:
        """Restore the files written by the most recent verified apply.

        Every file the apply wrote is restored together, using the same checks as
        automatic rollback. If any file has changed since that apply, nothing is
        restored unless ``on_conflict="overwrite"`` is given explicitly.
        """
        def fail(outcome: str, note: str, status=ConfigStatus.ERROR, files=None):
            return ConfigurationChange(
                agent_id=agent_id, operation="restore", status=status,
                fields_changed=sorted(files or []), previous_checksum=None,
                new_checksum=None, note=note, outcome=outcome)

        if self._registry.adapter_for(agent_id) is None:
            return fail(RESTORE_FAILED, f"No adapter for agent_id={agent_id!r}")
        manifest = load_latest_manifest(self._backup._root, agent_id)
        if manifest is None:
            return fail(RESTORE_NO_MANIFEST,
                        "No verified apply is recorded for this agent; nothing to restore.")
        try:
            snap, applied = snapshot_from_manifest(self._backup, manifest)
        except Exception as exc:
            return fail(RESTORE_INTEGRITY_FAILED,
                        f"Restore refused, nothing was changed: {exc}")

        report = rollback_detailed(snap, expected=applied, on_conflict=on_conflict)
        files = list(report.files)
        if report.outcome in (ROLLBACK_SUCCEEDED, ROLLBACK_NOT_NEEDED):
            outcome = RESTORE_SUCCEEDED if report.outcome == ROLLBACK_SUCCEEDED \
                else ROLLBACK_NOT_NEEDED
            note = ("Restored all files from the last verified apply."
                    if outcome == RESTORE_SUCCEEDED
                    else "Files already match their pre-apply state.")
            return ConfigurationChange(
                agent_id=agent_id, operation="restore", status=ConfigStatus.OK,
                fields_changed=sorted(files), previous_checksum=None,
                new_checksum=None, note=note, outcome=outcome)
        if report.outcome == ROLLBACK_REFUSED:
            return fail(RESTORE_REFUSED,
                        f"Restore refused, nothing was changed: {report.detail}", files=files)
        return fail(RESTORE_FAILED,
                    f"Restore failed: {report.detail}", files=files)

    def check_drift(self, runtime: RuntimeConfig) -> list[ConfigurationDrift]:
        records = self._registry.installed()
        return self._drift.check_all(records, runtime)

    def runtime_summary(self) -> dict:
        """Safe for API responses — no secrets, no key values."""
        records = self.discover()
        installed = [r for r in records if r.detected]
        configured = [
            r for r in records
            if r.detected and r.config_status in (ConfigStatus.OK, ConfigStatus.PARTIAL)
        ]
        return {
            "installedCount": len(installed),
            "totalDiscovered": len(records),
            "configuredCount": len(configured),
            "driftedCount": 0,
            "agents": [self.to_api_record(r) for r in records],
            "lastRuntime": self._last_runtime.to_dict() if self._last_runtime else None,
        }
