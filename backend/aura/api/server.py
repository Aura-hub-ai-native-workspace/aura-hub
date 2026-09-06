"""Canonical Python HTTP/SSE server — Starlette.

The SOLE production backend surface. HTTP is a thin transport adapter over
the canonical domain services; no handler decides, executes or stores
anything itself:

  workflow runs  → WorkflowRunner (THE path)
  agent sessions → aura.central_agent.CentralAgent on the same runner
  approvals      → THE ApprovalLedger the Fabric spends (single-use)
  fabric invoke  → CapabilityFabric.invoke (policy→approval→audit)
  automation     → AutomationEngine → WorkflowService(runner facade)

SSE streams use text/event-stream frames with a [DONE] sentinel; the
workflow event bus keeps a replayable tail per run for Last-Event-ID.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from ..config import aura_home
from ..fabric import CapabilityFabric, describe_capability
from ..jsonutil import dumps_compact, read_json_file, write_json_atomic
from ..persistence.automation import AutomationStore
from ..persistence.runs import WorkflowRunStore, summarize_run
from ..persistence.versions import WorkflowVersionStore
from ..persistence.workflows import WorkflowStore
from ..secrets import SecretStore as AuraSecrets
from ..workflow.runner import WorkflowRunner

#: Every origin the desktop can legitimately call this backend from.
#:
#: One pattern, used as the CORS middleware's `allow_origin_regex`, because
#: two lists drift: the middleware used to carry its own shorter copy that
#: omitted ``http://tauri.localhost`` — the origin a Tauri v2 window has on
#: WINDOWS — so every request the desktop made there failed preflight while
#: Linux and macOS (``tauri://localhost``) worked.
#:
#: Loopback keeps an optional port for the Vite dev server (:1420) and for
#: `npm run preview`; the tauri origins have none.
ALLOWED_ORIGIN = (
    r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?"
    r"|tauri://localhost"
    r"|https?://tauri\.localhost)$"
)

MSGS = {
    "awaiting-approval": "waiting on your authorization",
    "denied": "policy refused a tool call",
}


def _err(msg: str, status: int = 400):
    return JSONResponse({"error": msg}, status_code=status)


# ── production host ──────────────────────────────────────────────────────────


from ..fabric.host import WiringHost
from ..persistence.nodes import ConnectedNodeStore


def _default_host(nodes: ConnectedNodeStore) -> WiringHost:
    """Frozen wiring-mode host: routing + availability + grants all read the
    ONE connected-node registry, so authority and execution agree."""
    return WiringHost(nodes)


# ── the workflow event bus (replayable SSE tail) ─────────────────────────────


_BUS_REGISTRY: dict[str, "WorkflowEventBus"] = {}


def _bus_for_home(home) -> "WorkflowEventBus":
    """ONE event bus per AURA_HOME (in-process): every app instance over the
    same home shares it, so sequence stays monotonic and no second writer
    can interleave into the journal."""
    key = str(home)
    if key not in _BUS_REGISTRY:
        _BUS_REGISTRY[key] = WorkflowEventBus(Path(home) / "events" / "workflow.jsonl")
    return _BUS_REGISTRY[key]


class WorkflowEventBus:
    """Ring buffer + RESTART-SAFE journal of run events.

    ADDITIVE Python behavior (no TypeScript oracle exists for SSE replay):
      • every frame gets a monotonically increasing seq that SURVIVES
        restarts via an append-only JSONL journal under AURA_HOME;
      • Last-Event-ID / since cursors replay STRICTLY-AFTER entries;
      • live subscribers receive each frame exactly once.
    Frames remain observability — durable run records stay authoritative.
    """

    MAX_TAIL = 2000

    def __init__(self, journal_path=None) -> None:
        self._tail: list[dict] = []
        self._subs: list[asyncio.Queue] = []
        self._journal = journal_path
        self._seq = 0
        if journal_path is not None and journal_path.exists():
            try:
                for line in journal_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # a torn final write never breaks replay
                    if isinstance(entry, dict) and isinstance(entry.get("seq"), int):
                        self._tail.append(entry)
                        self._seq = max(self._seq, entry["seq"])
                del self._tail[:-self.MAX_TAIL]
            except OSError:
                pass

    def publish(self, frame: dict) -> None:
        self._seq += 1
        entry = {"seq": self._seq, **frame}
        self._tail.append(entry)
        del self._tail[:-self.MAX_TAIL]
        if self._journal is not None:
            try:
                self._journal.parent.mkdir(parents=True, exist_ok=True)
                with open(self._journal, "a", encoding="utf-8") as fh:
                    fh.write(dumps_compact(entry) + "\n")
            except OSError:
                pass  # observability must never break execution
        for q in list(self._subs):
            q.put_nowait(entry)

    def after(self, last_event_id: int) -> list[dict]:
        return [e for e in self._tail if e["seq"] > last_event_id]

    @property
    def last_seq(self) -> int:
        return self._seq

    def subscribe(self, last_event_id: int = 0) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for entry in self.after(last_event_id):
            q.put_nowait(entry)
        self._subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subs:
            self._subs.remove(q)


# ── wiring ───────────────────────────────────────────────────────────────────


def _wire(*, fabric=None, run_scopes=None, secrets_store=None) -> dict:
    """Construct the canonical service graph once. Callers may inject a
    scripted fabric/scopes/secrets (tests); production wiring builds the
    real ones."""
    H = aura_home()
    H.mkdir(parents=True, exist_ok=True)

    from ..approvals import ApprovalLedger
    from ..audit import AuditStore

    audit = AuditStore(H / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    ap_file = H / "fabric-approvals.json"

    def _ap_load():
        raw = read_json_file(ap_file, [])
        from ..approvals import usable_pending
        return [r for r in raw if usable_pending(r)]

    def _ap_save(reqs):
        write_json_atomic(ap_file, reqs)

    # Ledger shares the SAME file-backed store → one canonical ledger.
    ledger.attach_store(_ap_load, _ap_save)

    if secrets_store is None:
        secrets_store = AuraSecrets()

    from ..persistence.projects import ProjectRegistry

    nodes = (ConnectedNodeStore() if fabric is None
             else getattr(getattr(fabric, "host", None), "_nodes", None))
    if nodes is None:
        nodes = ConnectedNodeStore()
    registry = ProjectRegistry()

    if fabric is None:
        fabric = CapabilityFabric(_default_host(nodes))
        from ..executors import all_executors, register_canonical_internal_capabilities

        for executor in all_executors(registry):
            fabric.register(executor)
        register_canonical_internal_capabilities(fabric)
        from ..policy import DEFAULT_POLICY

        fabric.policy = read_json_file(H / "fabric-policy.json", DEFAULT_POLICY)
    if hasattr(fabric, "attach_approval_store"):
        fabric.attach_approval_store(_ap_load, _ap_save)
        fabric.attach_audit_store(audit.load, audit.append)
        # The ONE ledger instance backs both the fabric's gates and HTTP.
        fabric._ledger = ledger

    wf_store = WorkflowStore()
    ver_store = WorkflowVersionStore()
    run_store = WorkflowRunStore()
    auto_store = AutomationStore()

    runner = WorkflowRunner(
        fabric=fabric, run_scopes=run_scopes or RunScopeRegistry(),
        versions=ver_store, runs=run_store,
        secrets=secrets_store,
    )
    runner.workflows = wf_store  # automation resolves ids via it

    # ── central agent on the same spine ─────────────────────────────
    from ..central_agent import (
        AgentSessionStore,
        CentralAgent,
        EventBus,
        IntentCompiler,
    )
    from ..fabric import FabricConfig
    from ..workflow import EngineConfig
    from ..workflow import WorkflowEngine as EngineFacade

    agent_bus = EventBus()
    agent_cfg = FabricConfig(fabric=fabric, audit_store=audit, ledger=ledger,
                             permissions={"read": True, "write": True},
                             executors={}, secrets=secrets_store)
    sessions = AgentSessionStore(H)
    engine = EngineFacade(
        agent_cfg, wf_store, ver_store, run_store,
        config=EngineConfig(emit=lambda event: agent_bus.emit(
            _agent_event("invocation.observed", "-", {"engine": event}))),
    )
    agent = CentralAgent(
        fabric_cfg=agent_cfg, session_store=sessions, bus=agent_bus,
        intent_compiler=IntentCompiler(mode="heuristic"),
        workflow_engine=engine, workflow_store=wf_store, run_store=run_store,
    )

    # ── automation engine + scheduler on the same runner ────────────
    from ..automation import AutomationEngine, make_workflow_action
    from ..automation.scheduler import AutomationScheduler

    auto_events: list[dict] = []          # ring for /automation/events/stream
    auto_subscribers: list[asyncio.Queue] = []

    def _auto_emit(frame: dict) -> None:
        entry = {"seq": len(auto_events) + 1, **frame}
        auto_events.append(entry)
        del auto_events[:-WorkflowEventBus.MAX_TAIL]
        for q in list(auto_subscribers):
            q.put_nowait(entry)

    actions = {"run-workflow": make_workflow_action(runner, None)}
    auto_engine = AutomationEngine(auto_store, actions, emit=_auto_emit)
    scheduler = AutomationScheduler(
        auto_store,
        {"load": (lambda: read_json_file(H / "automation-schedule-state.json", {})),
         "save": (lambda s: write_json_atomic(H / "automation-schedule-state.json", s))},
        lambda project_id: str(H), auto_engine)

    return {
        "home": H, "fabric": fabric, "ledger": ledger, "audit": audit,
        "registry": registry,
        "nodes": nodes,
        "wf_store": wf_store, "ver_store": ver_store, "run_store": run_store,
        "auto_store": auto_store, "runner": runner, "secrets": secrets_store,
        "agent": agent, "sessions": sessions, "agent_bus": agent_bus,
        "bus": _bus_for_home(H),
        "auto_engine": auto_engine,
        "scheduler": scheduler, "auto_emit": _auto_emit,
        "auto_events": auto_events, "auto_subs": auto_subscribers,
    }


class RunScopeRegistry:
    def register(self, *_a, **_k):
        pass

    def remove(self, *_a, **_k):
        pass


def _agent_event(etype: str, session_id: str, payload: dict) -> dict:
    from datetime import UTC, datetime

    from ..contracts import AgentEvent

    return AgentEvent(type=etype, at=datetime.now(UTC).isoformat(
        timespec="milliseconds").replace("+00:00", "Z"),
        sessionId=session_id, payload=payload)


def create_api_server(*, fabric=None, run_scopes=None, secrets_store=None,
                      model=None) -> Starlette:
    S = _wire(fabric=fabric, run_scopes=run_scopes, secrets_store=secrets_store)
    if model is not None:
        # The provider seam for intelligence nodes and the agent runtime.
        S["runner"].model = model
    wf_store, ver_store, run_store = S["wf_store"], S["ver_store"], S["run_store"]
    runner, agent, sessions = S["runner"], S["agent"], S["sessions"]
    bus: WorkflowEventBus = S["bus"]

    def _sse(frames, done_sentinel=True):
        async def gen():
            try:
                for frame in frames:
                    yield f"data: {dumps_compact(frame)}\n\n"
                if done_sentinel:
                    yield "data: [DONE]\n\n"
            except asyncio.CancelledError:  # client disconnected
                pass
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache",
                                          "x-accel-buffering": "no"})

    # ── health ──────────────────────────────────────────────────────
    async def health(request: Request):
        return JSONResponse({
            "ok": True, "service": "aura-hub-backend",
            "health": {"status": "ok", "backend": "python"},
            "key": {"configured": bool(S["secrets"])},
            "index": {"status": "ready"},
            "project": None,
        })

    # ── workflows ───────────────────────────────────────────────────
    async def workflow_list(request: Request):
        return JSONResponse({"workflows": wf_store.list()})

    async def workflow_get(request: Request):
        wf = wf_store.get(request.path_params["wid"])
        if not wf:
            return _err(f'No workflow stored under "{request.path_params["wid"]}".', 404)
        return JSONResponse(wf)

    async def workflow_create(request: Request):
        body = await request.json()
        wf = wf_store.create(body)
        return JSONResponse(wf)

    async def workflow_save(request: Request):
        body = await request.json()
        result = wf_store.save(request.path_params["wid"], body)
        if not result:
            return _err("not found", 404)
        return JSONResponse(result)

    async def workflow_patch(request: Request):
        wid = request.path_params["wid"]
        existing = wf_store.get(wid)
        if not existing:
            return _err(f'No workflow stored under "{wid}".', 404)
        body = await request.json()
        merged = {**existing, **{k: v for k, v in body.items()
                                 if k in ("name", "favorite", "category", "description")}}
        result = wf_store.save(wid, merged)
        return JSONResponse(result or existing)

    async def workflow_delete(request: Request):
        wid = request.path_params["wid"]
        ok = wf_store.remove(wid)
        ver_store.remove_all(wid)
        run_store.remove_all(wid)
        return JSONResponse({"ok": ok})

    async def workflow_duplicate(request: Request):
        src = wf_store.get(request.path_params["wid"])
        if not src:
            return _err("not found", 404)
        copy = wf_store.create({**src, "id": None,
                                "name": f"{src.get('name', 'Workflow')} copy"})
        return JSONResponse(copy)

    async def workflow_import(request: Request):
        body = await request.json()
        definition = body.get("def") if isinstance(body, dict) else None
        if not isinstance(definition, dict):
            return _err("body must be {\"def\": <workflow>}")
        return JSONResponse(wf_store.create(definition))

    async def workflow_generate(request: Request):
        # Honest refusal: authoring needs a live model provider. No fake graph.
        return _err("Workflow generation requires a configured AI provider, "
                    "which is not available on this backend.", 501)

    # ── specs & templates (this backend's real registries) ──────────
    NODE_SPECS = [
        {"type": t, "label": label, "category": cat, "description": desc,
         "inputs": inputs, "outputs": outputs, "disabled": False, "fields": fields}
        for t, label, cat, desc, inputs, outputs, fields in [
            ("shell-command", "Shell Command", "Action", "Run a command in the project.",
             ["text"], ["text"], [{"name": "command", "label": "Command", "type": "text",
                                   "required": True, "placeholder": "npm test"}]),
            ("git-status", "Git Status", "Git", "Read the repository status.", [], ["text"], []),
            ("git-diff", "Git Diff", "Git", "Read the uncommitted diff.", [], ["text"], []),
            ("changed-files", "Changed Files", "Git", "List files changed since HEAD.", [], ["text"], []),
            ("export-file", "Export File", "Action", "Write a file into the project.",
             ["text"], [], [{"name": "path", "label": "Path", "type": "text", "required": True},
                            {"name": "contents", "label": "Contents", "type": "text", "required": True}]),
            ("http-request", "HTTP Request", "Network", "Perform an HTTP request.",
             ["text"], ["text"], [{"name": "url", "label": "URL", "type": "text", "required": True}]),
            ("user-input", "User Input", "Logic", "Collect a value when the run starts.",
             [], ["text"], [{"name": "prompt", "label": "Prompt", "type": "text"}]),
            ("condition", "Condition", "Logic", "Branch on the inbound text.",
             ["text"], ["text"], [{"name": "check", "label": "Check", "type": "select"},
                                  {"name": "value", "label": "Value", "type": "text"}]),
            ("variables", "Variables", "Logic", "Set KEY=value variables.", [], [],
             [{"name": "pairs", "label": "Pairs", "type": "textarea"}]),
            ("delay", "Delay", "Logic", "Wait before continuing.", [], [],
             [{"name": "ms", "label": "Milliseconds", "type": "number"}]),
            ("output", "Output", "IO", "Emit a titled result.", ["text"], [],
             [{"name": "title", "label": "Title", "type": "text"}]),
            ("agent", "Agent", "Intelligence", "A bounded agent that calls tools through the Fabric.",
             ["text"], ["text"], [{"name": "task", "label": "Task", "type": "textarea"},
                                  {"name": "tools", "label": "Tools", "type": "textarea"}]),
        ]
    ]

    WORKFLOW_TEMPLATES = [
        {"id": "project-health", "name": "Project Health Check",
         "description": "Checks git status and lists changed files, then reports both.",
         "category": "Review",
         "nodes": [
             {"id": "st", "type": "git-status", "x": 60, "y": 80, "config": {}},
             {"id": "cf", "type": "changed-files", "x": 60, "y": 260, "config": {}},
             {"id": "out", "type": "output", "x": 380, "y": 170,
              "config": {"title": "Repository status"}},
         ],
         "edges": [
             {"id": "e-st-out", "from": "st", "fromPort": "out", "to": "out"},
             {"id": "e-cf-out", "from": "cf", "fromPort": "out", "to": "out"},
         ]},
        {"id": "commit-snapshot", "name": "Commit Snapshot",
         "description": "Snapshots the working diff into a file inside the project.",
         "category": "Utility",
         "nodes": [
             {"id": "diff", "type": "git-diff", "x": 60, "y": 100, "config": {}},
             {"id": "save", "type": "export-file", "x": 360, "y": 100,
              "config": {"path": "aura-snapshot.diff"}},
             {"id": "out", "type": "output", "x": 660, "y": 100,
              "config": {"title": "Snapshot written"}},
         ],
         "edges": [
             {"id": "e-diff-save", "from": "diff", "fromPort": "out", "to": "save"},
             {"id": "e-save-out", "from": "save", "fromPort": "out", "to": "out"},
         ]},
    ]

    async def workflow_specs(request: Request):
        return JSONResponse({"specs": NODE_SPECS})

    async def workflow_templates(request: Request):
        return JSONResponse({"templates": WORKFLOW_TEMPLATES})

    # ── envelope / validate ─────────────────────────────────────────
    def _envelope_for(wf: dict) -> dict:
        from ..workflow.envelope import compute_editor_envelope

        return compute_editor_envelope(wf.get("nodes") or [])

    async def workflow_envelope(request: Request):
        from ..workflow.envelope import diff_envelopes

        wf = wf_store.get(request.path_params["wid"])
        if not wf:
            return _err("not found", 404)
        env = _envelope_for(wf)
        versions = ver_store.list(wf["id"])
        diff = None
        if versions:
            previous = versions[0].get("nodes") if isinstance(versions[0], dict) else None
            if previous is not None:
                from ..workflow.envelope import compute_editor_envelope as cee

                diff = diff_envelopes(cee(previous), env)
        return JSONResponse({"envelope": env, "diff": diff})

    def _validate(wf: dict) -> dict:
        from ..workflow.envelope import compute_editor_envelope

        findings: list[dict] = []
        nodes = wf.get("nodes") or []
        ids = [n.get("id") for n in nodes]
        for nid in ids:
            if ids.count(nid) > 1:
                findings.append({"level": "error", "nodeId": nid,
                                 "message": "duplicate node id"})
                break
        known_types = {s["type"] for s in NODE_SPECS}
        for n in nodes:
            if (n.get("type") or "") not in known_types:
                findings.append({"level": "error", "nodeId": n.get("id"),
                                 "message": f"unknown node type \"{n.get('type')}\""})
        for e in wf.get("edges") or []:
            if e.get("from") not in ids or e.get("to") not in ids:
                findings.append({"level": "error", "nodeId": e.get("id") or e.get("from"),
                                 "message": "edge references a missing node"})
        env = compute_editor_envelope(nodes)
        referenced = sorted({m for n in nodes
                             for cfgv in [(n.get("config") or {})]
                             for v in cfgv.values() if isinstance(v, str)
                             for m in re.findall(r"\{\{\s*secret:([\w.-]+)\s*\}\}", v)})
        missing = [s for s in referenced
                   if s not in (AuraSecrets().list() if AuraSecrets else [])]
        return {
            "valid": not any(f["level"] == "error" for f in findings),
            "findings": findings,
            "envelope": env,
            "secretsReferenced": referenced,
            "secretsMissing": missing,
            "requiresReview": env["hasIrreversible"] or bool(missing),
        }

    async def workflow_validate(request: Request):
        wf = wf_store.get(request.path_params["wid"])
        if not wf:
            return _err("not found", 404)
        return JSONResponse(_validate(wf))

    # ── versions ────────────────────────────────────────────────────
    async def workflow_versions(request: Request):
        return JSONResponse({"versions": ver_store.list(request.path_params["wid"])})

    async def workflow_version_get(request: Request):
        p = request.path_params
        version = ver_store.get(p["wid"], p["vid"])
        if not version:
            return _err("not found", 404)
        return JSONResponse(version)

    async def workflow_version_publish(request: Request):
        wf = wf_store.get(request.path_params["wid"])
        if not wf:
            return _err("not found", 404)
        body = await request.json() if request.headers.get("content-type") == "application/json" else {}
        version = ver_store.ensure_version_for_run(wf, str((body or {}).get("note") or "published"))
        return JSONResponse(version)

    async def workflow_version_restore(request: Request):
        p = request.path_params
        wf = wf_store.get(p["wid"])
        if not wf:
            return _err("not found", 404)
        version = ver_store.get(p["wid"], p["vid"])
        if not version:
            return _err("not found", 404)
        restored = wf_store.save(p["wid"], {
            **wf, "nodes": version["nodes"], "edges": version["edges"]})
        new_version = ver_store.ensure_version_for_run(
            restored, f"restored from version {p['vid']}")
        return JSONResponse(new_version)

    # ── runs ────────────────────────────────────────────────────────
    def _stream_run(coro_factory):
        """Drive a runner coroutine, streaming its emit frames as SSE.

        Hang-proof: the queue always receives a terminal sentinel (task
        completion OR failure), and reads are timeout-bounded."""
        queue: asyncio.Queue = asyncio.Queue()
        done_sentinel = object()

        def emit(frame: dict):
            # The engine's emit is a synchronous callback (TS parity).
            enriched = dict(frame)
            try:
                bus.publish(enriched)
            except Exception:
                pass
            queue.put_nowait(enriched)

        async def driver():
            try:
                return await coro_factory(emit)
            finally:
                await queue.put(done_sentinel)

        async def gen():
            task = asyncio.ensure_future(driver())
            saw_done = False
            try:
                yield f"data: {dumps_compact({'type': 'start'})}\n\n"
                while True:
                    frame = await asyncio.wait_for(queue.get(), timeout=300)
                    if frame is done_sentinel:
                        break
                    yield f"data: {dumps_compact(frame)}\n\n"
                    if frame.get("type") == "done":
                        saw_done = True
                        break
                result = await task
                if not saw_done:
                    fresh = result.get("run") if isinstance(result, dict) else None
                    if isinstance(result, dict) and result.get("error"):
                        yield f"data: {dumps_compact({'type': 'done', 'status': 'failed', 'ms': 0, 'error': result['error']})}\n\n"
                    elif fresh is not None:
                        yield f"data: {dumps_compact({'type': 'done', 'status': 'completed' if fresh.get('state') == 'succeeded' else 'failed', 'ms': fresh.get('ms', 0), 'runState': fresh.get('state'), 'runId': fresh.get('id'), **({'error': fresh['error']} if fresh.get('error') else {})})}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:  # honest terminal frame, never a hang
                task.cancel()
                yield f"data: {dumps_compact({'type': 'done', 'status': 'failed', 'ms': 0, 'error': str(exc)})}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache"})

    async def workflow_run_stream(request: Request):
        wid = request.path_params["wid"]
        wf = wf_store.get(wid)
        if not wf:
            return _err(f'No workflow stored under "{wid}".', 404)
        body = await request.json() if request.headers.get("content-type") == "application/json" else {}

        def coro_factory(emit):
            return runner.start_workflow_run(
                wf, project_id=str(body.get("projectId") or "default"),
                project_path=str(body.get("projectPath") or aura_home()),
                trigger={"kind": "manual", "by": "user"},
                inputs=body.get("inputs"), approved_capabilities=body.get("approvedCapabilities"),
                emit=emit)

        return _stream_run(coro_factory)

    async def workflow_run_resume(request: Request):
        p = request.path_params
        wf = wf_store.get(p["wid"])
        if not wf:
            return _err("not found", 404)
        body = await request.json() if request.headers.get("content-type") == "application/json" else {}

        def coro_factory(emit):
            return runner.resume(wf, p["rid"], emit,
                                 {"approvedCapabilities": body.get("approvedCapabilities"),
                                  "actor": {"kind": "human", "id": "user"}})

        return _stream_run(coro_factory)

    async def workflow_run_dryrun(request: Request):
        wid = request.path_params["wid"]
        wf = wf_store.get(wid)
        if not wf:
            return _err(f'No workflow stored under "{wid}".', 404)
        from ..workflow.dryrun import dry_run_workflow

        report = dry_run_workflow({
            "workflowId": wid, "workflowName": wf.get("name", ""),
            "projectId": "dry-run", "projectPath": str(aura_home()),
            "fabric": S["fabric"], "secrets": S["secrets"], **wf})
        report.pop("at", None)
        return JSONResponse(report)

    async def workflow_runs_list(request: Request):
        return JSONResponse({"runs": run_store.list(request.path_params["wid"])})

    async def workflow_run_get(request: Request):
        p = request.path_params
        found = run_store.get(p["wid"], p["rid"])
        if not found:
            return _err("not found", 404)
        return JSONResponse(found)

    async def workflow_run_cancel(request: Request):
        cancelled = runner.cancel_workflow_run(request.path_params["rid"])
        if not cancelled:
            found = run_store.find(request.path_params["rid"])
            if not found:
                return _err("not found", 404)
            if found.get("state") in ("succeeded", "failed"):
                return _err(f"that run already {found['state']} — there is nothing to cancel", 409)
        return JSONResponse({"cancelled": cancelled})

    async def workflow_run_chain(request: Request):
        p = request.path_params
        chain: list[dict] = []
        current = run_store.get(p["wid"], p["rid"])
        while current is not None and current.get("trigger", {}).get("of"):
            current = run_store.get(p["wid"], current["trigger"]["of"])
        if current is None:
            current = run_store.find(p["rid"])
        if current is None:
            return _err("not found", 404)
        seen: set[str] = set()
        while current is not None and current["id"] not in seen:
            seen.add(current["id"])
            chain.append(summarize_run(current))
            nxt = current.get("supersededBy")
            current = run_store.get(current["workflowId"], nxt) if nxt else None
        return JSONResponse({"chain": chain})

    async def workflow_webhook_token(request: Request):
        wid = request.path_params["wid"]
        wf = wf_store.get(wid)
        if not wf:
            return _err("not found", 404)
        import secrets as pysecrets

        tokens_file = aura_home() / "webhook-tokens.json"
        tokens = read_json_file(tokens_file, {})
        rotate = bool((await request.json() or {}).get("rotate")) \
            if request.headers.get("content-type") == "application/json" else False
        if rotate or wid not in tokens:
            tokens[wid] = pysecrets.token_urlsafe(24)
            write_json_atomic(tokens_file, tokens)
        return JSONResponse({"token": tokens[wid], "path": f"/webhook/{tokens[wid]}"})

    # ── cross-workflow run index ────────────────────────────────────
    async def runs_list(request: Request):
        query = dict(request.query_params)
        entries = run_store.list()  # already WorkflowRunSummary rows
        total = len(entries)
        if query.get("state"):
            entries = [r for r in entries if r["state"] == query["state"]]
        if query.get("projectId"):
            entries = [r for r in entries if r["projectId"] == query["projectId"]]
        offset = max(0, int(query.get("offset", 0)))
        limit = max(1, min(200, int(query.get("limit", 50))))
        return JSONResponse({"runs": entries[offset:offset + limit],
                             "total": total, "offset": offset, "limit": limit})

    async def run_stats(request: Request):
        query = dict(request.query_params)
        stats: dict[str, int] = {}
        for r in run_store.list():
            if query.get("projectId") and r.get("projectId") != query["projectId"]:
                continue
            stats[r["state"]] = stats.get(r["state"], 0) + 1
        return JSONResponse({"stats": stats})

    async def runs_awaiting(request: Request):
        rows = run_store.list_awaiting_approval()  # already excludes superseded legs
        return JSONResponse({"runs": rows})

    async def run_get(request: Request):
        found = run_store.find(request.path_params["rid"])
        if not found:
            return _err("not found", 404)
        return JSONResponse(found)

    # ── agent bounds / tools ────────────────────────────────────────
    async def agent_bounds(request: Request):
        from ..workflow.agent.bounds import AGENT_CEILINGS, AGENT_DEFAULTS

        return JSONResponse({"defaults": AGENT_DEFAULTS, "ceilings": AGENT_CEILINGS})

    async def agent_tools(request: Request):
        from ..workflow.agent.bounds import resolve_tools

        query = request.query_params
        wid = query.get("workflowId")
        requested = [t for t in (query.get("requested") or "").split(",") if t]
        envelope = _envelope_for(wf_store.get(wid) or {"nodes": []}) if wid \
            else {"capabilities": []}
        resolved = resolve_tools(requested, envelope.get("capabilities") or [],
                                 lambda cid: describe_capability(cid))
        allowed, refused = resolved["allowed"], resolved["refused"]
        describe = []
        for cid in allowed:
            cap = describe_capability(cid)
            if cap:
                describe.append({
                    "name": cid,
                    "description": cap.get("description", ""),
                    "input": [{"name": f.get("name"), "type": f.get("type", "string"),
                               "required": bool(f.get("required")),
                               "description": f.get("label", "")}
                              for f in cap.get("input") or []],
                })
        return JSONResponse({"allowed": allowed, "refused": refused,
                             "envelope": envelope, "describe": describe})

    # ── central agent sessions ──────────────────────────────────────
    def _session_or_none(sid: str):
        try:
            return sessions.load(sid)
        except Exception:
            return None

    async def agent_submit(request: Request):
        body = await request.json()
        message = str(body.get("message") or "").strip()
        if not message:
            return _err("message is required")
        import anyio

        result = await anyio.to_thread.run_sync(
            lambda: agent.submit(message,
                                 project_id=body.get("projectId") or None,
                                 project_path=body.get("projectPath") or None))
        return JSONResponse({"result": _model_dump(result),
                             "sessionId": sessions.last_session_id})

    async def agent_message(request: Request):
        body = await request.json()
        message = str(body.get("message") or "").strip()
        if not message:
            return _err("message is required")
        import anyio

        result = await anyio.to_thread.run_sync(
            lambda: agent.message(request.path_params["sid"], message,
                                  body.get("projectPath")))
        return JSONResponse({"result": _model_dump(result)})

    async def agent_session_get(request: Request):
        session = _session_or_none(request.path_params["sid"])
        if session is None:
            return _err("no such session", 404)
        return JSONResponse(_model_dump(session))

    async def agent_approve(request: Request):
        body = await request.json()
        approval_id = str(body.get("approvalId") or "")
        granted = bool(body.get("granted"))
        reason = body.get("reason")
        decided = S["ledger"].decide(approval_id, granted, "user", reason)
        if decided is None:
            return _err("this request was already decided", 409)
        import anyio

        result = await anyio.to_thread.run_sync(lambda: agent.resume(request.path_params["sid"]))
        return JSONResponse({"approval": decided, "result": _model_dump(result)})

    async def agent_resume(request: Request):
        import anyio

        session = _session_or_none(request.path_params["sid"])
        if session is None:
            return _err("no such session", 404)
        if session.state != "awaiting-approval":
            return _err("that session is not awaiting approval", 400)
        result = await anyio.to_thread.run_sync(lambda: agent.resume(request.path_params["sid"]))
        return JSONResponse({"result": _model_dump(result)})

    async def agent_cancel(request: Request):
        import anyio

        cancelled = await anyio.to_thread.run_sync(
            lambda: agent.cancel(request.path_params["sid"]))
        return JSONResponse({"cancelled": bool(cancelled)})

    async def agent_plan(request: Request):
        review = agent.review_plan(request.path_params["sid"])
        if review is None:
            return _err("that session has no active plan", 404)
        return JSONResponse(review)

    async def agent_evidence(request: Request):
        session = _session_or_none(request.path_params["sid"])
        if session is None:
            return _err("no such session", 404)
        last = getattr(session, "lastResult", None)
        evidence = getattr(last, "evidence", None) if last else None
        return JSONResponse(evidence.model_dump() if evidence else {"evidence": None})

    async def agent_events(request: Request):
        sid = request.path_params["sid"]
        # Tail replay then close: the client's reconnect loop re-subscribes
        # with backoff and dedupes by (type, at), so a bounded stream can
        # never strand a reader and can never double-render.
        session = _session_or_none(sid)
        if session is None:
            return _err("no such session", 404)
        frames = [json.loads(chunk) for chunk in agent.bus.tail_stream(sid)]

        def stream():
            for frame in frames:
                yield frame
        return _sse(stream())

    # ── governance: approvals + fabric ──────────────────────────────
    async def fabric_approvals(request: Request):
        return JSONResponse({"approvals": S["ledger"].pending()})

    async def fabric_approvals_decide(request: Request):
        body = await request.json()
        decided = S["ledger"].decide(
            request.path_params["aid"], bool(body.get("granted")),
            "user", body.get("reason"))
        if decided is None:
            return _err("this request was already decided", 409)
        # Sync granted approval into fabric's internal cache so next invoke sees it
        if decided.get("state") == "granted":
            # The ledger and fabric share the same dedup key format.
            # Copy the granted entry so fabric's next lookup finds it.
            for k, v in S["ledger"]._approvals.items():
                if v.get("id") == decided["id"]:
                    S["fabric"]._approvals_by_key[k] = v
                    break
        return JSONResponse({"approval": decided})

    async def fabric_invoke(request: Request):
        body = await request.json()
        capability_id = str(body.get("capabilityId") or "")
        if not capability_id:
            return _err("capabilityId is required")
        context = body.get("context") or {}
        context.setdefault("actor", {"kind": "human", "id": "user"})
        result = await S["fabric"].invoke(capability_id, body.get("input") or {}, context)
        return JSONResponse(result)

    async def fabric_capabilities(request: Request):
        caps = []
        supported_count = 0
        provided_node_caps: set[str] = set()
        for d in S["fabric"].executors.values() if hasattr(S["fabric"], "executors") else []:
            provided_node_caps.add(getattr(d, "capabilityId", ""))
        from ..fabric.manifest import all_capabilities

        catalogue = all_capabilities()
        supported_ids = set(getattr(S["fabric"], "executors", {}) or {})
        for c in catalogue:
            d = c._d
            supported = d["id"] in supported_ids
            if supported:
                supported_count += 1
            requires = d.get("requiresNodeCapability")
            if requires and supported:
                provided_node_caps.add(requires)
            caps.append({**d, "supported": supported})
        policy = read_json_file(aura_home() / "fabric-policy.json",
                                S["fabric"].policy)
        return JSONResponse({
            "capabilities": caps,
            "supportedCount": supported_count,
            "providedNodeCapabilities": sorted(x for x in provided_node_caps if x),
            "policy": policy,
        })

    async def fabric_policy_get(request: Request):
        from ..policy import DEFAULT_POLICY

        return JSONResponse({"policy": read_json_file(
            aura_home() / "fabric-policy.json", DEFAULT_POLICY),
            "file": str(aura_home() / "fabric-policy.json")})

    async def fabric_policy_set(request: Request):
        patch = await request.json()
        file_path = aura_home() / "fabric-policy.json"
        from ..policy import DEFAULT_POLICY

        current = read_json_file(file_path, DEFAULT_POLICY)
        merged = {**current}
        for key in ("byRisk", "overrides", "nodeOverrides", "nodeAllowlists"):
            if key in patch and isinstance(patch[key], dict):
                merged[key] = {**merged.get(key, {}), **patch[key]}
        if "allowAutonomous" in patch:
            merged["allowAutonomous"] = bool(patch["allowAutonomous"])
        write_json_atomic(file_path, merged)
        if hasattr(S["fabric"], "policy"):
            S["fabric"].policy = merged
        return JSONResponse({"policy": merged, "file": str(file_path)})

    async def fabric_nodes_get(request: Request):
        # The exact projection authority preflight and execution resolve
        # against — reading it can never disagree with either.
        host = S["fabric"].host if hasattr(S["fabric"], "host") else None
        provided = sorted(host.provided_capabilities()) if hasattr(host, "provided_capabilities") else []
        return JSONResponse({
            "nodes": S["nodes"].list_nodes(),
            "providedNodeCapabilities": provided,
        })

    async def fabric_nodes_register(request: Request):
        # Local connector-configuration seam (until a live connector lands):
        # registering a node makes it ROUTABLE, never authorized — policy,
        # approval floors and single-use grants are unchanged.
        body = await request.json()
        try:
            record = S["nodes"].register(
                str(body.get("id") or ""), str(body.get("name") or ""),
                list(body.get("capabilities") or []),
                internal=body.get("internal") is True,
                version=str(body.get("version") or ""))
        except ValueError as exc:
            return _err(str(exc), 400)
        return JSONResponse(record)

    async def fabric_nodes_remove(request: Request):
        ok = S["nodes"].remove(request.path_params["nid"])
        if not ok:
            return _err("no such node", 404)
        return JSONResponse({"ok": True})

    async def fabric_audit(request: Request):
        return JSONResponse({"audit": S["audit"].load()})

    async def fabric_mission_annotation(request: Request):
        # MISSING CANONICAL BACKEND CONTRACT: the mission subsystem (stored
        # MissionRecord + plan) has no canonical Python implementation yet.
        # Reported honestly rather than faked.
        return _err(
            "the mission subsystem has no canonical backend implementation; "
            "capability annotation over stored missions is unavailable", 501)

    # ── projects (REQUIRED migrated contract; ONE ProjectRegistry) ──
    def _registry(self=None):
        return S["registry"]

    async def projects_list(request: Request):
        registry = S["registry"]
        return JSONResponse({"projects": registry.list_projects(),
                             "current": registry.current_project()})

    async def projects_add(request: Request):
        import anyio

        body = await request.json()
        try:
            record = await anyio.to_thread.run_sync(
                lambda: S["registry"].add({
                    "name": str(body.get("name") or ""),
                    "path": str(body.get("path") or ""),
                    "icon": body.get("icon"),
                }))
        except RuntimeError as exc:
            return _err(str(exc), 400)
        return JSONResponse(record)

    async def project_open(request: Request):
        import anyio

        pid = request.path_params["pid"]
        try:
            opened = await anyio.to_thread.run_sync(
                lambda: S["registry"].open(pid))
        except RuntimeError as exc:
            return _err(str(exc), 404)
        profile = S["registry"].profile(pid)
        return JSONResponse({
            "project": opened,
            "profile": profile,
            "status": {"status": "ready"},
        })

    async def project_profile(request: Request):
        pid = request.path_params["pid"]
        if S["registry"].get(pid) is None:
            return _err(f'no project is registered with id "{pid}"', 404)
        profile = S["registry"].profile(pid)
        if not profile:
            return _err("no profile", 404)
        return JSONResponse(profile)

    # ── missions (C: explicitly unsupported — no canonical engine) ───
    async def missions_unsupported(request: Request):
        # Frozen honest refusal. The mission subsystem (stored MissionRecord,
        # plan lifecycle, task execution) has NO canonical Python
        # implementation. Nothing is faked; the dependency is documented in
        # docs/migration/INTEGRATION_BLOCKERS_RESOLUTION.md.
        return _err(
            "the mission subsystem has no canonical backend implementation; "
            "this surface stays unavailable until a domain owner lands it",
            501)

    # ── providers (truthful read-only; writes at composition root) ───
    async def providers_get(request: Request):
        """Reflect the provider configuration that is already running.

        The Python backend configures providers at startup via environment
        variables or an injected model seam.  There is no registry to
        query or mutate at runtime.  GET /providers returns the truth
        about what is active; POST /providers/* returns honest 501s.
        """
        base_url = os.environ.get("AURA_AI_BASE_URL", "").rstrip("/")
        api_key = os.environ.get("AURA_AI_KEY", "")
        model_id = os.environ.get("AURA_AI_MODEL", "unknown")

        has_provider = bool(base_url)
        status_type = "byoak" if has_provider else "none"
        label = base_url.split("//")[-1].split("/")[0] if has_provider else "none"

        # The runner carries the live model seam (set in create_api_server).
        runner_model = getattr(S["runner"], "model", None)
        active_model = model_id if has_provider else "none"
        provider_id = "aura" if has_provider else None

        providers = []
        connected = []
        if has_provider:
            providers.append({
                "id": "aura",
                "name": label,
                "description": f"AURA Hub model provider ({label})",
                "apiEndpoint": base_url,
            })
            connected.append({
                "id": "aura",
                "name": label,
                "fingerprint": api_key[:8] + "…" if api_key else "",
                "models": [{"id": model_id, "name": model_id}],
                "activeModel": model_id,
                "health": None,
            })

        return JSONResponse({
            "providers": providers,
            "defaultProvider": provider_id,
            "connected": connected,
            "active": provider_id,
            "activeModel": active_model,
            "status": {
                "type": status_type,
                "providerId": provider_id,
                "label": label,
                "model": active_model,
            },
        })

    async def providers_connect(request: Request):
        return _err(
            "provider configuration is performed at composition root via "
            "environment variables (AURA_AI_BASE_URL, AURA_AI_KEY); "
            "runtime connect/disconnect is not supported",
            501)

    async def providers_disconnect(request: Request):
        return _err(
            "provider configuration is performed at composition root via "
            "environment variables; runtime disconnect is not supported",
            501)

    async def providers_switch(request: Request):
        return _err(
            "provider/model switching is performed at composition root; "
            "runtime switch is not supported",
            501)

    async def providers_models(request: Request):
        return _err(
            "model discovery is performed at composition root; "
            "runtime model discovery is not supported",
            501)

    # ── secrets (metadata only — never values) ──────────────────────
    async def secrets_list(request: Request):
        store = AuraSecrets()
        return JSONResponse([{"name": s["name"], "hasValue": True}
                             if isinstance(s, dict) else {"name": s, "hasValue": True}
                             for s in store.list()])

    # ── automation ──────────────────────────────────────────────────
    AUTOMATION_TEMPLATE_INFOS = [
        {"id": "nightly-status", "name": "Nightly status digest",
         "description": "Runs a status workflow every night against a project.",
         "category": "Schedule"},
        {"id": "on-git-change", "name": "React to git changes",
         "description": "Runs a workflow whenever changed-files are detected.",
         "category": "Event"},
    ]

    async def automation_templates(request: Request):
        return JSONResponse({"templates": AUTOMATION_TEMPLATE_INFOS})

    async def automation_rules_list(request: Request):
        return JSONResponse({"rules": S["auto_store"].list_rules()})

    async def automation_rule_get(request: Request):
        rule = S["auto_store"].get_rule(request.path_params["rid"])
        if rule is None:
            return _err("not found", 404)
        return JSONResponse(rule)

    async def automation_rule_create(request: Request):
        body = await request.json()
        if isinstance(body.get("template"), str):
            template = next((t for t in AUTOMATION_TEMPLATE_INFOS
                             if t["id"] == body["template"]), None)
            if template is None:
                return _err(f'no template named "{body["template"]}"', 404)
            body = {"name": template["name"]}
        issues = _validate_rule_issues(body)
        if issues:
            return _err("; ".join(i["message"] for i in issues), 422)
        return JSONResponse(S["auto_store"].create_rule(body))

    async def automation_rule_save(request: Request):
        body = await request.json()
        rid = request.path_params["rid"]
        existing = S["auto_store"].get_rule(rid)
        if existing is None:
            return _err("not found", 404)
        issues = _validate_rule_issues({**existing, **body})
        if issues:
            return _err("; ".join(i["message"] for i in issues), 422)
        saved = S["auto_store"].save_rule(rid, body)
        return JSONResponse(saved or existing)

    async def automation_rule_patch(request: Request):
        rid = request.path_params["rid"]
        existing = S["auto_store"].get_rule(rid)
        if existing is None:
            return _err("not found", 404)
        body = await request.json()
        saved = S["auto_store"].save_rule(rid, body)
        return JSONResponse(saved or existing)

    async def automation_rule_remove(request: Request):
        ok = S["auto_store"].remove_rule(request.path_params["rid"])
        if not ok:
            return _err("not found", 404)
        return JSONResponse({"ok": True})

    async def automation_rule_run(request: Request):
        # Canonical contract (automation/engine.ts runRuleNow): the RUN DICT
        # on success; {error, run:null} only when the rule does not match;
        # 404 {error} for an unknown rule. The engine matches conditions and
        # EXECUTES through WorkflowRunner — this route changes neither.
        import anyio

        body = await request.json() if request.headers.get("content-type") == "application/json" else {}
        rid = request.path_params["rid"]
        rule = S["auto_store"].get_rule(rid)
        if rule is None:
            return _err("no such rule", 404)
        event = {
            "type": trigger_type_of(rule),
            "projectId": str(body.get("projectId") or rule.get("trigger", {}).get("projectId") or "default"),
            "projectPath": str(aura_home()),
            "at": _now(),
            "payload": body.get("payload") or {},
        }
        run = await anyio.to_thread.run_sync(
            lambda: asyncio.run(S["auto_engine"].run_rule_now(rid, event)))
        if run is None:
            return JSONResponse({"error": "conditions not met", "run": None})
        persisted = S["auto_store"].get_run(rid, run["id"])
        return JSONResponse(persisted or run)

    async def automation_rule_pause(request: Request):
        import anyio

        rid = request.path_params["rid"]
        if S["auto_store"].get_rule(rid) is None:
            return _err("not found", 404)
        run = await anyio.to_thread.run_sync(lambda: S["auto_engine"].pause_rule(rid))
        return JSONResponse(run)

    async def automation_rule_resume(request: Request):
        import anyio

        rid = request.path_params["rid"]
        if S["auto_store"].get_rule(rid) is None:
            return _err("not found", 404)
        run = await anyio.to_thread.run_sync(lambda: S["auto_engine"].resume_rule(rid))
        return JSONResponse(run)

    async def automation_rule_runs(request: Request):
        runs = [S["auto_store"].get_run(request.path_params["rid"], r["id"])
                for r in S["auto_store"].list_runs(request.path_params["rid"])]
        return JSONResponse({"runs": [r for r in runs if r is not None]})

    async def automation_run_get(request: Request):
        run = S["auto_store"].get_run(request.path_params["rid"],
                                      request.path_params["runid"])
        if run is None:
            return _err("not found", 404)
        return JSONResponse(run)

    async def automation_run_cancel(request: Request):
        import anyio

        run = await anyio.to_thread.run_sync(
            lambda: S["auto_engine"].cancel_run(request.path_params["rid"],
                                                request.path_params["runid"]))
        if run is None:
            return _err("not found", 404)
        return JSONResponse(run)

    async def automation_rule_dryrun(request: Request):
        from ..automation.dryrun import dry_run_rule
        from ..workflow.dryrun import dry_run_workflow

        rid = request.path_params["rid"]
        rule = S["auto_store"].get_rule(rid)
        if rule is None:
            return _err("not found", 404)
        body = await request.json() if request.headers.get("content-type") == "application/json" else {}

        def resolve_workflow(workflow_id: str):
            return wf_store.get(workflow_id)

        def workflow_dry_run(wf: dict, project_id: str) -> dict:
            report = dry_run_workflow({
                "workflowId": wf["id"], "workflowName": wf.get("name", ""),
                "projectId": project_id, "projectPath": str(aura_home()),
                "fabric": S["fabric"], "secrets": S["secrets"], **wf})
            report.pop("at", None)
            return report

        report = dry_run_rule(
            rule=rule, resolve_workflow=resolve_workflow,
            dry_run_workflow=workflow_dry_run,
            sample_event=body.get("sampleEvent"),
            project_id=body.get("projectId"))
        return JSONResponse(report)

    async def automation_schedules(request: Request):
        # reconcile() recomputes next-fire/missed counts from the cron truth
        # and persists the state; the UI reads answers, never parses cron.
        S["scheduler"].reconcile()
        return JSONResponse({"schedules": S["scheduler"].state})

    async def automation_runs_index(request: Request):
        query = dict(request.query_params)
        page = S["auto_store"].index_runs(query)
        return JSONResponse(page)

    async def automation_stats_reindex(request: Request):
        count = S["auto_store"].rebuild_run_index()
        rules = S["auto_store"].list_rules()
        return JSONResponse({
            "indexed": count,
            "rules": len(rules),
            "activeRules": sum(1 for r in rules if r.get("enabled")),
        })

    async def automation_events_stream(request: Request):
        q: asyncio.Queue = asyncio.Queue()
        S["auto_subs"].append(q)

        async def gen():
            try:
                while True:
                    entry = await q.get()
                    yield f"data: {dumps_compact(entry)}\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                if q in S["auto_subs"]:
                    S["auto_subs"].remove(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache"})

    # ── global workflow event stream (Last-Event-ID aware) ──────────
    async def sse_workflow_events(request: Request):
        last_id = 0
        header = request.headers.get("last-event-id")
        if header and header.isdigit():
            last_id = int(header)
        since = request.query_params.get("since")
        if since is not None and since.isdigit():
            # ?since= cursor; Last-Event-ID wins when both are present.
            last_id = max(last_id, int(since))
        until_raw = request.query_params.get("until")
        until = int(until_raw) if until_raw is not None and until_raw.isdigit() else None
        q = bus.subscribe(last_id)

        async def gen():
            try:
                yield f": connected, head={bus.last_seq}\n\n"
                while True:
                    entry = await q.get()
                    yield f"id: {entry['seq']}\ndata: {dumps_compact(entry)}\n\n"
                    if until is not None and entry["seq"] >= until:
                        # Bounded catch-up: replay through `until`, then stop.
                        # Clients reconnect from the delivered id.
                        yield "data: [DONE]\n\n"
                        return
            except asyncio.CancelledError:
                pass
            finally:
                bus.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache"})

    # helpers ---------------------------------------------------------
    def _validate_rule_issues(rule: dict) -> list[dict]:
        from ..automation.dryrun import validate_rule

        return validate_rule(rule)

    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/workflows", workflow_list, methods=["GET"]),
        Route("/workflows", workflow_create, methods=["POST"]),
        Route("/workflows/import", workflow_import, methods=["POST"]),
        Route("/workflows/generate", workflow_generate, methods=["POST"]),
        Route("/workflows/specs", workflow_specs, methods=["GET"]),
        Route("/workflows/templates", workflow_templates, methods=["GET"]),
        Route("/workflows/{wid}", workflow_get, methods=["GET"]),
        Route("/workflows/{wid}", workflow_save, methods=["PUT"]),
        Route("/workflows/{wid}", workflow_patch, methods=["PATCH"]),
        Route("/workflows/{wid}", workflow_delete, methods=["DELETE"]),
        Route("/workflows/{wid}/duplicate", workflow_duplicate, methods=["POST"]),
        Route("/workflows/{wid}/envelope", workflow_envelope, methods=["GET"]),
        Route("/workflows/{wid}/validate", workflow_validate, methods=["GET"]),
        Route("/workflows/{wid}/versions", workflow_versions, methods=["GET"]),
        Route("/workflows/{wid}/versions", workflow_version_publish, methods=["POST"]),
        Route("/workflows/{wid}/versions/{vid}", workflow_version_get, methods=["GET"]),
        Route("/workflows/{wid}/versions/{vid}/restore", workflow_version_restore, methods=["POST"]),
        Route("/workflows/{wid}/run", workflow_run_stream, methods=["POST"]),
        Route("/workflows/{wid}/dry-run", workflow_run_dryrun, methods=["POST"]),
        Route("/workflows/{wid}/runs", workflow_runs_list, methods=["GET"]),
        Route("/workflows/{wid}/runs/{rid}", workflow_run_get, methods=["GET"]),
        Route("/workflows/{wid}/runs/{rid}/cancel", workflow_run_cancel, methods=["POST"]),
        Route("/workflows/{wid}/runs/{rid}/chain", workflow_run_chain, methods=["GET"]),
        Route("/workflows/{wid}/runs/{rid}/resume", workflow_run_resume, methods=["POST"]),
        Route("/workflows/{wid}/webhook-token", workflow_webhook_token, methods=["POST"]),
        Route("/workflow-runs", runs_list, methods=["GET"]),
        Route("/workflow-runs/stats", run_stats, methods=["GET"]),
        Route("/workflow-runs/awaiting", runs_awaiting, methods=["GET"]),
        Route("/workflow-runs/{rid}", run_get, methods=["GET"]),
        Route("/agent/bounds", agent_bounds, methods=["GET"]),
        Route("/agent/tools", agent_tools, methods=["GET"]),
        Route("/agent/sessions", agent_submit, methods=["POST"]),
        Route("/agent/sessions/{sid}", agent_session_get, methods=["GET"]),
        Route("/agent/sessions/{sid}/message", agent_message, methods=["POST"]),
        Route("/agent/sessions/{sid}/approve", agent_approve, methods=["POST"]),
        Route("/agent/sessions/{sid}/resume", agent_resume, methods=["POST"]),
        Route("/agent/sessions/{sid}/cancel", agent_cancel, methods=["POST"]),
        Route("/agent/sessions/{sid}/plan", agent_plan, methods=["GET"]),
        Route("/agent/sessions/{sid}/evidence", agent_evidence, methods=["GET"]),
        Route("/agent/sessions/{sid}/events", agent_events, methods=["GET"]),
        Route("/fabric/approvals", fabric_approvals, methods=["GET"]),
        Route("/fabric/approvals/{aid}/decide", fabric_approvals_decide, methods=["POST"]),
        Route("/fabric/invoke", fabric_invoke, methods=["POST"]),
        Route("/fabric/capabilities", fabric_capabilities, methods=["GET"]),
        Route("/fabric/policy", fabric_policy_get, methods=["GET"]),
        Route("/fabric/policy", fabric_policy_set, methods=["POST"]),
        Route("/fabric/nodes", fabric_nodes_get, methods=["GET"]),
        Route("/fabric/nodes", fabric_nodes_register, methods=["POST"]),
        Route("/fabric/nodes/{nid}", fabric_nodes_remove, methods=["DELETE"]),
        Route("/fabric/audit", fabric_audit, methods=["GET"]),
        Route("/fabric/mission/{pid}/{mid}", fabric_mission_annotation, methods=["GET"]),
        Route("/projects", projects_list, methods=["GET"]),
        Route("/projects", projects_add, methods=["POST"]),
        Route("/projects/{pid}/open", project_open, methods=["POST"]),
        Route("/projects/{pid}/profile", project_profile, methods=["GET"]),
        Route("/missions/dashboard", missions_unsupported, methods=["GET"]),
        Route("/projects/{pid}/missions", missions_unsupported, methods=["GET"]),
        Route("/projects/{pid}/missions/{mid}", missions_unsupported, methods=["GET"]),
        Route("/providers", providers_get, methods=["GET"]),
        Route("/providers/connect", providers_connect, methods=["POST"]),
        Route("/providers/disconnect", providers_disconnect, methods=["POST"]),
        Route("/providers/switch", providers_switch, methods=["POST"]),
        Route("/providers/models", providers_models, methods=["POST"]),
        Route("/secrets", secrets_list, methods=["GET"]),
        Route("/automation/templates", automation_templates, methods=["GET"]),
        Route("/automation/rules", automation_rules_list, methods=["GET"]),
        Route("/automation/rules", automation_rule_create, methods=["POST"]),
        Route("/automation/validate", automation_validate_route, methods=["POST"]),
        Route("/automation/rules/{rid}", automation_rule_get, methods=["GET"]),
        Route("/automation/rules/{rid}", automation_rule_save, methods=["PUT"]),
        Route("/automation/rules/{rid}", automation_rule_patch, methods=["PATCH"]),
        Route("/automation/rules/{rid}", automation_rule_remove, methods=["DELETE"]),
        Route("/automation/rules/{rid}/run", automation_rule_run, methods=["POST"]),
        Route("/automation/rules/{rid}/pause", automation_rule_pause, methods=["POST"]),
        Route("/automation/rules/{rid}/resume", automation_rule_resume, methods=["POST"]),
        Route("/automation/rules/{rid}/dry-run", automation_rule_dryrun, methods=["POST"]),
        Route("/automation/rules/{rid}/runs", automation_rule_runs, methods=["GET"]),
        Route("/automation/rules/{rid}/runs/{runid}", automation_run_get, methods=["GET"]),
        Route("/automation/rules/{rid}/runs/{runid}/cancel", automation_run_cancel, methods=["POST"]),
        Route("/automation/schedules", automation_schedules, methods=["GET"]),
        Route("/automation/runs", automation_runs_index, methods=["GET"]),
        Route("/automation/stats", automation_stats_reindex, methods=["GET"]),
        Route("/automation/reindex", automation_stats_reindex, methods=["POST"]),
        Route("/automation/events/stream", automation_events_stream, methods=["GET"]),
        Route("/events/workflow", sse_workflow_events, methods=["GET"]),
        Route("/environment/scan", environment_scan, methods=["POST"]),
        Route("/environment/inventory", environment_inventory, methods=["POST"]),
        Route("/environment/probe", environment_probe, methods=["POST"]),
        Route("/environment/install", environment_install, methods=["POST"]),
        Route("/environment/uninstall", environment_uninstall, methods=["POST"]),
        Route("/environment/connect", environment_connect, methods=["POST"]),
    ]

    app = Starlette(
        routes=routes,
        middleware=[Middleware(CORSMiddleware,
                               allow_origin_regex=ALLOWED_ORIGIN,
                               allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                               allow_headers=["Content-Type", "x-aura-shutdown",
                                              "Last-Event-ID"])])
    app.state.services = S
    app.state.runner = runner
    app.state.wf_store = wf_store
    app.state.ver_store = ver_store
    app.state.run_store = run_store
    app.state.secrets = secrets_store
    app.state.agent = agent
    app.state.ledger = S["ledger"]
    app.state.bus = bus
    return app


def create_app(**kwargs) -> Starlette:
    """Public factory."""
    return create_api_server(**kwargs)


def _model_dump(obj):
    return obj.model_dump() if hasattr(obj, "model_dump") else obj


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def trigger_type_of(rule: dict) -> str:
    return (rule.get("trigger") or {}).get("type") or "manual"


async def automation_validate_route(request: Request):
    """The service's own verdict on a draft rule."""
    from ..automation.dryrun import validate_rule

    body = await request.json()
    return JSONResponse({"issues": validate_rule(body)})


async def _environment_body(request: Request) -> dict:
    """Parse an /environment request body defensively.

    A malformed payload is a client mistake, not a server fault: it must not
    surface as an unhandled JSONDecodeError and a 500.
    """
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _environment_ids(raw: object) -> list[str] | None:
    """Validate the optional `ids` filter.

    Anything that is not a list of non-empty strings is treated as "no
    filter" rather than being passed through to a membership test that would
    do substring matching on a bare string, or raise on an int.
    """
    if not isinstance(raw, list):
        return None
    ids = [item.strip() for item in raw if isinstance(item, str) and item.strip()]
    return ids or None


async def environment_scan(request: Request):
    """Scan the machine for known catalog nodes.

    POST /environment/scan
    Body: { ids?: string[], refresh?: boolean }
    Returns: { results, scannedAt, found, discovered, packages, osPackages, ... }

    The scan runs subprocesses for many seconds. It is handed to a worker
    thread so the event loop keeps serving every other route while it does;
    `scan_environment` itself collapses concurrent identical scans into one.
    """
    import anyio.to_thread

    from ..environment import scan_environment, scan_result_to_dict

    body = await _environment_body(request)
    node_ids = _environment_ids(body.get("ids"))
    refresh = bool(body.get("refresh", False))
    result = await anyio.to_thread.run_sync(
        lambda: scan_result_to_dict(scan_environment(node_ids=node_ids, refresh=refresh))
    )
    return JSONResponse(result)


async def environment_inventory(request: Request):
    """The complete machine inventory, paginated.

    POST /environment/inventory
    Body: { refresh?, offset?, limit?, kinds?: string[], query?, verify? }
    Returns: { items, total, returned, offset, truncated, counts, sources, ... }

    `total` is how many items matched, not how many were returned: a caller
    that wants everything pages through it, and one that wants a screenful
    is told how much more there is. Collection runs on a worker thread and
    is shared between concurrent callers.
    """
    import anyio.to_thread

    from ..environment.inventory import get_inventory, inventory_to_dict

    body = await _environment_body(request)
    refresh = bool(body.get("refresh", False))
    verify = bool(body.get("verify", True))
    offset = _positive_int(body.get("offset"), 0)
    raw_limit = body.get("limit", 200)
    limit = None if raw_limit is None else min(_positive_int(raw_limit, 200), 5000)
    kinds = _string_set(body.get("kinds"))
    raw_query = body.get("query")
    query = raw_query if isinstance(raw_query, str) else None

    inventory = await anyio.to_thread.run_sync(
        lambda: get_inventory(refresh=refresh, verify=verify)
    )
    payload = await anyio.to_thread.run_sync(
        lambda: inventory_to_dict(inventory, offset=offset, limit=limit, kinds=kinds, query=query)
    )
    return JSONResponse(payload)


def _string_set(value: object) -> set[str] | None:
    """A set of strings from an untrusted body, or no filter at all.

    `value or []` is not enough: a body of `{"kinds": 5}` leaves the 5 in
    place and iterating it raises, which reaches the client as a 500 for
    what is only a malformed request.
    """
    if not isinstance(value, (list, tuple, set)):
        return None
    names = {item for item in value if isinstance(item, str) and item.strip()}
    return names or None


def _positive_int(value: object, fallback: int) -> int:
    """A bounded integer from an untrusted body, never an exception."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    try:
        number = int(value)
    except (ValueError, OverflowError):
        return fallback
    return max(0, min(number, 1_000_000))


async def environment_probe(request: Request):
    """Probe a specific catalog node.

    POST /environment/probe
    Body: { id: string, refresh?: boolean }
    Returns: { result?: ProbeResult }
    """
    import anyio.to_thread

    from ..environment import probe_node, probe_result_to_dict

    body = await _environment_body(request)
    node_id = str(body.get("id") or "").strip()
    if not node_id:
        return JSONResponse({"result": {"present": False, "status": "unsupported", "detail": "No node id was provided."}})
    refresh = bool(body.get("refresh", False))
    result = await anyio.to_thread.run_sync(lambda: probe_node(node_id, refresh=refresh))
    return JSONResponse({"result": probe_result_to_dict(result)})


async def environment_install(request: Request):
    """Direct human installation — bypasses Fabric approval gate.

    POST /environment/install
    Body: { id: string }
    Returns: InstallResult-like payload with installOutcome, privilege,
             requiresUserAction, command, why, probe, detail, exitCode.

    Security: catalog-only, validated InstallSpec, allow-listed bin,
              argv-only, no shell, frontend sends id only.
    """
    from ..environment import catalog_entry, is_plan, plan_install, probe_node, probe_result_to_dict
    from ..exec_ import INSTALL_TIMEOUT_MS, resolve_installer_binary

    body = await _environment_body(request)
    node_id = str(body.get("id") or body.get("nodeId") or "").strip()
    if not node_id:
        return JSONResponse({"error": "No node id was provided.", "installOutcome": "failed", "detail": "No node id was provided."}, status_code=400)

    entry = catalog_entry(node_id)
    if entry is None:
        return JSONResponse({"error": f"'{node_id}' is not in the catalog.", "installOutcome": "failed", "detail": f"'{node_id}' is not in the catalog."}, status_code=400)

    plan = plan_install(entry)
    if not is_plan(plan):
        return JSONResponse({
            "installOutcome": "unavailable",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "detail": plan.reason,
            "why": plan.reason,
        }, status_code=400)

    if plan.privilege == "root":
        return JSONResponse({
            "installOutcome": "guided",
            "nodeId": node_id,
            "privilege": "root",
            "requiresUserAction": True,
            "command": plan.command,
            "why": plan.why,
            "detail": f"{entry.name} needs administrator rights to install, so AURA did not run anything. Run this yourself, then re-scan: {plan.command}",
        })

    resolved = resolve_installer_binary(plan.bin)
    if not resolved.ok:
        return JSONResponse({
            "installOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": resolved.reason,
            "detail": f"{entry.name} could not be installed: {resolved.reason}",
        }, status_code=400)

    # Execution is delegated to the one hardened install runner, which the
    # Fabric capability uses too. This route previously spawned the installer
    # itself and had drifted: stdin was still attached to the operator's
    # terminal and only the direct child was killed on timeout.
    from ..environment.executor import run_install_plan

    run = await run_install_plan(plan, timeout_ms=INSTALL_TIMEOUT_MS)

    if run.status in ("missing", "error"):
        return JSONResponse({
            "installOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": run.error,
            "detail": f"{entry.name} could not be installed: {run.error}",
        }, status_code=400)

    if run.status == "timeout":
        return JSONResponse({
            "installOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": "The installer ran out of time and was stopped.",
            "timedOut": True,
            "exitCode": -1,
            "detail": f"{entry.name} was not installed. The installer ran out of time and was stopped.",
        })

    exit_code = run.exit_code
    stdout = run.stdout

    if exit_code != 0:
        why = f"The installer exited {exit_code}."
        return JSONResponse({
            "installOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": why,
            "exitCode": exit_code,
            "stdout": stdout,
            "detail": f"{entry.name} was not installed. {why} {stdout[:300]}".strip(),
        })

    # Post-install verification — exit 0 is claim, probe is evidence
    probe_result = probe_node(node_id, refresh=True)
    if not probe_result.present:
        return JSONResponse({
            "installOutcome": "unverified",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": True,
            "command": plan.command,
            "why": f"The installer finished without an error, but {entry.name} still cannot be found on this machine.",
            "exitCode": 0,
            "stdout": stdout,
            "probe": probe_result_to_dict(probe_result),
            "detail": f"{entry.name} reported a successful install, but AURA still cannot find it, so it is NOT being reported as installed. {probe_result.detail}",
        })

    return JSONResponse({
        "installOutcome": "installed",
        "nodeId": node_id,
        "privilege": "user",
        "requiresUserAction": False,
        "command": plan.command,
        "why": f"{entry.name} is now installed and available.",
        "exitCode": 0,
        "stdout": stdout,
        "probe": probe_result_to_dict(probe_result),
        "detail": f"{entry.name} was successfully installed and verified.",
    })


async def environment_uninstall(request: Request):
    """Direct human uninstallation — removes software, then verifies absence.

    POST /environment/uninstall
    Body: { id: string }
    Returns: UninstallResult-like payload with uninstallOutcome, privilege,
             requiresUserAction, command, why, probe, detail, exitCode.

    Security: catalog-only, validated UninstallSpec derived from InstallSpec,
              allow-listed bin, argv-only, no shell, frontend sends id only.
    """
    from ..environment import (
        catalog_entry,
        is_uninstall_plan,
        plan_uninstall,
        probe_node,
        probe_result_to_dict,
    )
    from ..exec_ import INSTALL_TIMEOUT_MS, resolve_installer_binary

    body = await _environment_body(request)
    node_id = str(body.get("id") or body.get("nodeId") or "").strip()
    if not node_id:
        return JSONResponse({"error": "No node id was provided.", "uninstallOutcome": "failed", "detail": "No node id was provided."}, status_code=400)

    entry = catalog_entry(node_id)
    if entry is None:
        return JSONResponse({"error": f"'{node_id}' is not in the catalog.", "uninstallOutcome": "failed", "detail": f"'{node_id}' is not in the catalog."}, status_code=400)

    plan = plan_uninstall(entry)
    if not is_uninstall_plan(plan):
        return JSONResponse({
            "uninstallOutcome": "unavailable",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "detail": plan.reason,
            "why": plan.reason,
        }, status_code=400)

    if plan.privilege == "root":
        return JSONResponse({
            "uninstallOutcome": "guided",
            "nodeId": node_id,
            "privilege": "root",
            "requiresUserAction": True,
            "command": plan.command,
            "why": plan.why,
            "detail": f"{entry.name} needs administrator rights to remove, so AURA did not run anything. Run this yourself, then re-scan: {plan.command}",
        })

    resolved = resolve_installer_binary(plan.bin)
    if not resolved.ok:
        return JSONResponse({
            "uninstallOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": resolved.reason,
            "detail": f"{entry.name} could not be uninstalled: {resolved.reason}",
        }, status_code=400)

    from ..environment.executor import run_uninstall_plan

    run = await run_uninstall_plan(plan, timeout_ms=INSTALL_TIMEOUT_MS)

    if run.status in ("missing", "error"):
        return JSONResponse({
            "uninstallOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": run.error,
            "detail": f"{entry.name} could not be uninstalled: {run.error}",
        }, status_code=400)

    if run.status == "timeout":
        return JSONResponse({
            "uninstallOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": "The uninstaller ran out of time and was stopped.",
            "timedOut": True,
            "exitCode": -1,
            "detail": f"{entry.name} was not uninstalled. The uninstaller ran out of time and was stopped.",
        })

    exit_code = run.exit_code
    stdout = run.stdout

    if exit_code != 0:
        why = f"The uninstaller exited {exit_code}."
        return JSONResponse({
            "uninstallOutcome": "failed",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": False,
            "command": plan.command,
            "why": why,
            "exitCode": exit_code,
            "stdout": stdout,
            "detail": f"{entry.name} was not uninstalled. {why} {stdout[:300]}".strip(),
        })

    # Post-uninstall verification — exit 0 is claim, probe absence is evidence
    probe_result = probe_node(node_id, refresh=True)
    if probe_result.present:
        return JSONResponse({
            "uninstallOutcome": "unverified",
            "nodeId": node_id,
            "privilege": "user",
            "requiresUserAction": True,
            "command": plan.command,
            "why": f"The uninstaller finished without an error, but {entry.name} can still be found on this machine.",
            "exitCode": 0,
            "stdout": stdout,
            "probe": probe_result_to_dict(probe_result),
            "detail": f"{entry.name} reported a successful removal, but AURA can still find it, so it is NOT being reported as removed. {probe_result.detail}",
        })

    return JSONResponse({
        "uninstallOutcome": "uninstalled",
        "nodeId": node_id,
        "privilege": "user",
        "requiresUserAction": False,
        "command": plan.command,
        "why": f"{entry.name} is now removed.",
        "exitCode": 0,
        "stdout": stdout,
        "probe": probe_result_to_dict(probe_result),
        "detail": f"{entry.name} was successfully uninstalled and verified as absent.",
    })


async def environment_connect(request: Request):
    """Direct human connect — verifies usability, persists via ConnectedNodeStore.

    POST /environment/connect
    Body: { id: string }
    Returns: { connected: bool, result: ProbeResult, detail: string }
    """
    from ..environment import catalog_entry, probe_node, probe_result_to_dict

    body = await _environment_body(request)
    node_id = str(body.get("id") or body.get("nodeId") or "").strip()
    if not node_id:
        return JSONResponse({"error": "No node id was provided.", "connected": False}, status_code=400)

    entry = catalog_entry(node_id)
    if entry is None:
        return JSONResponse({"error": f"'{node_id}' is not in the catalog.", "connected": False}, status_code=400)

    # Internal nodes always connected
    if entry.transport == "internal":
        result = probe_node(node_id, refresh=True)
        return JSONResponse({
            "connected": True,
            "result": probe_result_to_dict(result),
            "detail": "Built into AURA Hub — always available.",
        })

    # Real verification: probe with refresh
    result = probe_node(node_id, refresh=True)
    if not result.present:
        return JSONResponse({
            "connected": False,
            "result": probe_result_to_dict(result),
            "detail": result.detail,
        })

    # Verify integration: for local-process, probe success means executable + version;
    # for http, probe already verified endpoint liveness. If present, consider drivable
    # unless we have explicit evidence otherwise. Persist verified connection.
    try:
        from ..persistence.nodes import ConnectedNodeStore

        nodes = ConnectedNodeStore()
        # Persist verified connection — register as connected node
        nodes.register(
            node_id,
            entry.name,
            list(entry.capabilities),
            internal=False,
            version=result.version or "",
        )
    except Exception as e:
        return JSONResponse({
            "connected": False,
            "result": probe_result_to_dict(result),
            "detail": f"Installed and found, but AURA could not persist the connection: {e}.",
        })

    return JSONResponse({
        "connected": True,
        "result": probe_result_to_dict(result),
        "detail": f"{entry.name} is connected and usable. {result.detail}",
    })
