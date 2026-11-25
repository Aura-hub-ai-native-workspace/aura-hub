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
import json
import re
from typing import Callable
from pathlib import Path

from .context import ContextItem
from .mcp_transport import McpTransportError, StdioMcpClient

MAX_RESOURCE_CHARS = 24_000
MAX_ITEMS_PER_SERVER = 3
STALE_MARKER = " [STALE SNAPSHOT — older than the freshness window]"
CONTEXT_SERVERS_FILE = "mcp-context-servers.json"
_SERVER_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")


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

    def drop_except(self, live_keys: set[str], prefix: str | None = None) -> set[str]:
        gone = {key for key in self._entries
                if (prefix is None or key.startswith(prefix)) and key not in live_keys}
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
            cache.drop_except(live_keys, prefix=f"res:{server_id}:")

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


def load_context_server_specs(home: str | Path | None = None) -> dict[str, dict]:
    """Read the user's explicit, owner-managed MCP context configuration.

    This is a list of stdio servers that expose MCP resources/prompts to
    CentralAgent. It does not infer or import every coding-agent MCP config,
    which could start unrelated tools or leak their credentials.
    """
    if home is None:
        from ..config import aura_home

        home = aura_home()
    path = Path(home) / "agent" / CONTEXT_SERVERS_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {path.name}: {type(exc).__name__}") from exc
    if not isinstance(raw, dict) or "servers" not in raw or not isinstance(raw.get("servers"), dict):
        raise ValueError("MCP context config must contain a servers object")
    servers = raw.get("servers", {})
    if len(servers) > 8:
        raise ValueError("MCP context config supports at most 8 servers")
    specs: dict[str, dict] = {}
    for server_id, spec in servers.items():
        if not isinstance(server_id, str) or not _SERVER_ID.fullmatch(server_id):
            raise ValueError("MCP context server id is invalid")
        if not isinstance(spec, dict):
            raise ValueError(f"MCP context server {server_id} must be an object")
        command = spec.get("command")
        if (not isinstance(command, list) or not command
                or len(command) > 32
                or any(not isinstance(part, str) or not part or "\x00" in part
                       for part in command)):
            raise ValueError(f"MCP context server {server_id} command must be a non-empty argument array")
        cwd = spec.get("cwd")
        env = spec.get("env", {})
        timeout_s = spec.get("timeoutSeconds", 10)
        if cwd is not None and (not isinstance(cwd, str) or "\x00" in cwd):
            raise ValueError(f"MCP context server {server_id} cwd is invalid")
        if (not isinstance(env, dict) or len(env) > 32
                or any(not isinstance(k, str) or not isinstance(v, str)
                       or "\x00" in k or "\x00" in v for k, v in env.items())):
            raise ValueError(f"MCP context server {server_id} env is invalid")
        if (isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float))
                or not 0.1 <= timeout_s <= 30):
            raise ValueError(f"MCP context server {server_id} timeoutSeconds must be 0.1–30")
        specs[server_id] = {"command": command, "cwd": cwd,
                            "env": env, "timeoutSeconds": float(timeout_s)}
    return specs


class ConfiguredMcpContextProvider:
    """Own configured stdio context servers for one API application lifecycle."""

    def __init__(self, specs: dict[str, dict], client_factory=None,
                 startup_error: str | None = None) -> None:
        self._specs = specs
        self._factory = client_factory or StdioMcpClient
        self._clients: dict[str, StdioMcpClient] = {}
        self._errors: dict[str, str] = {}
        if startup_error:
            self._errors["configuration"] = startup_error[:120]
        self._started = False
        self._cache = McpContextCache()

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        for server_id, spec in sorted(self._specs.items()):
            client = None
            try:
                client = self._factory(
                    spec["command"], cwd=spec.get("cwd"),
                    timeout_s=spec["timeoutSeconds"], env=spec.get("env"))
                client.initialize()
                self._clients[server_id] = client
            except Exception as exc:  # optional context servers never gate app startup
                if client is not None:
                    try:
                        client.close()
                    except Exception:
                        pass
                self._errors[server_id] = type(exc).__name__

    def __call__(self) -> list[ContextItem]:
        if not self._started:
            self.start()
        items = collect_mcp_context_items(self._clients, self._cache)
        items.extend(ContextItem(
            kind="mcp.error",
            text=f"[mcp {server_id} unavailable during startup: {reason}]",
            provenance="external", untrusted=True)
            for server_id, reason in sorted(self._errors.items()))
        return items

    def close(self) -> None:
        for client in list(self._clients.values()):
            try:
                client.close()
            except Exception:
                pass
        self._clients.clear()


def configured_context_provider(home: str | Path | None = None):
    """Build the optional provider from the user's AURA agent configuration."""
    try:
        specs = load_context_server_specs(home)
    except ValueError as exc:
        return ConfiguredMcpContextProvider({}, startup_error=str(exc))
    return ConfiguredMcpContextProvider(specs) if specs else None
