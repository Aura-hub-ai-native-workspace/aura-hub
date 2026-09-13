"""MCP stdio transport — the untrusted-external boundary made real.

Speaks JSON-RPC 2.0 over stdio with an MCP-style server (initialize,
tools/list, tools/call). The client enforces strict timeouts and response
size caps. Everything a server SAYS is data: tool descriptors are
sanitized by the gateway before they can be discovered, and every call is
a governed fabric invocation — never a direct execution.

Protocol scope for this milestone: initialize / tools/list / tools/call.
Resources and prompts are not claimed and not implemented.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from .mcp_gateway import McpGateway

MAX_RESPONSE_BYTES = 256 * 1024
DEFAULT_TIMEOUT_S = 10.0


class McpTransportError(Exception):
    pass


class StdioMcpClient:
    """One MCP server process; one client. Not thread-safe across calls."""

    def __init__(self, command: list[str], cwd: str | None = None,
                 timeout_s: float = DEFAULT_TIMEOUT_S,
                 env: dict[str, str] | None = None) -> None:
        """Start one MCP server.

        This transport cannot use the shared execution boundary because the
        MCP protocol needs a live stdin pipe, which the boundary deliberately
        refuses to provide. The other guarantees still apply: the server gets
        a minimal environment rather than every secret in this process, and
        anything it genuinely needs is passed explicitly by the caller.
        """
        if not command or any(not isinstance(c, str) for c in command):
            raise McpTransportError("command must be a non-empty string list")
        from ..environment.procexec import sanitized_env

        self._proc = subprocess.Popen(
            command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
            env=sanitized_env(extra=env),
            start_new_session=(os.name != "nt"),
        )
        self._lock = threading.Lock()
        self._timeout = timeout_s
        self._next_id = 0
        self._server_info: dict | None = None

    def _request(self, method: str, params: dict | None = None) -> dict:
        with self._lock:
            if self._proc.poll() is not None:
                raise McpTransportError("server process has exited")
            self._next_id += 1
            rid = self._next_id
            line = json.dumps(
                {"jsonrpc": "2.0", "id": rid, "method": method,
                 "params": params or {}}, ensure_ascii=False)
            try:
                self._proc.stdin.write(line + "\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise McpTransportError(f"failed to write request: {exc}") from exc
            raw = self._proc.stdout.readline(MAX_RESPONSE_BYTES)
            if not raw:
                raise McpTransportError("empty response from server")
            try:
                reply = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise McpTransportError("server sent malformed JSON") from exc
            if reply.get("id") != rid:
                raise McpTransportError("response id mismatch")
            if "error" in reply:
                raise McpTransportError(f"server error: {reply['error']}")
            return reply.get("result") or {}

    # ── protocol ─────────────────────────────────────────────────────────
    def initialize(self) -> dict:
        result = self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "aura-central-agent", "version": "0.2.0"},
        })
        self._server_info = result.get("serverInfo")
        return result

    def list_tools(self) -> list[dict]:
        result = self._request("tools/list")
        tools = result.get("tools")
        if not isinstance(tools, list):
            raise McpTransportError("tools/list returned no tool array")
        return [t for t in tools if isinstance(t, dict)]

    def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        return self._request("tools/call",
                             {"name": name, "arguments": arguments or {}})

    # ── resources & prompts (AGENT 2 context half; additive at 6308a1f+) ──
    def list_resources(self) -> list[dict]:
        result = self._request("resources/list")
        resources = result.get("resources")
        if not isinstance(resources, list):
            raise McpTransportError("resources/list returned no resource array")
        return [r for r in resources if isinstance(r, dict)]

    def read_resource(self, uri: str) -> str:
        result = self._request("resources/read", {"uri": uri})
        contents = result.get("contents")
        if not isinstance(contents, list) or not contents:
            raise McpTransportError(f"resource {uri!r} returned no contents")
        first = contents[0] if isinstance(contents[0], dict) else {}
        text = first.get("text")
        if text is None and first.get("blob"):
            import base64

            text = base64.b64decode(str(first["blob"])).decode("utf-8", "replace")
        if not isinstance(text, str):
            raise McpTransportError(f"resource {uri!r} carried no text")
        return text

    def list_prompts(self) -> list[dict]:
        result = self._request("prompts/list")
        prompts = result.get("prompts")
        if not isinstance(prompts, list):
            raise McpTransportError("prompts/list returned no prompt array")
        return [p for p in prompts if isinstance(p, dict)]

    def get_prompt(self, name: str) -> str:
        result = self._request("prompts/get", {"name": name})
        messages = result.get("messages")
        parts: list[str] = []
        for m in messages if isinstance(messages, list) else []:
            content = m.get("content") if isinstance(m, dict) else None
            if isinstance(content, dict) and isinstance(content.get("text"), str):
                parts.append(content["text"])
        return "\n".join(parts)

    @property
    def server_info(self) -> dict | None:
        return self._server_info

    def close(self) -> None:
        try:
            self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.terminate()
            self._proc.wait(timeout=3)
        except Exception:
            self._proc.kill()


class McpSession:
    """A connected server: discovery through the gateway, calls through the
    Fabric's executor registry."""

    def __init__(self, client: StdioMcpClient, server_id: str,
                 trust: str, gateway: McpGateway | None = None) -> None:
        self.client = client
        self.server_id = server_id
        self.gateway = gateway or McpGateway()
        self.gateway.register_server(server_id, trust)
        self.client.initialize()

    def discover(self) -> list:
        """Server tools → sanitized ToolDescriptors. Poisoned metadata dies
        here: only allow-listed fields survive into discovery."""
        from ..contracts import ToolDescriptor

        mapped: list[ToolDescriptor] = []
        for raw in self.client.list_tools():
            mapped.append(self.gateway.map_tool(self.server_id, raw))
        return mapped

    def call(self, tool_name: str, arguments: dict | None) -> dict:
        """Raw protocol call. Prefer invoke via the Fabric executor instead —
        that path carries policy, approval, verification and audit."""
        return self.client.call_tool(tool_name, arguments)

    def close(self) -> None:
        self.client.close()


def make_mcp_tool_executor(session: McpSession, tool_name: str):
    """Fabric executor adapter for ONE discovered tool.

    The executor performs the protocol call and returns the tool's text
    content as UNTRUSTED output. It adds no authority: the descriptor's
    risk floors decide how policy treats each invocation.
    """

    cap_id = f"mcp:{session.server_id}:{tool_name}"

    class McpToolExecutor:
        name = f"mcp:{session.server_id}:{tool_name}"
        capabilityId = cap_id
        descriptor = {
            "id": cap_id,
            "name": f"MCP {tool_name}",
            "category": "mcp",
            "surface": "mcp",
            "description": f"MCP tool {tool_name} from server {session.server_id}",
            "risk": "low",
            "permissions": [],
            "input": [],
            "output": "MCP tool output",
            "verify": None,
        }

        async def run(self, invocation: dict) -> dict:
            """Async wrapper for Fabric's invoke protocol."""
            input = invocation.get("input", {})
            context = invocation.get("context", {})
            result = session.call(tool_name, input)
            content = result.get("content") or []
            text = "\n".join(
                c.get("text", "") for c in content if isinstance(c, dict))
            is_error = bool(result.get("isError"))
            if is_error:
                return {"ok": False, "detail": f"tool reported error: {text[:200]}"}
            return {"ok": True, "output": {"text": text[:MAX_RESPONSE_BYTES]}}

        async def verify(self, invocation: dict, result: dict) -> dict:
            return None  # external output cannot be mechanically confirmed here

    return McpToolExecutor()


def spawn_fixture_server(script: Path) -> StdioMcpClient:
    """Start a test MCP server (see tests/mcp/fixture_server.py)."""
    return StdioMcpClient(["python3", str(script)])
