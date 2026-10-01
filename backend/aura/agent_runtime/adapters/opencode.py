"""OpenCodeAdapter — configure OpenCode to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-09-23):
  ~/.config/opencode/opencode.json  (JSON, $schema: opencode.ai/config.json)
  Provider section pattern:
    "provider": {
      "<provider-id>": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "<display>",
        "options": {
          "baseURL": "<url>",
          "apiKey": "{file:~/.config/opencode/<id>.key}"   ← file-reference pattern
        },
        "models": { "<model-id>": { "name": "...", "tool_call": true, ... } }
      }
    }

  AURA manages a provider entry with id "aura-private".
  API key stored in ~/.config/opencode/aura-private.key (mode 0600).
  File-reference pattern prevents the key from appearing in JSON.
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
    RuntimeConfig,
    checksum,
)

_CONFIG_PATH = Path.home() / ".config" / "opencode" / "opencode.json"
_AURA_PROVIDER_ID = "aura-private"
_KEY_FILE = Path.home() / ".config" / "opencode" / "aura-private.key"


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_json(path: Path, data: dict) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


class OpenCodeAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("opencode")) or _CONFIG_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="opencode",
                display_name="OpenCode",
                version=None,
                binary_path=None,
                config_path=str(_CONFIG_PATH),
                detected=False,
                adapter_class=f"{__name__}.OpenCodeAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        cfg = _read_json(_CONFIG_PATH)
        aura_provider = cfg.get("provider", {}).get(_AURA_PROVIDER_ID, {})
        base_url = aura_provider.get("options", {}).get("baseURL")
        models = aura_provider.get("models", {})
        model_id = next(iter(models), None)
        return AgentRecord(
            agent_id="opencode",
            display_name="OpenCode",
            version=None,
            binary_path=shutil.which("opencode"),
            config_path=str(_CONFIG_PATH),
            detected=True,
            adapter_class=f"{__name__}.OpenCodeAdapter",
            current_base_url=base_url,
            current_model=model_id,
            config_status=ConfigStatus.OK if base_url else ConfigStatus.PARTIAL,
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        key_ref = (
            "{file:~/.config/opencode/aura-private.key}"
            if runtime.auth_type != AuthType.KEYLESS
            else "aura-keyless"
        )
        return {
            "provider": {
                _AURA_PROVIDER_ID: {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "AURA Private Runtime",
                    "options": {
                        "baseURL": runtime.base_url,
                        "apiKey": key_ref,
                    },
                    "models": {
                        runtime.model_id: {
                            "name": runtime.model_id,
                            "tool_call": True,
                            "limit": {"context": 128000, "output": 8192},
                        }
                    },
                }
            }
        }

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_json(_CONFIG_PATH)
        old_bytes = json.dumps(cfg, sort_keys=True).encode()
        old_cs = checksum(old_bytes)

        providers = cfg.setdefault("provider", {})
        key_ref = (
            "{file:~/.config/opencode/aura-private.key}"
            if runtime.auth_type != AuthType.KEYLESS
            else "aura-keyless"
        )
        providers[_AURA_PROVIDER_ID] = {
            "npm": "@ai-sdk/openai-compatible",
            "name": "AURA Private Runtime",
            "options": {
                "baseURL": runtime.base_url,
                "apiKey": key_ref,
            },
            "models": {
                runtime.model_id: {
                    "name": runtime.model_id,
                    "tool_call": True,
                    "limit": {"context": 128000, "output": 8192},
                }
            },
        }

        # Write API key to key file (never in JSON)
        if runtime.auth_type != AuthType.KEYLESS and runtime.api_key_env:
            key_val = os.environ.get(runtime.api_key_env, "")
            if key_val:
                _KEY_FILE.write_text(key_val, encoding="utf-8")
                _KEY_FILE.chmod(0o600)
        elif runtime.auth_type == AuthType.KEYLESS:
            _KEY_FILE.write_text("keyless", encoding="utf-8")
            _KEY_FILE.chmod(0o600)

        _write_json(_CONFIG_PATH, cfg)
        new_bytes = json.dumps(cfg, sort_keys=True).encode()
        return ConfigurationChange(
            agent_id="opencode",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=[f"provider.{_AURA_PROVIDER_ID}"],
            previous_checksum=old_cs,
            new_checksum=checksum(new_bytes),
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_json(_CONFIG_PATH)
        aura = cfg.get("provider", {}).get(_AURA_PROVIDER_ID, {})
        actual_url = aura.get("options", {}).get("baseURL")
        actual_model = next(iter(aura.get("models", {})), None)
        url_ok = actual_url == runtime.base_url
        model_ok = actual_model == runtime.model_id
        ok = url_ok and model_ok
        return ConfigurationChange(
            agent_id="opencode",
            operation="verify",
            status=ConfigStatus.OK if ok else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=(
                f"baseURL={'matched' if url_ok else 'MISMATCH'}; "
                f"model={'matched' if model_ok else 'MISMATCH'}"
            ),
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_CONFIG_PATH.read_bytes()) if _CONFIG_PATH.exists() else None
        tmp = _CONFIG_PATH.with_suffix(".tmp")
        tmp.write_bytes(backup_bytes)
        tmp.replace(_CONFIG_PATH)
        return ConfigurationChange(
            agent_id="opencode",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=[f"provider.{_AURA_PROVIDER_ID}"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
