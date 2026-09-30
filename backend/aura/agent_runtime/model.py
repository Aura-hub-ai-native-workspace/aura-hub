"""Data models for the AI Agent Runtime Control Plane.

RuntimeConfig  — one private AI inference endpoint (base_url + model_id).
AgentRecord    — a discovered AI coding/agent tool on this machine.
ConfigurationChange — before/after record (no secret values).
ConfigurationDrift  — AURA-expected vs actual comparison result.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any


class AuthType(str, Enum):
    KEYLESS = "keyless"        # no Authorization header (Ollama default)
    BEARER = "bearer"          # Authorization: Bearer <token>
    API_KEY = "api_key"        # x-api-key header or provider-specific


class ConfigStatus(str, Enum):
    OK = "ok"
    PARTIAL = "partial"        # applied, but some fields need manual action
    INCOMPATIBLE = "incompatible"
    NOT_INSTALLED = "not_installed"
    ERROR = "error"


class DriftStatus(str, Enum):
    IN_SYNC = "in_sync"
    DRIFTED = "drifted"
    UNKNOWN = "unknown"        # could not read current config


@dataclass(frozen=True)
class RuntimeConfig:
    """A private AI inference runtime that AURA manages."""
    base_url: str
    model_id: str
    auth_type: AuthType = AuthType.KEYLESS
    network_class: str = "local"   # local | private | cloud | unknown
    health_path: str = "/health"
    api_key_env: str = ""           # env var name — never the value itself

    def to_dict(self) -> dict:
        """Safe for logs — never includes key material."""
        return {
            "baseUrl": self.base_url,
            "modelId": self.model_id,
            "authType": self.auth_type.value,
            "networkClass": self.network_class,
            "healthPath": self.health_path,
            "apiKeyConfigured": bool(self.api_key_env),
        }


@dataclass
class AgentRecord:
    """A discovered AI coding/agent tool installed on this machine."""
    agent_id: str          # e.g. "claude-code", "opencode"
    display_name: str
    version: str | None
    binary_path: str | None
    config_path: str | None    # primary config file path
    detected: bool
    adapter_class: str         # fully-qualified class name
    current_base_url: str | None = None
    current_model: str | None = None
    config_status: ConfigStatus = ConfigStatus.NOT_INSTALLED
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "agentId": self.agent_id,
            "displayName": self.display_name,
            "version": self.version,
            "binaryPath": self.binary_path,
            "configPath": self.config_path,
            "detected": self.detected,
            "currentBaseUrl": self.current_base_url,
            "currentModel": self.current_model,
            "configStatus": self.config_status.value,
            "notes": self.notes,
        }


@dataclass
class ConfigurationChange:
    """Operational evidence for one configuration operation.
    Never includes secret values — only what changed structurally.
    """
    agent_id: str
    operation: str           # "apply" | "restore" | "verify"
    status: ConfigStatus
    fields_changed: list[str]
    previous_checksum: str | None   # SHA-256 of previous config bytes
    new_checksum: str | None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "agentId": self.agent_id,
            "operation": self.operation,
            "status": self.status.value,
            "fieldsChanged": self.fields_changed,
            "previousChecksum": self.previous_checksum,
            "newChecksum": self.new_checksum,
            "timestamp": self.timestamp,
            "note": self.note,
        }


@dataclass
class ConfigurationDrift:
    agent_id: str
    status: DriftStatus
    drifted_fields: list[str]    # field names that differ
    expected_base_url: str | None
    actual_base_url: str | None
    expected_model: str | None
    actual_model: str | None
    checked_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "agentId": self.agent_id,
            "status": self.status.value,
            "driftedFields": self.drifted_fields,
            "expectedBaseUrl": self.expected_base_url,
            "actualBaseUrl": self.actual_base_url,
            "expectedModel": self.expected_model,
            "actualModel": self.actual_model,
            "checkedAt": self.checked_at,
        }


def checksum(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()
