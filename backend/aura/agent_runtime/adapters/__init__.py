"""AgentConfigurationAdapter — abstract base for per-agent config management."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aura.agent_runtime.model import (
        AgentRecord,
        ConfigurationChange,
        RuntimeConfig,
    )


class AgentConfigurationAdapter(ABC):
    """One adapter per supported AI agent tool.

    Contract:
    - detect()           → True if the agent is installed on this machine
    - readCurrentConfig() → AgentRecord with current endpoint/model (or NOT_INSTALLED)
    - buildDesiredConfig() → dict of raw config values AURA would write (no secrets)
    - apply()            → write the desired config; return ConfigurationChange
    - verify()           → confirm the written config matches desired; return ConfigurationChange
    - restore(backup)    → reinstate a previously saved config bytes; return ConfigurationChange

    Security:
    - Never include API key values in any returned dict or log.
    - Use api_key_env to name an env var; never resolve it.
    - If sovereign_policy would block the runtime's network_class, raise ValueError.
    """

    @abstractmethod
    def detect(self) -> bool:
        """Return True if this agent is installed and runnable."""

    @abstractmethod
    def readCurrentConfig(self) -> "AgentRecord":
        """Read agent's current configuration from disk."""

    @abstractmethod
    def buildDesiredConfig(self, runtime: "RuntimeConfig") -> dict:
        """Return the config structure AURA would write (no secret values)."""

    @abstractmethod
    def apply(self, runtime: "RuntimeConfig") -> "ConfigurationChange":
        """Apply runtime config to the agent. Back up first."""

    @abstractmethod
    def verify(self, runtime: "RuntimeConfig") -> "ConfigurationChange":
        """Read back and confirm the applied config matches desired."""

    @abstractmethod
    def restore(self, backup_bytes: bytes) -> "ConfigurationChange":
        """Restore a backup taken before the last apply."""
