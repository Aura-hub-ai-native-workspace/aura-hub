"""CrushAdapter — configure Crush for a private OpenAI-compatible endpoint.

Config mechanism (verified against charmbracelet/crush README + docs,
2026-09-26):
  ~/.config/crush/crush.json
    {
      "$schema": "https://charm.land/crush.json",
      "providers": {
        "aura-private": {
          "name": "AURA Private Runtime",
          "type": "openai",
          "base_url": "<base_url>",
          "api_key": "<placeholder>",       # keyless: any non-empty value
          "models": [{ "id": "<model_id>", "name": "<model_id>" }]
        }
      },
      "model": "aura-private/<model_id>"
    }

Crush addresses models as <provider_id>/<model_id>. AURA upserts only the
aura-private provider and the top-level model pointer; user providers are
never touched. API key VALUES are never written for key-protected
runtimes (placeholder + advisory note).
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

_CONFIG_PATH = Path.home() / ".config" / "crush" / "crush.json"
PROVIDER_ID = "aura-private"


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


def _model_ref(model_id: str) -> str:
    return model_id if "/" in model_id else f"{PROVIDER_ID}/{model_id}"


class CrushAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("crush")) or _CONFIG_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="crush",
                display_name="Crush",
                version=None,
                binary_path=None,
                config_path=str(_CONFIG_PATH),
                detected=False,
                adapter_class=f"{__name__}.CrushAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        cfg = _read_json(_CONFIG_PATH)
        provider = cfg.get("providers", {}).get(PROVIDER_ID, {})
        base_url = provider.get("base_url")
        model_ref = cfg.get("model")
        current_model = model_ref.split("/", 1)[1] if (
            isinstance(model_ref, str) and model_ref.startswith(f"{PROVIDER_ID}/")
        ) else None
        return AgentRecord(
            agent_id="crush",
            display_name="Crush",
            version=None,
            binary_path=shutil.which("crush"),
            config_path=str(_CONFIG_PATH),
            detected=True,
            adapter_class=f"{__name__}.CrushAdapter",
            current_base_url=base_url,
            current_model=current_model,
            config_status=ConfigStatus.OK,
            notes=["modelRef: crush addresses providers as <provider_id>/<model_id>"],
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        api_key = "ollama" if runtime.auth_type == AuthType.KEYLESS else (
            "set-your-key-env" if not runtime.api_key_env else f"$ref:{runtime.api_key_env}"
        )
        return {
            f"providers.{PROVIDER_ID}": {
                "name": "AURA Private Runtime",
                "type": "openai",
                "base_url": runtime.base_url,
                "api_key": api_key,
                "models": [{"id": runtime.model_id, "name": runtime.model_id}],
            },
            "model": _model_ref(runtime.model_id),
        }

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_json(_CONFIG_PATH)
        old_bytes = json.dumps(cfg, sort_keys=True).encode()
        old_cs = checksum(old_bytes)

        providers = cfg.setdefault("providers", {})
        desired = self.buildDesiredConfig(runtime)
        provider_entry = dict(desired[f"providers.{PROVIDER_ID}"])
        # Preserve an existing key value if the user already set one and
        # AURA is not replacing it with a concrete value.
        existing = providers.get(PROVIDER_ID, {})
        if (
            existing.get("api_key")
            and provider_entry["api_key"] in ("$ref:" + runtime.api_key_env, "set-your-key-env")
        ):
            provider_entry["api_key"] = existing["api_key"]
        providers[PROVIDER_ID] = provider_entry
        cfg["model"] = desired["model"]

        _write_json(_CONFIG_PATH, cfg)
        new_cs = checksum(json.dumps(cfg, sort_keys=True).encode())
        note = None
        if runtime.auth_type != AuthType.KEYLESS and not runtime.api_key_env:
            note = "key value not written; set providers.aura-private.api_key yourself"
        return ConfigurationChange(
            agent_id="crush",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=[f"providers.{PROVIDER_ID}", "model"],
            previous_checksum=old_cs,
            new_checksum=new_cs,
            note=note or "",
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_json(_CONFIG_PATH)
        provider = cfg.get("providers", {}).get(PROVIDER_ID, {})
        url_ok = provider.get("base_url") == runtime.base_url
        model_ok = cfg.get("model") == _model_ref(runtime.model_id)
        return ConfigurationChange(
            agent_id="crush",
            operation="verify",
            status=ConfigStatus.OK if (url_ok and model_ok) else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=(
                f"baseUrl={'matched' if url_ok else 'MISMATCH'}; "
                f"model={'matched' if model_ok else 'MISMATCH'}"
            ),
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_CONFIG_PATH.read_bytes()) if _CONFIG_PATH.exists() else None
        tmp = _CONFIG_PATH.with_suffix(".tmp")
        tmp.write_bytes(backup_bytes)
        tmp.replace(_CONFIG_PATH)
        return ConfigurationChange(
            agent_id="crush",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=[f"providers.{PROVIDER_ID}", "model"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
