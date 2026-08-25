"""Canonical Python HTTP/SSE server — Starlette.

Replaces ai-service/src/server.ts as the SOLE production backend.
CORS restricted to the frozen ALLOWED_ORIGIN regex. SSE streams use
text/event-stream with the same framing as the TS oracle.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from ..config import aura_home
from ..jsonutil import dumps_compact, read_json_file, write_json_atomic
from ..fabric import describe_capability
from ..policy import sanitize_policy, evaluate_policy, grants_for, CapabilityDescriptor, PolicyInput, PolicySubject
from ..persistence.workflows import WorkflowStore
from ..persistence.runs import WorkflowRunStore
from ..persistence.versions import WorkflowVersionStore
from ..persistence.automation import AutomationStore
from ..secrets import SecretStore as AuraSecrets
from ..workflow.runner import WorkflowRunner
from ..workflow.scheduler_seam import fire_scheduled_workflow

ALLOWED_ORIGIN = re.compile(
    r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost)$"
)

MSGS = {
    "awaiting-approval": "waiting on your authorization",
    "denied": "policy refused a tool call",
}


def _err(msg: str, status: int = 400):
    return JSONResponse({"error": msg}, status_code=status)


def create_api_server(*, fabric=None, run_scopes=None, secrets_store=None) -> Starlette:
    wf_store = WorkflowStore()
    ver_store = WorkflowVersionStore()
    run_store = WorkflowRunStore()
    auto_store = AutomationStore()

    runner = WorkflowRunner(
        fabric=fabric, run_scopes=run_scopes or RunScopeRegistry(),
        versions=ver_store, runs=run_store,
        secrets=secrets_store,
    )
    runner.workflows = wf_store  # for automation action handler

    async def health(request: Request):
        return JSONResponse({
            "health": {"status": "ok", "backend": "python"},
            "key": {"configured": bool(secrets_store)},
            "index": {"status": "ready"},
            "project": None,
        })

    async def workflow_list(request: Request):
        return JSONResponse(wf_store.list())

    async def workflow_get(request: Request):
        wid = request.path_params["wid"]
        wf = wf_store.get(wid)
        if not wf:
            return _err(f'No workflow stored under "{wid}".', 404)
        return JSONResponse(wf)

    async def workflow_create(request: Request):
        body = await request.json()
        wf = wf_store.create(body)
        return JSONResponse(wf)

    async def workflow_save(request: Request):
        wid = request.path_params["wid"]
        body = await request.json()
        result = wf_store.save(wid, body)
        if not result:
            return _err("not found", 404)
        return JSONResponse(result)

    async def workflow_delete(request: Request):
        wid = request.path_params["wid"]
        ok = wf_store.remove(wid)
        ver_store.remove_all(wid)
        run_store.remove_all(wid)
        return JSONResponse({"ok": ok})

    async def workflow_run(request: Request):
        wid = request.path_params["wid"]
        wf = wf_store.get(wid)
        if not wf:
            return _err(f"No workflow stored under \"{wid}\".", 404)
        body = await request.json() if request.headers.get("content-type") == "application/json" else {}
        project_path = body.get("projectPath") or str(aura_home())
        trigger = {"kind": "manual", "by": body.get("by", "user")}
        started = await runner.start_workflow_run(
            wf, project_id=body.get("projectId", "default"),
            project_path=project_path,
            trigger=trigger, inputs=body.get("inputs"))
        return JSONResponse({
            "run": started["run"], "result": started["result"],
            "versionId": started["version"]["id"],
        })

    async def workflow_dryrun(request: Request):
        wid = request.path_params["wid"]
        wf = wf_store.get(wid)
        if not wf:
            return _err(f"No workflow stored under \"{wid}\".", 404)
        from ..workflow.dryrun import dry_run_workflow
        report = dry_run_workflow({
            "workflowId": wid, "workflowName": wf.get("name", ""),
            "projectId": "dry-run", "projectPath": str(aura_home()),
            "fabric": fabric, "secrets": secrets_store, **wf,
        })
        report.pop("at", None)
        return JSONResponse(report)

    async def workflow_versions(request: Request):
        wid = request.path_params["wid"]
        return JSONResponse(ver_store.list(wid))

    async def runs_list(request: Request):
        return JSONResponse({"runs": run_store.list()})

    async def run_get(request: Request):
        rid = request.path_params["rid"]
        found = run_store.find(rid)
        if not found:
            return _err("not found", 404)
        return JSONResponse(found)

    async def fabric_capabilities(request: Request):
        caps = describe_capability.__globals__.get("_BY_ID", {})
        return JSONResponse(list(caps.values()))

    async def fabric_policy(request: Request):
        from ..fabric.policy import DEFAULT_POLICY
        policy_file = aura_home() / "fabric-policy.json"
        policy = read_json_file(policy_file, DEFAULT_POLICY)
        return JSONResponse(policy)

    async def automation_rules(request: Request):
        from ..persistence.automation import AutomationStore as AS
        s = AS()
        return JSONResponse(s.list_rules())

    async def automation_runs(request: Request):
        from ..persistence.automation import AutomationStore as AS
        s = AS()
        return JSONResponse(s.index_runs({}))

    async def secrets_list(request: Request):
        store = AuraSecrets()
        return JSONResponse(store.list())

    async def sse_workflow_events(request: Request):
        """SSE stream — emits RunEvent frames then [DONE]."""
        async def gen():
            yield f"data: {dumps_compact({'type': 'start'})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    # routes -----------------------------------------------------------------
    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/workflows", workflow_list, methods=["GET"]),
        Route("/workflows", workflow_create, methods=["POST"]),
        Route("/workflows/{wid}", workflow_get, methods=["GET"]),
        Route("/workflows/{wid}", workflow_save, methods=["PUT"]),
        Route("/workflows/{wid}", workflow_delete, methods=["DELETE"]),
        Route("/workflows/{wid}/run", workflow_run, methods=["POST"]),
        Route("/workflows/{wid}/dry-run", workflow_dryrun, methods=["POST"]),
        Route("/workflows/{wid}/versions", workflow_versions, methods=["GET"]),
        Route("/runs", runs_list, methods=["GET"]),
        Route("/runs/{rid}", run_get, methods=["GET"]),
        Route("/fabric/capabilities", fabric_capabilities, methods=["GET"]),
        Route("/fabric/policy", fabric_policy, methods=["GET"]),
        Route("/automation/rules", automation_rules, methods=["GET"]),
        Route("/automation/runs", automation_runs, methods=["GET"]),
        Route("/secrets", secrets_list, methods=["GET"]),
        Route("/events/workflow", sse_workflow_events, methods=["GET"]),
    ]

    app = Starlette(
        routes=routes,
        middleware=[Middleware(CORSMiddleware,
                               allow_origins=["http://localhost:*", "tauri://localhost",
                                              "https://tauri.localhost", "http://127.0.0.1:*"],
                               allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                               allow_headers=["Content-Type", "x-aura-shutdown"])])
    app.state.runner = runner
    app.state.wf_store = wf_store
    app.state.ver_store = ver_store
    app.state.run_store = run_store
    app.state.secrets = secrets_store
    return app


def create_app(**kwargs) -> Starlette:
    """Public factory."""
    return create_api_server(**kwargs)


# RunScopeRegistry re-import for callers
from ..fabric.scopes import RunScopeRegistry  # noqa: E402
