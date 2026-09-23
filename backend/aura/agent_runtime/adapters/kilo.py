"""KiloAdapter — configure Kilo Code to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-09-23):
  ~/.config/kilo/kilo.jsonc  (JSONC, $schema: app.kilo.ai/config.json)
  Observed sections: permission only.
  Kilo Code v7.5.14 is a Claude-architecture fork — it respects:
    ANTHROPIC_BASE_URL  — overrides the inference endpoint
    ANTHROPIC_API_KEY   — API key (use "ollama" for keyless local)

  AURA writes these into kilo.jsonc under an "env" key (same pattern as
  Claude Code settings.json). If the kilo.jsonc schema does not support "env",
  apply() falls back to writing ~/.config/kilo/aura-runtime-env.sh advisory.

  Status returned is PARTIAL until env-injection support is confirmed.
"""

from __future__ import annotations

import json
import os
import re
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

_CONFIG_PATH = Path.home() / ".config" / "kilo" / "kilo.jsonc"
_ADVISORY_PATH = Path.home() / ".config" / "kilo" / "aura-runtime-env.sh"


def _read_jsonc(path: Path) -> dict:
    """Parse JSONC: strip // line comments before parsing."""
    try:
        raw = path.read_text(encoding="utf-8")
        stripped = re.sub(r"//[^\n]*", "", raw)
        return json.loads(stripped)
    except Exception:
        return {}


def _write_jsonc(path: Path, data: dict) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


class KiloAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("kilo")) or bool(shutil.which("kilocode")) or _CONFIG_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="kilo",
                display_name="Kilo Code",
                version=None,
                binary_path=None,
                config_path=str(_CONFIG_PATH),
                detected=False,
                adapter_class=f"{__name__}.KiloAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        cfg = _read_jsonc(_CONFIG_PATH)
        env_block = cfg.get("env", {})
        base_url = env_block.get("ANTHROPIC_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL")
        binary = shutil.which("kilo") or shutil.which("kilocode")
        version = self._get_version(binary)
        return AgentRecord(
            agent_id="kilo",
            display_name="Kilo Code",
            version=version,
            binary_path=binary,
            config_path=str(_CONFIG_PATH),
            detected=True,
            adapter_class=f"{__name__}.KiloAdapter",
            current_base_url=base_url,
            current_model=None,
            config_status=ConfigStatus.OK,
            notes=["configFormat: JSONC; envInjectionSupport: unconfirmed"],
        )

    def _get_version(self, binary: str | None) -> str | None:
        if not binary:
            return None
        try:
            import subprocess
            r = subprocess.run([binary, "--version"], capture_output=True,
                               text=True, timeout=5)
            return r.stdout.strip() if r.returncode == 0 else None
        except Exception:
            return None

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        cfg = _read_jsonc(_CONFIG_PATH)
        env_block = dict(cfg.get("env", {}))
        env_block["ANTHROPIC_BASE_URL"] = runtime.base_url
        if runtime.auth_type == AuthType.KEYLESS:
            env_block["ANTHROPIC_API_KEY"] = "ollama"
        elif runtime.api_key_env:
            env_block["ANTHROPIC_API_KEY"] = f"$ref:{runtime.api_key_env}"
        return {"env": env_block}

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_jsonc(_CONFIG_PATH)
        old_bytes = json.dumps(cfg, sort_keys=True).encode()
        old_cs = checksum(old_bytes)

        env_block = dict(cfg.get("env", {}))
        env_block["ANTHROPIC_BASE_URL"] = runtime.base_url
        if runtime.auth_type == AuthType.KEYLESS:
            env_block["ANTHROPIC_API_KEY"] = "ollama"
        elif runtime.api_key_env:
            actual = os.environ.get(runtime.api_key_env, "")
            if actual:
                env_block["ANTHROPIC_API_KEY"] = actual
        cfg["env"] = env_block

        _write_jsonc(_CONFIG_PATH, cfg)

        # Also write advisory in case kilo ignores the env block
        key_line = (
            'export ANTHROPIC_API_KEY="ollama"\n'
            if runtime.auth_type == AuthType.KEYLESS
            else (f'export ANTHROPIC_API_KEY="${{{runtime.api_key_env}}}"\n'
                  if runtime.api_key_env else "")
        )
        advisory = (
            "# AURA-managed runtime env for Kilo Code\n"
            "# Source before starting Kilo if env block in kilo.jsonc is not respected.\n"
            f'export ANTHROPIC_BASE_URL="{runtime.base_url}"\n'
            + key_line
        )
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _ADVISORY_PATH.write_text(advisory, encoding="utf-8")
        _ADVISORY_PATH.chmod(0o600)

        new_bytes = json.dumps(cfg, sort_keys=True).encode()
        return ConfigurationChange(
            agent_id="kilo",
            operation="apply",
            status=ConfigStatus.PARTIAL,
            fields_changed=["env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_API_KEY"],
            previous_checksum=old_cs,
            new_checksum=checksum(new_bytes),
            note="Written to kilo.jsonc env block; advisory also at "
                 f"{_ADVISORY_PATH} if schema ignores env key",
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_jsonc(_CONFIG_PATH)
        actual = cfg.get("env", {}).get("ANTHROPIC_BASE_URL")
        ok = actual == runtime.base_url
        return ConfigurationChange(
            agent_id="kilo",
            operation="verify",
            status=ConfigStatus.OK if ok else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=f"ANTHROPIC_BASE_URL={'matched' if ok else 'MISMATCH'}",
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_CONFIG_PATH.read_bytes()) if _CONFIG_PATH.exists() else None
        tmp = _CONFIG_PATH.with_suffix(".tmp")
        tmp.write_bytes(backup_bytes)
        tmp.replace(_CONFIG_PATH)
        return ConfigurationChange(
            agent_id="kilo",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["env"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
