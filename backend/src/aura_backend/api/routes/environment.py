"""The `/environment/*` HTTP surface.

Contract-compatible with packages/ai-service/src/server.ts.

The security property worth restating at the transport boundary: a probe
command comes from the catalogue entry looked up by id, never from the
request. `POST /environment/probe` takes an `id` and nothing else that
reaches a process.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...environment.catalog import CATALOG, CatalogEntry

router = APIRouter(prefix="/environment", tags=["environment"])


def _entry_json(entry: CatalogEntry) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": entry.id,
        "name": entry.name,
        "category": entry.category,
        "capabilities": list(entry.capabilities),
        "transport": entry.transport,
        "auth": entry.auth,
        "license": entry.license,
        "crossPlatform": entry.cross_platform,
        "maintained": entry.maintained,
        "summary": entry.summary,
        "homepage": entry.homepage,
    }
    if entry.probe is not None:
        out["probe"] = {"command": entry.probe.command, "args": list(entry.probe.args)}
    if entry.endpoint is not None:
        out["endpoint"] = entry.endpoint
    if entry.install is not None:
        install: dict[str, Any] = {
            "method": entry.install.method,
            "package": entry.install.package,
            "privilege": entry.install.privilege,
        }
        if entry.install.distro:
            install["distro"] = entry.install.distro
        out["install"] = install
    return out


@router.get("/catalog")
async def catalog() -> dict[str, Any]:
    return {"catalog": [_entry_json(e) for e in CATALOG]}


@router.post("/scan")
async def scan(request: Request) -> dict[str, Any]:
    body = await request.json() if await request.body() else {}
    ids = body.get("ids") or None
    refresh = bool(body.get("refresh"))

    result = await request.app.state.scanner.scan(ids, refresh)
    # A targeted scan merges; a full scan replaces. See
    # environment/projection.py for why the reference's assign-not-merge
    # is a bug rather than a contract.
    request.app.state.node_projection.apply(result, targeted=bool(ids))

    return {
        **result.to_json(),
        "providedCapabilities": sorted(request.app.state.provided_node_capabilities()),
    }


@router.post("/probe")
async def probe(request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    node_id = body.get("id")
    if not node_id or not isinstance(node_id, str):
        return JSONResponse(status_code=400, content={"error": "id is required"})
    result = await request.app.state.scanner.probe_node(node_id, bool(body.get("refresh")))
    return {"id": node_id, "result": result.to_json()}
