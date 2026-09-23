"""QwenCodeAdapter — configure Qwen Code to use a private inference endpoint.

Config mechanism (verified by machine inspection 2026-09-23):
  ~/.qwen/settings.json  (JSON, $version: 4)
  Structure:
    {
      "modelProviders": {
        "openai": [
          { "id": "<id>", "name": "<name>", "baseUrl": "<url>", "envKey": "<ENV_VAR>" }
        ]
      },
      "model": { "name": "<model-id>" },
      "security": { "auth": { "selectedType": "openai" } },
      "$version": 4
    }

  AURA upserts an entry in modelProviders.openai with id "aura-private".
  API key referenced by envKey (never stored in settings.json).
  model.name set to the private model ID.
  security.auth.selectedType set to "openai" (OpenAI-compatible mode).
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

_SETTINGS_PATH = Path.home() / ".qwen" / "settings.json"
_AURA_PROVIDER_ID = "aura-private"
_DEFAULT_ENV_KEY = "AURA_QWEN_API_KEY"


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


class QwenCodeAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("qwen")) or _SETTINGS_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="qwen",
                display_name="Qwen Code",
                version=None,
                binary_path=None,
                config_path=str(_SETTINGS_PATH),
                detected=False,
                adapter_class=f"{__name__}.QwenCodeAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        settings = _read_json(_SETTINGS_PATH)
        # Find AURA provider entry if already applied
        providers = settings.get("modelProviders", {}).get("openai", [])
        aura_entry = next((p for p in providers if p.get("id") == _AURA_PROVIDER_ID), None)
        base_url = aura_entry.get("baseUrl") if aura_entry else None
        model_name = settings.get("model", {}).get("name")
        return AgentRecord(
            agent_id="qwen",
            display_name="Qwen Code",
            version=None,
            binary_path=shutil.which("qwen"),
            config_path=str(_SETTINGS_PATH),
            detected=True,
            adapter_class=f"{__name__}.QwenCodeAdapter",
            current_base_url=base_url,
            current_model=model_name,
            config_status=ConfigStatus.OK,
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        env_key = runtime.api_key_env or _DEFAULT_ENV_KEY
        return {
            "modelProviders.openai": [{
                "id": _AURA_PROVIDER_ID,
                "name": "AURA Private Runtime",
                "baseUrl": runtime.base_url,
                "envKey": env_key,
            }],
            "model.name": runtime.model_id,
            "security.auth.selectedType": "openai",
        }

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        settings = _read_json(_SETTINGS_PATH)
        old_bytes = json.dumps(settings, sort_keys=True).encode()
        old_cs = checksum(old_bytes)

        env_key = runtime.api_key_env or _DEFAULT_ENV_KEY

        # Upsert AURA provider in modelProviders.openai list
        providers = settings.setdefault("modelProviders", {}).setdefault("openai", [])
        existing_idx = next(
            (i for i, p in enumerate(providers) if p.get("id") == _AURA_PROVIDER_ID), None
        )
        entry: dict = {
            "id": _AURA_PROVIDER_ID,
            "name": "AURA Private Runtime",
            "baseUrl": runtime.base_url,
            "envKey": env_key,
        }
        if existing_idx is not None:
            providers[existing_idx] = entry
        else:
            providers.insert(0, entry)

        # Write the API key to env if keyless, otherwise ensure envKey is set
        if runtime.auth_type == AuthType.KEYLESS:
            os.environ[env_key] = "keyless"
        elif runtime.api_key_env:
            actual = os.environ.get(runtime.api_key_env, "")
            if actual:
                os.environ[env_key] = actual

        settings.setdefault("model", {})["name"] = runtime.model_id
        settings.setdefault("security", {}).setdefault("auth", {})["selectedType"] = "openai"

        _write_json(_SETTINGS_PATH, settings)
        new_bytes = json.dumps(settings, sort_keys=True).encode()
        return ConfigurationChange(
            agent_id="qwen",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=["modelProviders.openai", "model.name", "security.auth.selectedType"],
            previous_checksum=old_cs,
            new_checksum=checksum(new_bytes),
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        settings = _read_json(_SETTINGS_PATH)
        providers = settings.get("modelProviders", {}).get("openai", [])
        aura = next((p for p in providers if p.get("id") == _AURA_PROVIDER_ID), None)
        url_ok = aura is not None and aura.get("baseUrl") == runtime.base_url
        model_ok = settings.get("model", {}).get("name") == runtime.model_id
        ok = url_ok and model_ok
        return ConfigurationChange(
            agent_id="qwen",
            operation="verify",
            status=ConfigStatus.OK if ok else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=(
                f"baseUrl={'matched' if url_ok else 'MISMATCH'}; "
                f"model={'matched' if model_ok else 'MISMATCH'}"
            ),
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_SETTINGS_PATH.read_bytes()) if _SETTINGS_PATH.exists() else None
        tmp = _SETTINGS_PATH.with_suffix(".tmp")
        tmp.write_bytes(backup_bytes)
        tmp.replace(_SETTINGS_PATH)
        return ConfigurationChange(
            agent_id="qwen",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["modelProviders.openai", "model.name"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
