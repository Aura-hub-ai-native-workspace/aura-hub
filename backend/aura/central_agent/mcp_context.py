"""MCP resources & prompts ingestion — the CONTEXT half of MCP.

Agent 1's completion gate (6308a1f) delivered governed TOOL invocation
(fabric.mcp_bridge + central_agent.mcp_gateway/transport) and explicitly
did NOT claim resources/prompts. This module owns that context half for
the Central Agent:

  * reads resources/prompts over the SAME StdioMcpClient transport;
  * treats every payload as UNTRUSTED DATA (fenced, provenance-marked,
  never parsed for authority);
  * freshness: discovery lists always refresh; payload reads go through a
    TTL cache whose clock is injectable; removal beats TTL (a snapshot of
    something the server no longer exposes must not look like truth);
    stale reuse is served ONLY with a visible marker.
"""
from __future__ import annotations

import time
from typing import Callable

from .context import ContextItem
from .mcp_transport import McpTransportError, StdioMcpClient

MAX_RESOURCE_CHARS = 24_000
MAX_ITEMS_PER_SERVER = 3
STALE_MARKER = " [STALE SNAPSHOT — older than the freshness window]"


class McpContextCache:
    """TTL cache with injectable clock. No timers, no background tasks:
    freshness advances only when a caller asks."""

    def __init__(self, ttl_s: float = 300.0,
                 now: Callable[[], float] | None = None) -> None:
        self.ttl_s = ttl_s
        self._now = now or time.monotonic
        self._entries: dict[str, tuple[float, str]] = {}

    def get(self, key: str) -> tuple[str, bool] | None:
        hit = self._entries.get(key)
        if hit is None:
            return None
        stored_at, text = hit
        return text, (self._now() - stored_at) > self.ttl_s

    def put(self, key: str, text: str) -> None:
        self._entries[key] = (self._now(), text)

    def drop_except(self, live_keys: set[str]) -> set[str]:
        gone = set(self._entries) - live_keys
        for k in gone:
            del self._entries[k]
        return gone


def _fence(text: str) -> str:
    return "```\n" + text.replace("```", "'''")[:MAX_RESOURCE_CHARS] + "\n```"


def collect_mcp_context_items(
    clients: dict[str, StdioMcpClient],
    cache: McpContextCache | None = None,
) -> list[ContextItem]:
    """Bounded, untrusted ContextItems from every reachable server."""
    out: list[ContextItem] = []
    for server_id, client in sorted(clients.items()):
        try:
            resources = client.list_resources()
        except McpTransportError as exc:
            out.append(ContextItem(
                kind="mcp.error",
                text=f"[mcp {server_id} unavailable for resources: {exc}]"[:300],
                provenance="external", untrusted=True))
            continue

        live_keys: set[str] = set()
        for res in resources[:MAX_ITEMS_PER_SERVER]:
            uri = str(res.get("uri") or "")
            if not uri:
                continue
            key = f"res:{server_id}:{uri}"
            live_keys.add(key)
            desc = str(res.get("description") or "")[:200]
            body: str | None = None
            stale = ""
            if cache is not None:
                cached = cache.get(key)
                if cached is not None:
                    body, is_stale = cached
                    if is_stale:
                        stale = STALE_MARKER
            if body is None:
                try:
                    body = client.read_resource(uri)[:MAX_RESOURCE_CHARS]
                    if cache is not None:
                        cache.put(key, body)
                except McpTransportError as exc:
                    body = f"[read failed: {exc}]"[:300]
            out.append(ContextItem(
                kind="mcp.resource",
                text=f"{server_id} {desc}\n{uri}{stale}\n{_fence(body)}",
                provenance="external", untrusted=True))
        if cache is not None:
            cache.drop_except(live_keys)

        try:
            for prompt in client.list_prompts()[:2]:
                name = str(prompt.get("name") or "")
                if not name:
                    continue
                try:
                    body = client.get_prompt(name)[:MAX_RESOURCE_CHARS]
                except McpTransportError as exc:
                    body = f"[prompt read failed: {exc}]"[:300]
                out.append(ContextItem(
                    kind="mcp.prompt",
                    text=f"{server_id} prompt {name}\n{_fence(body)}",
                    provenance="external", untrusted=True))
        except McpTransportError as exc:
            out.append(ContextItem(
                kind="mcp.error",
                text=f"[mcp {server_id} prompts unavailable: {exc}]"[:300],
                provenance="external", untrusted=True))
    return out
