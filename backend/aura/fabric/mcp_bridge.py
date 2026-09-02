"""Governed MCP tool registration — the ONE Fabric path for MCP effects.

An MCP tool becomes a Fabric capability ONLY through this module:
  • the descriptor is sanitized (id charset, truncated description, typed
    input fields) and can never collide with an existing capability;
  • permissions are NEVER inferred from the MCP description — the
    descriptor carries none, and the policy risk floor for MCP is HIGH,
    so every invocation parks for a human decision;
  • execution happens inside CapabilityFabric.invoke (policy → approval →
    audit), never by calling the transport directly from callers;
  • output is fenced as untrusted data with provenance markers.

ADDITIVE Python behavior: no TypeScript oracle exists for governed MCP.
"""
from __future__ import annotations

import re

MCP_RISK_FLOOR = "high"
MAX_DESC_CHARS = 200
_ID_OK = re.compile(r"[^a-z0-9._-]")


def sanitize_tool_name(server_id: str, raw_name: str) -> str:
    """mcp.<server>.<tool>, lowercased, charset-fenced."""
    server = _ID_OK.sub("-", str(server_id).strip().lower()) or "srv"
    name = _ID_OK.sub("-", str(raw_name).strip().lower())
    return f"mcp.{server}.{name}"


def sanitize_mcp_tool(server_id: str, tool: dict) -> dict:
    """Untrusted MCP descriptor → fenced capability descriptor.

    The description is treated as DATA (truncated, never parsed for
    authority). Input fields keep only safe primitives; everything else is
    dropped, not guessed.
    """
    raw_name = str(tool.get("name") or "").strip()
    if not raw_name:
        raise ValueError("mcp tool has no name")
    description = str(tool.get("description") or "")[:MAX_DESC_CHARS]
    fields: list[dict] = []
    for f in (tool.get("inputSchema") or {}).get("properties") or []:
        fname = str(f.get("name") or "").strip()
        if not fname:
            continue
        ftype = f.get("type")
        fields.append({
            "name": fname,
            "type": ftype if ftype in ("string", "number", "boolean", "string[]")
                    else "string",
            "required": False,
            "description": "",
        })
    return {
        "id": sanitize_tool_name(server_id, raw_name),
        "name": raw_name[:64],
        "category": "mcp",
        "surface": "http",
        "description": description,
        # NO permissions: nothing about an MCP descriptor may widen policy.
        "permissions": [],
        "risk": MCP_RISK_FLOOR,
        "irreversible": True,
        "input": fields,
        "output": "Tool-reported result, fenced as untrusted.",
        "verify": None,
        "_mcp": {"serverId": str(server_id), "toolName": raw_name},
    }


def register_mcp_capabilities(fabric, server_id: str, tools: list[dict],
                              call_tool) -> dict:
    """Register sanitized MCP tools as Fabric capabilities.

    call_tool(server_id, tool_name, arguments) -> dict must itself be the
    only side-effecting hop, and it is reachable exclusively through the
    registered executor (i.e. through CapabilityFabric.invoke).

    Returns {registered: [ids], refused: [{id, reason}]} — collisions with
    existing capabilities or duplicate MCP ids are REFUSED, never merged.
    """
    from . import _BY_ID, MANIFEST

    registered: list[str] = []
    refused: list[dict] = []
    seen_mcp: set[str] = set()

    for tool in tools or []:
        try:
            descriptor = sanitize_mcp_tool(server_id, tool)
        except ValueError as exc:
            refused.append({"id": str(tool.get("name")), "reason": str(exc)})
            continue
        cid = descriptor["id"]
        if cid in seen_mcp:
            refused.append({"id": cid, "reason": "duplicate mcp tool id"})
            continue
        if cid in _BY_ID:
            refused.append({"id": cid,
                            "reason": "collides with an existing capability"})
            continue
        seen_mcp.add(cid)
        MANIFEST.append(descriptor)
        _BY_ID[cid] = descriptor
        fabric.register(McpExecutor(descriptor, call_tool))
        registered.append(cid)

    return {"registered": registered, "refused": refused}


def unregister_mcp_server(fabric, server_id: str) -> list[str]:
    """Remove every capability of one MCP server (revocation must win)."""
    from . import _BY_ID, MANIFEST

    prefix = f"mcp.{_ID_OK.sub('-', str(server_id).strip().lower())}."
    removed: list[str] = []
    for cid in [c["id"] for c in MANIFEST if c.get("id", "").startswith(prefix)]:
        MANIFEST[:] = [c for c in MANIFEST if c.get("id") != cid]
        _BY_ID.pop(cid, None)
        fabric.executors.pop(cid, None)
        removed.append(cid)
    return removed


class McpExecutor:
    """The Fabric Executor for one MCP capability."""

    def __init__(self, descriptor: dict, call_tool) -> None:
        self.capabilityId = descriptor["id"]
        self._descriptor = descriptor
        self._call = call_tool

    async def run(self, invocation: dict) -> dict:
        meta = self._descriptor["_mcp"]
        try:
            raw = await self._call(meta["serverId"], meta["toolName"],
                                   invocation.get("input") or {})
        except Exception as exc:  # transport/honest failure
            return {"ok": False, "detail": f"mcp tool failed: {exc}",
                    "output": None}
        text = raw.get("text") if isinstance(raw, dict) else str(raw)
        text = "" if text is None else str(text)
        # Fenced untrusted data: visible marker + provenance flag.
        return {
            "ok": bool((raw or {}).get("ok", True)) if isinstance(raw, dict) else True,
            "detail": f'mcp tool "{meta["toolName"]}" returned (untrusted)',
            "output": {
                "text": text,
                "untrusted": True,
                "provenance": f'mcp:{meta["serverId"]}:{meta["toolName"]}',
            },
        }

    async def verify(self, invocation: dict, result: dict) -> dict:
        # No mechanical check exists for an external tool's claim; success
        # is reported from the executor alone (audit-only semantics).
        return {"passed": None, "kind": None,
                "detail": "No mechanical check exists for an MCP tool result."}
