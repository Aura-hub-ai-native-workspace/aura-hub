"""MCP gateway foundation — the trust boundary for external tools.

This milestone implements the BOUNDARY, not the transport: no MCP server
is contacted. What exists and is enforced here:

- External tool descriptors are UNTRUSTED DATA. sanitize_external_tool()
  drops unknown fields, clamps descriptions, strips control characters and
  forbids ids that could collide with native capabilities.
- Trust levels gate availability: only verified/known servers may register
  tools, and every mapped tool arrives with EMPTY permissions — authority
  is never inferred from a description or an annotation.
- Risk floors: unknown/untrusted servers yield high risk, which the policy
  engine maps to require-approval at invocation time. The gateway cannot
  lower it; it does not try.

When live transports land (next milestone), invocations will still be
forced through aura.fabric.invoke — the gateway adds tools, never paths.
"""

from __future__ import annotations

import re

from ..contracts import ToolDescriptor

_DESCRIPTION_CAP = 512
_SAFE_NAME = re.compile(r"[^a-z0-9_-]+")
_NATIVE_ID = re.compile(r"^(workflow|project|terminal|agent|system|context)\.")


class McpRegistrationError(Exception):
    pass


def _clean_text(value: object, cap: int) -> str:
    text = str(value or "")
    text = "".join(ch for ch in text if ch.isprintable())
    return text[:cap]


def sanitize_external_tool(
    raw: dict,
    server_id: str,
    server_trust: str,
) -> ToolDescriptor:
    """Map one hostile tool definition onto a safe ToolDescriptor.

    Only allow-listed fields survive; everything else — including any
    'instructions' a poisoned server plants in metadata — is dropped.
    """
    raw_name = str(raw.get("name") or "")
    if _NATIVE_ID.match(raw_name.strip().lower()):
        raise McpRegistrationError(
            "tool name collides with AURA's native capability namespaces")
    name = _SAFE_NAME.sub("-", _clean_text(raw.get("name"), 64).lower()).strip("-")
    if not name:
        raise McpRegistrationError("tool has no usable name")
    tool_id = f"mcp.{_SAFE_NAME.sub('-', server_id)}.{name}"

    description = _clean_text(raw.get("description"), _DESCRIPTION_CAP)
    annotations = raw.get("annotations") if isinstance(raw.get("annotations"), dict) else {}
    read_only = annotations.get("readOnlyHint") is True

    trust = server_trust if server_trust in ("verified", "known") else (
        "unknown" if server_trust == "unknown" else "untrusted")
    risk = "low" if (trust == "verified" and read_only) else \
           "medium" if trust == "verified" else "high"

    return ToolDescriptor(
        id=tool_id,
        name=name,
        description=description,   # data, never instructions
        risk=risk,
        permissions=[],            # NEVER inferred from a description
        inputFields=[],
        sideEffects=not read_only,
        reversible=bool(read_only),
        available=False,           # no transport exists yet
        source="mcp",
        trust=trust,
    )


class McpGateway:
    def __init__(self) -> None:
        self._servers: dict[str, str] = {}

    def register_server(self, server_id: str, trust: str) -> None:
        if trust not in ("verified", "known", "unknown", "untrusted"):
            raise McpRegistrationError(f"unknown trust level {trust!r}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", server_id):
            raise McpRegistrationError("server id must be [a-z0-9-]")
        self._servers[server_id] = trust

    def map_tool(self, server_id: str, raw_tool: dict) -> ToolDescriptor:
        if server_id not in self._servers:
            raise McpRegistrationError(f"server {server_id!r} is not registered")
        return sanitize_external_tool(raw_tool, server_id, self._servers[server_id])
