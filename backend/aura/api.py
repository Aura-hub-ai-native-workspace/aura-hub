"""Central Agent API — the Python backend surface for the frontend.

stdlib HTTP (no framework dependency). Every route is documented in
docs/AURA_CENTRAL_AGENT_API.md. Design rules:

- The agent API NEVER duplicates governance routes: approvals are decided
  through the SAME ledger the Fabric uses; this server only exposes it.
- SSE streams carry AgentEvent payloads from the real execution path.
  Live events are observability, never evidence — durable audit stays
  authoritative and every session reloads from persisted state.
- Errors are exactly {"error": string} with a status (wire-contracts §1).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .audit import AuditStore
from .approvals import ApprovalLedger
from .central_agent import CentralAgent, AgentSessionStore
from .errors import AuraError, NotFound
from .jsonutil import dumps_compact

MAX_BODY_BYTES = 1 * 1024 * 1024


@dataclass
class ApiDeps:
    agent: CentralAgent
    sessions: AgentSessionStore
    ledger: ApprovalLedger
    audit: AuditStore
    lock: threading.Lock = field(default_factory=threading.Lock)


class AgentApiServer:
    """Threading HTTP server exposing the central agent."""

    def __init__(self, deps: ApiDeps, host: str = "127.0.0.1", port: int = 4320) -> None:
        self.deps = deps
        self._server = ThreadingHTTPServer((host, port), self._handler())
        self._subscribers: list[tuple[Any, threading.Event]] = []

    def serve_forever(self) -> None:
        self._server.serve_forever()

    def start_background(self) -> threading.Thread:
        t = threading.Thread(target=self.serve_forever, daemon=True)
        t.start()
        return t

    def shutdown(self) -> None:
        self._server.shutdown()

    # ── routing ──────────────────────────────────────────────────────────
    def _handler(self):
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: N802 — silence default noise
                pass

            def _send(self, status: int, payload: Any, content_type="application/json") -> None:
                body = dumps_compact(payload).encode("utf-8") \
                    if not isinstance(payload, bytes) else payload
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(body)))
                self.send_header("access-control-allow-origin", "*")
                self.end_headers()
                self.wfile.write(body)

            def _body(self) -> dict:
                length = int(self.headers.get("content-length") or 0)
                if length > MAX_BODY_BYTES:
                    raise AuraError("request body too large", status=413)
                raw = self.rfile.read(length) if length else b"{}"
                parsed = json.loads(raw or b"{}")
                if not isinstance(parsed, dict):
                    raise AuraError("body must be a JSON object")
                return parsed

            def _dispatch(self, method: str) -> None:
                url = urlparse(self.path)
                seg = [s for s in url.path.split("/") if s]
                try:
                    out = api.route(method, seg, parse_qs(url.query),
                                lambda: self._body())
                    if isinstance(out, tuple) and out and out[0] == "SSE":
                        self._sse(out[1])
                        return
                    self._send(200, out)
                except NotFound as exc:
                    self._send(404, {"error": exc.message})
                except AuraError as exc:
                    self._send(exc.status, {"error": exc.message})
                except Exception as exc:  # noqa: BLE001 — honest wire error
                    self._send(500, {"error": f"internal: {exc}"})

            def do_GET(self):  # noqa: N802
                self._dispatch("GET")

            def do_POST(self):  # noqa: N802
                self._dispatch("POST")

            def _sse(self, generator) -> None:
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("access-control-allow-origin", "*")
                self.end_headers()
                try:
                    for chunk in generator():
                        if not chunk:
                            break
                        self.wfile.write(f"data: {chunk}\n\n".encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        return Handler

    # ── routes ───────────────────────────────────────────────────────────
    def route(self, method: str, seg: list[str], query: dict,
              read_body) -> Any:
        d = self.deps
        # GET /health
        if seg[:1] == ["health"] and method == "GET":
            return {"ok": True, "service": "aura-central-agent"}

        if seg[:2] == ["agent", "sessions"]:
            rest = seg[2:]
            # POST /agent/sessions — submit an intent (creates the session)
            if not rest and method == "POST":
                body = read_body()
                message = str(body.get("message") or "").strip()
                if not message:
                    raise AuraError("message is required")
                project_id = body.get("projectId") or None
                with d.lock:
                    result = d.agent.submit(message, project_id=project_id)
                return {"result": result.model_dump(),
                        "sessionId": d.sessions.last_session_id}

            sid = rest[0] if rest else ""
            sub = rest[1] if len(rest) > 1 else ""

            if method == "GET" and not sub:
                session = d.sessions.load(sid)
                if session is None:
                    raise NotFound("no such session")
                return session.model_dump()

            if sub == "events" and method == "GET":
                return ("SSE", lambda: d.agent.bus.subscribe_stream(sid))

            if sub == "resume" and method == "POST":
                with d.lock:
                    result = d.agent.resume(sid)
                return {"result": result.model_dump()}

            if sub == "cancel" and method == "POST":
                return {"cancelled": d.agent.cancel(sid)}

            if sub == "evidence" and method == "GET":
                session = d.sessions.load(sid)
                if session is None:
                    raise NotFound("no such session")
                return (session.lastResult.evidence.model_dump()
                        if session.lastResult and session.lastResult.evidence
                        else {"evidence": None})

        if seg[:2] == ["fabric", "approvals"]:
            # The approval authority is the ledger itself. This is a thin,
            # faithful surface over it — no second decision path.
            if method == "GET" and len(seg) == 2:
                return {"approvals": d.ledger.pending()}
            if method == "POST" and len(seg) == 4 and seg[3] == "decide":
                body = read_body()
                decided = d.ledger.decide(
                    seg[2], bool(body.get("granted")), "user",
                    body.get("reason"))
                if decided is None:
                    raise AuraError("this request was already decided", status=409)
                return {"approval": decided}

        if seg[:2] == ["workflow-runs"] and method == "GET" and len(seg) == 3:
            run = d.agent.run_store.find(seg[2])
            if run is None:
                raise NotFound("no such run")
            return run

        if seg[:1] == ["workflows"] and method == "GET" and len(seg) == 1:
            return {"workflows": d.agent.workflow_store.list()}

        raise NotFound("not found")


def build_default_api(home=None, host: str = "127.0.0.1",
                      port: int = 4320) -> tuple[AgentApiServer, CentralAgent]:
    """Wire the API to freshly constructed canonical stores."""
    import os

    if home is not None:
        os.environ["AURA_HOME"] = str(home)
    from .config import aura_home
    from .workflow import make_stores

    H = aura_home()
    H.mkdir(parents=True, exist_ok=True)
    audit = AuditStore(H / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    from .central_agent import EventBus, IntentCompiler
    from .workflow import WorkflowEngine
    from .fabric_wiring import default_fabric_config
    cfg = default_fabric_config(audit, ledger)
    sessions = AgentSessionStore(H)
    ws, vs, rs = make_stores()
    bus = EventBus()
    agent = CentralAgent(fabric_cfg=cfg, session_store=sessions, bus=bus,
                         intent_compiler=IntentCompiler(mode="heuristic"),
                         workflow_store=ws, run_store=rs,
                         workflow_engine=WorkflowEngine(
                             cfg, ws, vs, rs,
                             config=_engine_config_for(bus)))
    server = AgentApiServer(ApiDeps(agent=agent, sessions=sessions,
                                    ledger=ledger, audit=audit),
                            host=host, port=port)
    return server, agent


def _engine_config_for(bus):
    import datetime as _dt

    from .contracts import AgentEvent
    from .workflow import EngineConfig

    def now() -> str:
        return _dt.datetime.now(_dt.timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z")

    def forward(event: dict) -> None:
        bus.emit(AgentEvent(type="invocation.observed", at=now(),
                            sessionId="-", payload={"engine": event}))

    return EngineConfig(emit=forward)
