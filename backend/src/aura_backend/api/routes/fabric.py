"""The `/fabric/*` HTTP surface.

Contract-compatible with packages/ai-service/src/server.ts.

Two conventions from the reference are load-bearing and reproduced
exactly:

  * `POST /fabric/invoke` always answers **200**, even on a denial. A
    denial is a governance OUTCOME, not an HTTP failure, and turning it
    into a 403 would make a refusal indistinguishable from a transport
    error.
  * `POST /fabric/approvals/{id}/decide` answers **409** when the request
    was already decided, so a double-click, a replayed request or a stale
    browser tab is harmless rather than a second authorization.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...fabric import CAPABILITY_MANIFEST, CapabilityFabric, InvocationActor, InvocationContext
from ...fabric.stores import policy_file_path, save_policy
from ...policy import PolicyConfig

router = APIRouter(prefix="/fabric", tags=["fabric"])

# Only these keys can reach the policy engine. An unknown key in the
# request body can never become configuration — the merge is an
# allow-list, not a spread.
_POLICY_FIELDS = ("byRisk", "overrides", "nodeOverrides", "nodeAllowlists", "allowAutonomous")


def _policy_json(policy: PolicyConfig) -> dict[str, Any]:
    return {
        "byRisk": {k.value: v.value for k, v in policy.by_risk.items()},
        "overrides": {k: v.value for k, v in policy.overrides.items()},
        "nodeOverrides": {k: v.value for k, v in policy.node_overrides.items()},
        "nodeAllowlists": policy.node_allowlists,
        "allowAutonomous": policy.allow_autonomous,
    }


def _capability_json(capability, supported: bool) -> dict[str, Any]:
    return {
        "id": capability.id,
        "name": capability.name,
        "description": capability.description,
        "category": capability.category,
        "surface": capability.surface,
        "risk": capability.risk.value,
        "permissions": [p.value for p in capability.permissions],
        "output": capability.output,
        "verify": capability.verify,
        "requiresNodeCapability": capability.requires_node_capability,
        "irreversible": capability.irreversible,
        "input": [
            {
                "name": f.name,
                "type": f.type,
                "required": f.required,
                "description": f.description,
            }
            for f in capability.input
        ],
        "supported": supported,
    }


def _fabric(request: Request) -> CapabilityFabric:
    return request.app.state.fabric


@router.get("/capabilities")
async def capabilities(request: Request) -> dict[str, Any]:
    fabric = _fabric(request)
    provided = request.app.state.provided_node_capabilities()
    entries = [_capability_json(c, fabric.is_supported(c.id)) for c in CAPABILITY_MANIFEST]
    return {
        "capabilities": entries,
        "supportedCount": sum(1 for e in entries if e["supported"]),
        "providedNodeCapabilities": sorted(provided),
        "policy": _policy_json(fabric.get_policy()),
    }


@router.get("/audit")
async def audit(request: Request) -> dict[str, Any]:
    return {"audit": [r.to_json() for r in _fabric(request).audit()]}


@router.post("/policy")
async def set_policy(request: Request) -> dict[str, Any]:
    body = await request.json() if await request.body() else {}
    fabric = _fabric(request)
    current = _policy_json(fabric.get_policy())
    merged = {**current, **{k: body[k] for k in _POLICY_FIELDS if k in body}}
    stored = save_policy(request.app.state.settings.home, merged)
    fabric.set_policy(stored)
    return {
        "policy": _policy_json(stored),
        "file": str(policy_file_path(request.app.state.settings.home)),
    }


@router.get("/approvals")
async def approvals(request: Request) -> dict[str, Any]:
    return {"approvals": [r.to_json() for r in _fabric(request).pending_approvals()]}


@router.post("/approvals/{approval_id}/decide")
async def decide(approval_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    fabric = _fabric(request)

    existing = fabric.approval_by_id(approval_id)
    if existing is None:
        return JSONResponse(status_code=404, content={"error": "no such approval request"})
    if existing.state != "pending":
        # Already answered. Carrying the approval back lets the caller see
        # what the answer was without guessing.
        return JSONResponse(
            status_code=409,
            content={
                "error": "this request has already been decided",
                "approval": existing.to_json(),
            },
        )

    decided = fabric.decide_approval(
        approval_id,
        bool(body.get("granted")),
        body.get("decidedBy", "user"),
        body.get("reason"),
    )
    if decided is None:
        return JSONResponse(status_code=409, content={"error": "no longer pending"})
    # Resuming the parked work is the caller's job in this phase; the
    # mission and workflow engines that own that arrive in later phases.
    return {"approval": decided.to_json(), "resumed": False}


@router.post("/invoke")
async def invoke(request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    capability_id = body.get("capabilityId")
    if not capability_id or not isinstance(capability_id, str):
        return JSONResponse(status_code=400, content={"error": "capabilityId is required"})

    raw_context = body.get("context") or {}
    raw_input = body.get("input") or {}
    actor = raw_context.get("actorKind") or "agent"
    project_id = raw_context.get("projectId")

    context = InvocationContext(
        actor=InvocationActor(kind=actor, id=raw_context.get("actorId") or "api"),
        project_id=project_id,
        # `cwd` is resolved from the project registry by the host, never
        # taken from the request body. Phase 3 owns that registry; until
        # then a caller cannot supply one at all.
        cwd=None,
        mission_id=raw_context.get("missionId"),
        task_id=raw_context.get("taskId"),
        workflow_id=raw_context.get("workflowId"),
        run_id=raw_context.get("runId"),
        workflow_node_id=raw_context.get("workflowNodeId"),
        timeout_ms=raw_context.get("timeoutMs"),
        approved_capabilities=tuple(body.get("approvedCapabilities") or ()),
        # Accepted from the context or, as a compatibility alias, the input
        # position. Dropping the alias would mean a caller who named a node
        # silently got a different one.
        node_id=raw_context.get("nodeId") or raw_input.get("nodeId"),
    )

    result = await _fabric(request).invoke(capability_id, raw_input, context)
    # Always 200: a denial is an outcome, not a transport failure.
    return result.to_json()
