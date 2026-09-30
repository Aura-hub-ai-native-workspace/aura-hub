"""CodexAdapter — configure OpenAI Codex CLI to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-09-23):
  ~/.codex/config.toml  (TOML)
  Top-level keys observed: model, model_reasoning_effort, projects, plugins,
    apps, notice, tui, desktop, marketplaces, mcp_servers.
  No "env" or "provider.base_url" section exists in the TOML schema.

  OpenAI Codex CLI respects OPENAI_BASE_URL + OPENAI_API_KEY environment
  variables at process start. These cannot be injected via config.toml.

  AURA's apply():
    - Updates the "model" field in config.toml to reflect the private model name.
    - Status = PARTIAL because the base URL requires shell-level env injection.
    - Writes an advisory ~/.codex/aura-runtime-env.sh that the user can source.
"""

from __future__ import annotations

import os
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

_CONFIG_PATH = Path.home() / ".codex" / "config.toml"
_ADVISORY_PATH = Path.home() / ".codex" / "aura-runtime-env.sh"


def _read_toml(path: Path) -> dict:
    try:
        import tomllib
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_toml_model(path: Path, model: str) -> None:
    """Update only the top-level model = "..." line, preserving everything else."""
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    replaced = False
    new_lines = []
    for line in lines:
        if line.startswith("model ") or line.startswith("model="):
            new_lines.append(f'model = "{model}"\n')
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        new_lines.insert(0, f'model = "{model}"\n')
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(new_lines), encoding="utf-8")
    tmp.replace(path)


class CodexAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("codex")) or _CONFIG_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="codex",
                display_name="Codex CLI",
                version=None,
                binary_path=None,
                config_path=str(_CONFIG_PATH),
                detected=False,
                adapter_class=f"{__name__}.CodexAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        cfg = _read_toml(_CONFIG_PATH)
        model = cfg.get("model")
        # Base URL not in TOML — read from env if available
        base_url = os.environ.get("OPENAI_BASE_URL")
        return AgentRecord(
            agent_id="codex",
            display_name="Codex CLI",
            version=None,
            binary_path=shutil.which("codex"),
            config_path=str(_CONFIG_PATH),
            detected=True,
            adapter_class=f"{__name__}.CodexAdapter",
            current_base_url=base_url,
            current_model=model,
            config_status=ConfigStatus.OK,
            notes=[
                "baseUrlSource: OPENAI_BASE_URL env (not in config.toml)",
                "applyStatus: PARTIAL — model field updated; base_url requires env injection",
            ],
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        return {
            "model": runtime.model_id,
            "baseUrlEnvVar": "OPENAI_BASE_URL",
            "baseUrl": runtime.base_url,
            "note": "base_url must be set via OPENAI_BASE_URL env var; see ~/.codex/aura-runtime-env.sh",
        }

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        old_bytes = _CONFIG_PATH.read_bytes() if _CONFIG_PATH.exists() else b""
        old_cs = checksum(old_bytes) if old_bytes else None

        _write_toml_model(_CONFIG_PATH, runtime.model_id)

        # Write advisory env file (not executable — user must source explicitly)
        key_line = ""
        if runtime.auth_type == AuthType.KEYLESS:
            key_line = 'export OPENAI_API_KEY="ollama"\n'
        elif runtime.api_key_env:
            key_line = f'export OPENAI_API_KEY="${{{runtime.api_key_env}}}"\n'
        advisory = (
            "# AURA-managed runtime env for Codex CLI\n"
            "# Source this file before starting Codex to use the private runtime.\n"
            "# Do NOT commit this file — it may contain API key references.\n"
            f'export OPENAI_BASE_URL="{runtime.base_url}"\n'
            + key_line
        )
        _ADVISORY_PATH.write_text(advisory, encoding="utf-8")
        _ADVISORY_PATH.chmod(0o600)

        new_bytes = _CONFIG_PATH.read_bytes() if _CONFIG_PATH.exists() else b""
        return ConfigurationChange(
            agent_id="codex",
            operation="apply",
            status=ConfigStatus.PARTIAL,
            fields_changed=["model"],
            previous_checksum=old_cs,
            new_checksum=checksum(new_bytes),
            note=f"model updated; base_url requires: source {_ADVISORY_PATH}",
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_toml(_CONFIG_PATH)
        model_ok = cfg.get("model") == runtime.model_id
        return ConfigurationChange(
            agent_id="codex",
            operation="verify",
            status=ConfigStatus.PARTIAL,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=f"model={'matched' if model_ok else 'MISMATCH'}; "
                 f"base_url=env-only (not verifiable from TOML)",
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_CONFIG_PATH.read_bytes()) if _CONFIG_PATH.exists() else None
        tmp = _CONFIG_PATH.with_suffix(".tmp")
        tmp.write_bytes(backup_bytes)
        tmp.replace(_CONFIG_PATH)
        return ConfigurationChange(
            agent_id="codex",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["model"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
