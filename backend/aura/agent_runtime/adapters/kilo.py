"""KiloAdapter — configure Kilo Code to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-10-11):
  ~/.config/kilo/kilo.jsonc  (JSONC, $schema: app.kilo.ai/config.json)
  kilo.jsonc does NOT support an "env" key — writing one causes kilo to
  refuse to start with "Unrecognized key: env".

  AURA stores the endpoint config in an advisory shell file:
    ~/.config/kilo/aura-runtime-env.sh

  The execution layer (fabric/executors.ts _readAdvisoryEnv) reads this file
  at spawn time and injects the vars into the subprocess environment so kilo
  receives ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY without a process restart.
"""

from __future__ import annotations

from ..tmpname import unique_sibling
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
from aura.environment.procexec import ExecStatus, run_argv

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
    tmp = unique_sibling(path)
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
        # base_url lives in the advisory env file (injected at spawn time),
        # NOT in kilo.jsonc (which does not support the "env" key).
        base_url = None
        try:
            advisory_text = _ADVISORY_PATH.read_text(encoding="utf-8")
            for line in advisory_text.splitlines():
                m = re.match(r'^\s*export\s+ANTHROPIC_BASE_URL="?([^"\']+)"?\s*$', line)
                if m:
                    base_url = m.group(1).strip()
                    break
        except Exception:
            pass
        if not base_url:
            base_url = os.environ.get("ANTHROPIC_BASE_URL")
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
            outcome = run_argv([binary, "--version"], timeout_ms=5000)
            return outcome.stdout.strip() if outcome.status is ExecStatus.OK else None
        except Exception:
            return None

    def mutable_paths(self) -> list:
        return [_ADVISORY_PATH]

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        # kilo.jsonc does not support an "env" key — desired config is
        # expressed via the advisory env file, not the JSON config.
        return {}

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        # kilo.jsonc does NOT support an "env" key — writing it crashes kilo
        # on startup. The endpoint config is written ONLY to the advisory file;
        # the execution layer (fabric/executors.ts) injects these vars at
        # spawn time so kilo receives them without a process restart.
        # Checksums track the advisory file, which is what actually changes.
        try:
            old_advisory_bytes = _ADVISORY_PATH.read_bytes()
        except FileNotFoundError:
            old_advisory_bytes = b""
        old_cs = checksum(old_advisory_bytes)

        key_line = (
            'export ANTHROPIC_API_KEY="ollama"\n'
            if runtime.auth_type == AuthType.KEYLESS
            else (f'export ANTHROPIC_API_KEY="${{{runtime.api_key_env}}}"\n'
                  if runtime.api_key_env else "")
        )
        advisory = (
            "# AURA-managed runtime env for Kilo Code\n"
            "# Injected into the kilo subprocess by AURA at invocation time.\n"
            f'export ANTHROPIC_BASE_URL="{runtime.base_url}"\n'
            + key_line
        )
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _ADVISORY_PATH.write_text(advisory, encoding="utf-8")
        _ADVISORY_PATH.chmod(0o600)

        return ConfigurationChange(
            agent_id="kilo",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=["aura-runtime-env.sh:ANTHROPIC_BASE_URL",
                            "aura-runtime-env.sh:ANTHROPIC_API_KEY"],
            previous_checksum=old_cs,
            new_checksum=checksum(advisory.encode("utf-8")),
            note=f"Endpoint written to {_ADVISORY_PATH}; injected at spawn time.",
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        # Verify against the advisory file (the single source of truth for
        # kilo's endpoint config — kilo.jsonc does not support "env").
        actual = None
        try:
            advisory_text = _ADVISORY_PATH.read_text(encoding="utf-8")
            for line in advisory_text.splitlines():
                m = re.match(r'^\s*export\s+ANTHROPIC_BASE_URL="?([^"\']+)"?\s*$', line)
                if m:
                    actual = m.group(1).strip()
                    break
        except Exception:
            pass
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
        old_cs = checksum(_ADVISORY_PATH.read_bytes()) if _ADVISORY_PATH.exists() else None
        tmp = unique_sibling(_ADVISORY_PATH)
        tmp.write_bytes(backup_bytes)
        tmp.replace(_ADVISORY_PATH)
        _ADVISORY_PATH.chmod(0o600)
        return ConfigurationChange(
            agent_id="kilo",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["aura-runtime-env.sh:ANTHROPIC_BASE_URL",
                            "aura-runtime-env.sh:ANTHROPIC_API_KEY"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
