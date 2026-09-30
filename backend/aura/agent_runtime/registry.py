"""AgentRuntimeRegistry — discover installed AI coding/agent tools.

Instantiates all known adapters and calls detect() + readCurrentConfig()
on each. Returns a list of AgentRecord with honest detection results.
"""

from __future__ import annotations

from aura.agent_runtime.adapters.claude_code import ClaudeCodeAdapter
from aura.agent_runtime.adapters.codex import CodexAdapter
from aura.agent_runtime.adapters.gemini import GeminiCliAdapter
from aura.agent_runtime.adapters.kilo import KiloAdapter
from aura.agent_runtime.adapters.opencode import OpenCodeAdapter
from aura.agent_runtime.adapters.qwen import QwenCodeAdapter
from aura.agent_runtime.model import AgentRecord

_ALL_ADAPTERS = [
    ClaudeCodeAdapter,
    CodexAdapter,
    OpenCodeAdapter,
    KiloAdapter,
    QwenCodeAdapter,
    GeminiCliAdapter,
]


class AgentRuntimeRegistry:
    """Discovers installed AI agents and maintains per-agent adapter instances."""

    def __init__(self) -> None:
        self._adapters = {
            cls.__name__: cls() for cls in _ALL_ADAPTERS
        }

    def discover(self) -> list[AgentRecord]:
        """Run detection and config-read on all known agents.
        Returns every agent (detected=False for not installed ones).
        """
        records: list[AgentRecord] = []
        for adapter in self._adapters.values():
            try:
                record = adapter.readCurrentConfig()
            except Exception as exc:
                # Never crash the discovery loop — record the error honestly
                from aura.agent_runtime.model import ConfigStatus
                record = AgentRecord(
                    agent_id="unknown",
                    display_name=type(adapter).__name__,
                    version=None,
                    binary_path=None,
                    config_path=None,
                    detected=False,
                    adapter_class=f"{type(adapter).__module__}.{type(adapter).__name__}",
                    config_status=ConfigStatus.ERROR,
                    notes=[f"discovery error: {exc}"],
                )
            records.append(record)
        return records

    def installed(self) -> list[AgentRecord]:
        """Only detected (installed) agents."""
        return [r for r in self.discover() if r.detected]

    def adapter_for(self, agent_id: str):
        """Return the adapter instance for an agent_id, or None."""
        for adapter in self._adapters.values():
            record = adapter.readCurrentConfig()
            if record.agent_id == agent_id:
                return adapter
        return None
