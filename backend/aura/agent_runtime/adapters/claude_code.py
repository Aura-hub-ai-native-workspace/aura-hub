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

WRITE GUARD (root-cause fix, 2026-09-23):
  AURA is developed on the same machine — and often from inside Claude Code
  itself — where this adapter runs. An unconditional apply() therefore
  rewrites the *developer's own* live Claude configuration (notably
  ANTHROPIC_BASE_URL), breaking the very agent doing the work on every
  apply/test/verify run.

  Policy enforced HERE, in the backend adapter (not in UI or prompts):
  - apply()/restore() NEVER write to the live ~/.claude/settings.json by
    default. Without explicit opt-in they REFUSE (status ERROR) and touch
    nothing — the live file is never written, not even transiently
    (no write-then-restore).
  - Writes are allowed only to an explicitly isolated settings file
    (ClaudeCodeAdapter(settings_path=...), used by tests and tooling), or
    to the live installation when the operator explicitly opts in with the
    AURA_MANAGE_EXTERNAL_CLAUDE=1 process environment variable.
  - verify()/readCurrentConfig()/buildDesiredConfig() are read-only and
    unaffected.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from aura.environment.procexec import ExecStatus, run_argv

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
# Immutable reference to the developer's live config. The guard compares
# every write target against this; _SETTINGS_PATH above stays monkeypatchable
# for tests, this one must not be.
_REAL_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
# Explicit operator opt-in for managing a live external Claude installation.
_MANAGE_ENV_VAR = "AURA_MANAGE_EXTERNAL_CLAUDE"
_OPT_IN_VALUES = {"1", "true", "yes", "on"}
_BINARY_CANDIDATES = ["/usr/bin/claude", "/usr/local/bin/claude",
                      str(Path.home() / ".local/bin/claude")]


def _opted_in() -> bool:
    """True only when the operator explicitly opts into live-config writes."""
    return os.environ.get(_MANAGE_ENV_VAR, "").strip().lower() in _OPT_IN_VALUES


def _is_live_path(path: Path) -> bool:
    """True when path resolves to the developer's live Claude settings file."""
    try:
        return os.path.realpath(path) == os.path.realpath(_REAL_SETTINGS_PATH)
    except Exception:
        return False


class ClaudeCodeAdapter(AgentConfigurationAdapter):

    def __init__(self, settings_path: str | Path | None = None) -> None:
        # Explicit isolated target (tests, tooling, managed fleets).
        # None = default location (_SETTINGS_PATH, still monkeypatchable).
        self._explicit_path = (
            Path(settings_path) if settings_path is not None else None
        )

    def _resolve_write_target(self) -> Path | None:
        """Settings file apply()/restore() may write, or None to refuse.

        The live developer config is returned ONLY under explicit opt-in.
        Every other live-targeting call gets None (refuse, write nothing).
        """
        candidate = (
            self._explicit_path if self._explicit_path is not None
            else _SETTINGS_PATH
        )
        candidate = Path(candidate)
        if _is_live_path(candidate) and not _opted_in():
            return None
        return candidate

    def _refused(
        self, operation: str, live: Path, current_bytes: bytes
    ) -> ConfigurationChange:
        # Checksums are taken over the untouched live bytes, so the refusal
        # itself evidences that nothing changed (previous == new).
        cs = checksum(current_bytes)
        return ConfigurationChange(
            agent_id="claude-code",
            operation=operation,
            status=ConfigStatus.ERROR,
            fields_changed=[],
            previous_checksum=cs,
            new_checksum=cs,
            note=(
                f"Refused to modify the live Claude Code configuration at "
                f"{live}. Set {_MANAGE_ENV_VAR}=1 to explicitly opt in, or "
                f"construct ClaudeCodeAdapter(settings_path=<isolated file>). "
                f"Nothing was written."
            ),
        )

    def _live_bytes(self) -> bytes:
        try:
            if _REAL_SETTINGS_PATH.exists():
                return _REAL_SETTINGS_PATH.read_bytes()
        except Exception:
            pass
        return b""

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

    def _read_settings(self, path: Path | None = None) -> dict:
        target = Path(path) if path is not None else _SETTINGS_PATH
        if not target.exists():
            return {}
        try:
            return json.loads(target.read_text(encoding="utf-8"))
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
            outcome = run_argv(["claude", "--version"], timeout_ms=5000)
            if outcome.status is ExecStatus.OK and outcome.stdout.strip():
                m = re.search(r"(\d+\.\d+\.\d+[\w.-]*)", outcome.stdout)
                return m.group(1) if m else None
            return None
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
        target = self._resolve_write_target()
        if target is None:
            # Guard: never touch the live developer config without opt-in.
            return self._refused("apply", _REAL_SETTINGS_PATH, self._live_bytes())

        settings = self._read_settings(target)
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
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(target, new_text)

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
        target = self._resolve_write_target()
        if target is None:
            # Guard: restore also writes — same refusal, no write-then-restore.
            return self._refused("restore", _REAL_SETTINGS_PATH, self._live_bytes())
        old_cs = (
            checksum(target.read_bytes()) if target.exists() else None
        )
        _write_atomic(target, backup_bytes.decode("utf-8"))
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
