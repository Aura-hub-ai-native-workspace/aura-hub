"""ContinueCliAdapter — configure Continue CLI (cn) for a private endpoint.

Config mechanism (verified against docs.continue.dev, 2026-09-26):
  ~/.continue/config.yaml  (YAML)
    name: ...
    schema: v1
    models:
      - name: <display name>
        provider: openai
        model: <model_id>
        apiBase: <base_url>
        apiKey: <placeholder for keyless; env refs elsewhere>
        roles: [chat, edit, apply]

AURA upserts ONE `aura-private` model entry pointing at the runtime and
does not touch other entries. For keyless runtimes the apiKey is a
non-empty placeholder; for key-protected runtimes the key value is never
written (the user configures it; noted in the change record).
"""

from __future__ import annotations

from ..tmpname import unique_sibling
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

_CONFIG_PATH = Path.home() / ".continue" / "config.yaml"
AURA_MODEL_NAME = "aura-private"


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _aura_entry_block(runtime: RuntimeConfig) -> list[str]:
    """Render the aura-private model entry as YAML lines (2-space indent)."""
    api_key = "ollama" if runtime.auth_type == AuthType.KEYLESS else (
        f"${{{runtime.api_key_env}}}" if runtime.api_key_env else "ollama"
    )
    return [
        "  - name: aura-private",
        "    provider: openai",
        f"    model: {runtime.model_id}",
        f"    apiBase: {runtime.base_url}",
        f"    apiKey: {api_key}",
        "    roles:",
        "      - chat",
        "      - edit",
        "      - apply",
    ]


def _upsert_aura_entry(text: str, runtime: RuntimeConfig) -> str:
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    replaced = False
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("- name:") and AURA_MODEL_NAME in line:
            # Skip the existing aura entry block (until the next "- name:"
            # at list level or a top-level key), then splice the new one.
            i += 1
            while i < len(lines) and (
                lines[i].startswith("      ") or (lines[i].startswith("    ") and not lines[i].strip().startswith("- name:"))
            ):
                i += 1
            if not replaced:
                out.extend(_aura_entry_block(runtime))
                replaced = True
            continue
        out.append(line)
        i += 1
    if not replaced:
        # Append as a models: list item (creating the list if absent).
        if any(l.strip() == "models:" for l in out):
            out.extend(_aura_entry_block(runtime))
        else:
            if out and out[-1].strip():
                out.append("")
            out.append("models:")
            out.extend(_aura_entry_block(runtime))
    return "\n".join(out) + "\n"


def _read_aura_entry(path: Path) -> tuple[str | None, str | None]:
    """Extract (apiBase, model) of the aura-private entry, if present."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return None, None
    in_entry = False
    api_base = model = None
    for line in lines:
        if line.strip().startswith("- name:") and AURA_MODEL_NAME in line:
            in_entry = True
            continue
        if in_entry:
            if line.strip().startswith("- name:") or (line and not line.startswith(" ")):
                break
            m = re.match(r"\s+apiBase:\s*(.+?)\s*$", line)
            if m:
                api_base = m.group(1).strip("\"'")
            m = re.match(r"\s+model:\s*(.+?)\s*$", line)
            if m:
                model = m.group(1).strip("\"'")
    return api_base, model


class ContinueCliAdapter(AgentConfigurationAdapter):

    def detect(self) -> bool:
        return bool(shutil.which("cn")) or _CONFIG_PATH.exists()

    def readCurrentConfig(self) -> AgentRecord:
        if not self.detect():
            return AgentRecord(
                agent_id="continue-cli",
                display_name="Continue CLI",
                version=None,
                binary_path=None,
                config_path=str(_CONFIG_PATH),
                detected=False,
                adapter_class=f"{__name__}.ContinueCliAdapter",
                config_status=ConfigStatus.NOT_INSTALLED,
            )
        api_base, model = _read_aura_entry(_CONFIG_PATH)
        return AgentRecord(
            agent_id="continue-cli",
            display_name="Continue CLI",
            version=None,
            binary_path=shutil.which("cn"),
            config_path=str(_CONFIG_PATH),
            detected=True,
            adapter_class=f"{__name__}.ContinueCliAdapter",
            current_base_url=api_base,
            current_model=model,
            config_status=ConfigStatus.OK,
            notes=["auraEntry: only the aura-private models entry is AURA-managed"],
        )

    def buildDesiredConfig(self, runtime: RuntimeConfig) -> dict:
        entry = dict(zip(
            ("name", "provider", "model", "apiBase", "apiKey"),
            (AURA_MODEL_NAME, "openai", runtime.model_id, runtime.base_url,
             "ollama" if runtime.auth_type == AuthType.KEYLESS else "env-ref"),
        ))
        return {"models[aura-private]": entry}

    def apply(self, runtime: RuntimeConfig) -> ConfigurationChange:
        old_text = _read_text(_CONFIG_PATH)
        old_cs = checksum(old_text.encode()) if old_text else None
        new_text = _upsert_aura_entry(old_text, runtime)
        _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = unique_sibling(_CONFIG_PATH)
        tmp.write_text(new_text, encoding="utf-8")
        tmp.replace(_CONFIG_PATH)
        note = None
        if runtime.auth_type != AuthType.KEYLESS and not runtime.api_key_env:
            note = "key value not written; set apiKey in the aura-private entry or export your key env"
        return ConfigurationChange(
            agent_id="continue-cli",
            operation="apply",
            status=ConfigStatus.OK,
            fields_changed=["models.aura-private"],
            previous_checksum=old_cs,
            new_checksum=checksum(new_text.encode()),
            note=note or "",
        )

    def verify(self, runtime: RuntimeConfig) -> ConfigurationChange:
        api_base, model = _read_aura_entry(_CONFIG_PATH)
        ok = api_base == runtime.base_url and model == runtime.model_id
        return ConfigurationChange(
            agent_id="continue-cli",
            operation="verify",
            status=ConfigStatus.OK if ok else ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=None,
            new_checksum=None,
            note=(
                f"baseUrl={'matched' if api_base == runtime.base_url else 'MISMATCH'}; "
                f"model={'matched' if model == runtime.model_id else 'MISMATCH'}"
            ),
        )

    def restore(self, backup_bytes: bytes) -> ConfigurationChange:
        old_cs = checksum(_CONFIG_PATH.read_bytes()) if _CONFIG_PATH.exists() else None
        tmp = unique_sibling(_CONFIG_PATH)
        tmp.write_bytes(backup_bytes)
        tmp.replace(_CONFIG_PATH)
        return ConfigurationChange(
            agent_id="continue-cli",
            operation="restore",
            status=ConfigStatus.OK,
            fields_changed=["models.aura-private"],
            previous_checksum=old_cs,
            new_checksum=checksum(backup_bytes),
        )
