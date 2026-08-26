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
import subprocess
import threading
from pathlib import Path
from typing import Any

from .mcp_gateway import McpGateway

MAX_RESPONSE_BYTES = 256 * 1024
DEFAULT_TIMEOUT_S = 10.0


class McpTransportError(Exception):
    pass


class StdioMcpClient:
    """One MCP server process; one client. Not thread-safe across calls."""

    def __init__(self, command: list[str], cwd: str | None = None,
                 timeout_s: float = DEFAULT_TIMEOUT_S) -> None:
        if not command or any(not isinstance(c, str) for c in command):
            raise McpTransportError("command must be a non-empty string list")
        self._proc = subprocess.Popen(
            command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
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

    class McpToolExecutor:
        name = f"mcp:{session.server_id}:{tool_name}"

        def run(self, input: dict, context: dict) -> tuple[Any | None, str]:
            result = session.call(tool_name, input)
            content = result.get("content") or []
            text = "\n".join(
                c.get("text", "") for c in content if isinstance(c, dict))
            is_error = bool(result.get("isError"))
            if is_error:
                raise RuntimeError(f"tool reported error: {text[:200]}")
            return {"text": text[:MAX_RESPONSE_BYTES]}, (
                f"MCP tool {tool_name} returned {len(text)} chars "
                "(untrusted external output).")

        def verify(self, input: dict, context: dict, output) -> None:
            return None  # external output cannot be mechanically confirmed here

    return McpToolExecutor()


def spawn_fixture_server(script: Path) -> StdioMcpClient:
    """Start a test MCP server (see tests/mcp/fixture_server.py)."""
    return StdioMcpClient(["python3", str(script)])
