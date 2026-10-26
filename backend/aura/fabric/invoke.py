"""Invocation contract helpers.

The governed path itself — resolve → policy (hard floors and
the person's own asks only) → execute → verify → audit — is
CapabilityFabric.invoke in aura.fabric, reached through
aura.fabric.invoke_fabric. A second, older copy of that pipeline used to
live in this module. Nothing called it, and it carried its own approval
gate outside the one policy engine, so it was removed rather than left as
an unused path around it.

What remains are the pure helpers that describe and validate an
invocation's arguments against a capability's declared contract.
"""

from __future__ import annotations

from typing import Any

from ..jsonutil import dumps_compact

_SECRET = ("apikey", "token", "secret", "password")


def summarize_input(capability: dict, input: dict[str, Any]) -> str:
    """Bounded, redacted summary for the audit record (fabric.ts:147-161)."""
    parts: list[str] = []
    for f in (capability.get("input") or []):
        raw = input.get(f.get("name"))
        if raw is None:
            continue
        if f.get("name", "").lower().replace("_", "") in _SECRET:
            parts.append(f"{f.get('name')}=<redacted>")
            continue
        text = raw if isinstance(raw, str) else dumps_compact(raw)
        parts.append(f"{f.get('name')}={text[:57]}…" if len(text) > 60 else f"{f.get('name')}={text}")
    return " ".join(parts) or "(no arguments)"


def describe_target(capability: dict, input: dict[str, Any]) -> str | None:
    for key in ("path", "url", "command", "name", "branch", "message", "projectId"):
        value = input.get(key)
        if isinstance(value, str) and value.strip():
            return value[:77] + "…" if len(value) > 80 else value
    return "AURA Hub" if capability.get("surface") == "aura-internal" else None


def validate_input(capability: dict, input: dict[str, Any]) -> str | None:
    """Reject arguments violating the declared contract (fabric.ts:179-192)."""
    for f in (capability.get("input") or []):
        name = f.get("name", "")
        value = input.get(name)
        if value is None or value == "":
            if f.get("required"):
                return f"{name} is required."
            continue
        actual = "array" if isinstance(value, list) else type(value).__name__
        if f.get("type") == "number":
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        elif f.get("type") == "boolean":
            ok = isinstance(value, bool)
        elif f.get("type") == "array":
            ok = isinstance(value, list)
        elif f.get("type") == "string[]":
            ok = isinstance(value, list) and all(isinstance(v, str) for v in value)
        elif f.get("type") == "object":
            ok = isinstance(value, dict)
        else:
            ok = isinstance(value, str)
        if not ok:
            return f"{name} should be a {f.get('type')}, got {actual}."
    return None


__all__ = [
    "describe_target",
    "summarize_input",
    "validate_input",
]
