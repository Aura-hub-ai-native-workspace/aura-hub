"""ClaudeCodeAdapter — configure Claude Code to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-09-23):
  ~/.claude/settings.json  (JSON)
  Add/update "env" block:
    "env": {
      "ANTHROPIC_BASE_URL": "<base_url>",
      "ANTHROPIC_API_KEY":  "<value-or-sentinel>"
    }
  Claude Code reads this env block and merges it into the process environment
  before making API calls. ANTHROPIC_BASE_URL redirects all inference traffic.

Keyless (Ollama): set ANTHROPIC_API_KEY to "ollama" (non-empty placeholder).
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from aura.agent_runtime.adapters import AgentConfigurationAdapter
from aura.agent_runtime.model import (
    AgentRecord,
    AuthType,
    ConfigStatus,
    ConfigurationChange,
    DriftStatus,
    RuntimeConfig,
    checksum,
)

_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
_BINARY_CANDIDATES = ["/usr/bin/claude", "/usr/local/bin/claude",
                      str(Path.home() / ".local/bin/claude")]


class ClaudeCodeAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("claude")) or any(
            Path(p).exists() for p in _BINARY_CANDIDATES
        )

    def _binary_path(self) -> str | None:
        found = shutil.which("claude")
        if found:
            return found
        for p in _BINARY_CANDIDATES:
            if Path(p).exists():
                return p
        return None

    def _read_settings(self) -> dict:
        if not _SETTINGS_PATH.exists():
            return {}
        try:
            return json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="claude-code",
                display_name="Claude Code",
                version=None,
                binary_path=None,
                config_path=str(_SETTINGS_PATH),
                detected=False,
                adapter_class=f"{__name__}.ClaudeCodeAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        settings = self._read_settings()
        env_block = settings.get("env", {})
        base_url = env_block.get("ANTHROPIC_BASE_URL")
        # Never read the key value itself — only note whether it's configured
        key_configured = "ANTHROPIC_API_KEY" in env_block or bool(
            os.environ.get("ANTHROPIC_API_KEY")
        )
        version = self._get_version()
        return AgentRecord(
            agent_id="claude-code",
            display_name="Claude Code",
            version=version,
            binary_path=self._binary_path(),
            config_path=str(_SETTINGS_PATH),
            detected=True,
            adapter_class=f"{__name__}.ClaudeCodeAdapter",
            current_base_url=base_url,
            current_model=None,  # Claude Code uses model name at API call time
            config_status=ConfigStatus.OK,
            notes=["apiKeyConfigured: " + str(key_configured)],
        )

    def _get_version(self) -> str | None:
        try:
            import subprocess
            r = subprocess.run(["claude", "--version"], capture_output=True,
                               text=True, timeout=5)
            return r.stdout.strip().split()[-1] if r.returncode == 0 else None
        except Exception:
            return None

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        settings = self._read_settings()
        env_block = dict(settings.get("env", {}))
        env_block["ANTHROPIC_BASE_URL"] = runtime.base_url
        if runtime.auth_type == AuthType.KEYLESS:
            env_block["ANTHROPIC_API_KEY"] = "ollama"
        elif runtime.api_key_env:
            env_block["ANTHROPIC_API_KEY"] = f"$ref:{runtime.api_key_env}"
        return {"env": env_block}

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        settings = self._read_settings()
        old_bytes = json.dumps(settings, sort_keys=True).encode()
        old_cs = checksum(old_bytes)

        env_block = dict(settings.get("env", {}))
        env_block["ANTHROPIC_BASE_URL"] = runtime.base_url
        if runtime.auth_type == AuthType.KEYLESS:
            env_block["ANTHROPIC_API_KEY"] = "ollama"
        elif runtime.api_key_env:
            actual_key = os.environ.get(runtime.api_key_env, "")
            if actual_key:
                env_block["ANTHROPIC_API_KEY"] = actual_key
            # else leave existing key

        settings["env"] = env_block
        new_text = json.dumps(settings, indent=2, ensure_ascii=False)
        _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(_SETTINGS_PATH, new_text)

        new_cs = checksum(new_text.encode())
        return ConfigurationChange(
            agent_id="claude-code",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=["env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_API_KEY"],
            previous_checksum=old_cs,
            new_checksum=new_cs,
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        settings = self._read_settings()
        env_block = settings.get("env", {})
        actual_url = env_block.get("ANTHROPIC_BASE_URL")
        ok = actual_url == runtime.base_url
        return ConfigurationChange(
            agent_id="claude-code",
            operation="verify",
            status=ConfigStatus.OK if ok else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=f"ANTHROPIC_BASE_URL={'matched' if ok else 'MISMATCH'}: "
                 f"expected={runtime.base_url!r} actual={actual_url!r}",
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_SETTINGS_PATH.read_bytes()) if _SETTINGS_PATH.exists() else None
        _write_atomic(_SETTINGS_PATH, backup_bytes.decode("utf-8"))
        return ConfigurationChange(
            agent_id="claude-code",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["env"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
