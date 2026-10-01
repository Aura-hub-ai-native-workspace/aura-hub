"""GeminiCliAdapter — configure Gemini CLI to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-09-23):
  ~/.gemini/settings.json  (JSON)
  Currently observed keys: security.auth.selectedType, mcpServers.
  ~/.gemini/ directory exists on this machine but no `gemini` binary is in PATH.

  Gemini CLI uses GEMINI_API_KEY / GOOGLE_AI_API_KEY env vars.
  For OpenAI-compatible private endpoints, Gemini CLI supports
  "selectedType": "googleai" (default) and may support "openai-compatible"
  depending on the version installed.

  AURA's strategy:
    - detect() returns False if binary is absent (honest).
    - If binary present: write env advisory + note limitations.
    - Does NOT write to ~/.gemini/settings.json for endpoint override (no
      verified mechanism for redirecting Gemini CLI to an arbitrary base URL).
    - Status = PARTIAL with clear explanation.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from aura.agent_runtime.adapters import AgentConfigurationAdapter
from aura.agent_runtime.model import (
    AgentRecord,
    AuthType,
    ConfigStatus,
    ConfigurationChange,
    RuntimeConfig,
    checksum,
)

_SETTINGS_PATH = Path.home() / ".gemini" / "settings.json"
_ADVISORY_PATH = Path.home() / ".gemini" / "aura-runtime-env.sh"


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


class GeminiCliAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        # Check binary presence first — honest about absent binary
        binary = shutil.which("gemini") or shutil.which("gemini-cli")
        return binary is not None

    def readCurrentConfig(self) -> AgentRecord:
        binary = shutil.which("gemini") or shutil.which("gemini-cli")
        if not binary:
            # Config dir may exist from a prior install
            notes = []
            if _SETTINGS_PATH.exists():
                notes.append("configDirExists: true; binary: not found in PATH")
            return AgentRecord(
                agent_id="gemini-cli",
                display_name="Gemini CLI",
                version=None,
                binary_path=None,
                config_path=str(_SETTINGS_PATH),
                detected=False,
                adapter_class=f"{__name__}.GeminiCliAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
                notes=notes,
            )
        settings = _read_json(_SETTINGS_PATH)
        auth_type = settings.get("security", {}).get("auth", {}).get("selectedType")
        return AgentRecord(
            agent_id="gemini-cli",
            display_name="Gemini CLI",
            version=None,
            binary_path=binary,
            config_path=str(_SETTINGS_PATH),
            detected=True,
            adapter_class=f"{__name__}.GeminiCliAdapter",
            current_base_url=None,  # No standard base_url field in settings.json
            current_model=None,
            config_status=ConfigStatus.PARTIAL,
            notes=[
                f"authType: {auth_type}",
                "baseUrlRedirection: not natively supported via settings.json",
                "limitation: Gemini CLI targets Google AI endpoints; private endpoint redirection requires env vars",
            ],
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        return {
            "note": (
                "Gemini CLI does not support arbitrary base URL via settings.json. "
                "Set GOOGLE_AI_API_KEY (for Google AI) or use the advisory env file "
                "if an OpenAI-compatible mode is available in your version."
            ),
            "advisoryEnvFile": str(_ADVISORY_PATH),
        }

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        old_cs = None
        if _SETTINGS_PATH.exists():
            old_cs = checksum(_SETTINGS_PATH.read_bytes())

        key_line = ""
        if runtime.api_key_env:
            key_line = f'export GEMINI_API_KEY="${{{runtime.api_key_env}}}"\n'
            key_line += f'export GOOGLE_AI_API_KEY="${{{runtime.api_key_env}}}"\n'

        advisory = (
            "# AURA-managed runtime env for Gemini CLI\n"
            "# NOTE: Gemini CLI does not natively support arbitrary base URL redirection.\n"
            "# This file is advisory only. Check your Gemini CLI version for OpenAI-compatible mode.\n"
            f'# Target runtime: {runtime.base_url} / {runtime.model_id}\n'
            + key_line
        )
        _ADVISORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        _ADVISORY_PATH.write_text(advisory, encoding="utf-8")
        _ADVISORY_PATH.chmod(0o600)

        return ConfigurationChange(
            agent_id="gemini-cli",
            operation="apply",
            status=ConfigStatus.PARTIAL,
            fields_changed=[],
            previous_checksum=old_cs,
            new_checksum=None,
            note=(
                "Gemini CLI base URL redirection is not supported via settings.json. "
                f"Advisory written to {_ADVISORY_PATH}. "
                "Manual action required for full private endpoint configuration."
            ),
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        binary = shutil.which("gemini") or shutil.which("gemini-cli")
        return ConfigurationChange(
            agent_id="gemini-cli",
            operation="verify",
            status=ConfigStatus.PARTIAL if binary else ConfigStatus.NOT_INSTALLED,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note="Verification not possible: no base URL field in Gemini CLI settings.json",
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_SETTINGS_PATH.read_bytes()) if _SETTINGS_PATH.exists() else None
        if backup_bytes:
            tmp = _SETTINGS_PATH.with_suffix(".tmp")
            tmp.write_bytes(backup_bytes)
            tmp.replace(_SETTINGS_PATH)
        return ConfigurationChange(
            agent_id="gemini-cli",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=[],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes) if backup_bytes else None,
        )
