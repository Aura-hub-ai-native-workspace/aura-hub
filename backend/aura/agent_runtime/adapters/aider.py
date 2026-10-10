"""AiderAdapter — configure Aider to use a private inference endpoint.

Config mechanism (verified against aider.chat docs, 2026-09-26):
  ~/.aider.conf.yml  (YAML)
    openai-api-base: <base_url>
    openai-api-key:  <key or placeholder>   # keyless servers accept any value
  Model routing: OpenAI-compatible models are addressed with the
  `openai/<model_id>` prefix (aider convention for its OpenAI-compatible
  client). AURA writes `model: openai/<model_id>` unless the id already
  carries a provider prefix.

AURA does not write API key VALUES: for keyless runtimes a non-empty
placeholder is written; for key-protected runtimes the key must be
exported by the user (advisory note in the change record).
"""

from __future__ import annotations

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

_CONFIG_PATH = Path.home() / ".aider.conf.yml"
PROVIDER_PREFIX = "openai/"


def _read_yaml(path: Path) -> dict:
    """Read the flat subset of YAML Aider uses at top level.

    Only scalar `key: value` lines at indentation zero are honoured —
    enough for detection and verify, and never a reason to fail."""
    out: dict = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$", line)
            if m:
                out[m.group(1)] = m.group(2).strip("\"'")
    except Exception:
        return {}
    return out


def _set_keys(text: str, updates: dict[str, str]) -> str:
    """Replace or append flat top-level keys, preserving all other lines."""
    lines = text.splitlines(keepends=True)
    remaining = dict(updates)
    new_lines: list[str] = []
    for line in lines:
        m = re.match(r"^([A-Za-z0-9_-]+)\s*:", line)
        if m and m.group(1) in remaining:
            key = m.group(1)
            new_lines.append(f'{key}: "{remaining.pop(key)}"\n')
        else:
            new_lines.append(line)
    if remaining:
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines.append("\n")
        for key, value in remaining.items():
            new_lines.append(f'{key}: "{value}"\n')
    return "".join(new_lines)


def _model_id_for_aider(model_id: str) -> str:
    return model_id if "/" in model_id else f"{PROVIDER_PREFIX}{model_id}"


class AiderAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("aider")) or _CONFIG_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="aider",
                display_name="Aider",
                version=None,
                binary_path=None,
                config_path=str(_CONFIG_PATH),
                detected=False,
                adapter_class=f"{__name__}.AiderAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        cfg = _read_yaml(_CONFIG_PATH)
        base_url = cfg.get("openai-api-base")
        model = cfg.get("model")
        return AgentRecord(
            agent_id="aider",
            display_name="Aider",
            version=None,
            binary_path=shutil.which("aider"),
            config_path=str(_CONFIG_PATH),
            detected=True,
            adapter_class=f"{__name__}.AiderAdapter",
            current_base_url=base_url,
            current_model=model,
            config_status=ConfigStatus.OK,
            notes=["modelPrefix: OpenAI-compatible models are addressed as openai/<model_id>"],
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        return {
            "openai-api-base": runtime.base_url,
            "model": _model_id_for_aider(runtime.model_id),
        }

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        old_bytes = _CONFIG_PATH.read_bytes() if _CONFIG_PATH.exists() else b""
        old_cs = checksum(old_bytes) if old_bytes else None

        updates = self.buildDesiredConfig(runtime)
        if runtime.auth_type == AuthType.KEYLESS:
            updates["openai-api-key"] = "ollama"
        # For key-protected runtimes the key is NOT written; the user
        # exports OPENAI_API_KEY (aider reads it) — noted in the record.

        text = old_bytes.decode("utf-8") if old_bytes else ""
        new_text = _set_keys(text, updates)
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(new_text, encoding="utf-8")
        tmp.replace(_CONFIG_PATH)

        note = None
        if runtime.auth_type != AuthType.KEYLESS:
            note = (f"key not written; export {runtime.api_key_env or 'OPENAI_API_KEY'} "
                    "before running aider")
        return ConfigurationChange(
            agent_id="aider",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=sorted(updates),
            previous_checksum=old_cs,
            new_checksum=checksum(new_text.encode()),
            note=note or "",
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        cfg = _read_yaml(_CONFIG_PATH)
        url_ok = cfg.get("openai-api-base") == runtime.base_url
        want_model = _model_id_for_aider(runtime.model_id)
        model_ok = cfg.get("model") == want_model
        return ConfigurationChange(
            agent_id="aider",
            operation="verify",
            status=ConfigStatus.OK if (url_ok and model_ok) else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=(
                f"baseUrl={'matched' if url_ok else 'MISMATCH'}; "
                f"model={'matched' if model_ok else 'MISMATCH (want ' + want_model + ')'}"
            ),
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_CONFIG_PATH.read_bytes()) if _CONFIG_PATH.exists() else None
        tmp = _CONFIG_PATH.with_suffix(".tmp")
        tmp.write_bytes(backup_bytes)
        tmp.replace(_CONFIG_PATH)
        return ConfigurationChange(
            agent_id="aider",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["openai-api-base", "model"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
