"""The `/projects/{id}/context` HTTP surface.

Contract-compatible with the context block in
packages/ai-service/src/server.ts.

Read-only, and explicitly project-scoped: the id in the path is the only
project any of this describes. The environment is handed in from the last
scan this process performed, so **reading context never triggers a new
one** — and never spawns a probe as a side effect of a GET.

An unresolvable project is 404 with the `unavailable` body, never an
empty view. A caller must not be able to read "no such project" as "a
project AURA knows nothing about".
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...context import (
    ComposeOptions,
    ContextSources,
    compose_context_view,
    is_unavailable,
    render_context_contract,
)
from ...intelligence import MissionReader

router = APIRouter(prefix="/projects", tags=["context"])


def context_sources(request: Request) -> ContextSources:
    """The one place the Context Fabric's inputs are assembled.

    Every one of them is an authority that already exists: the registry,
    the mission records, the Fabric, and the node projection's own
    snapshot of the last scan. Nothing here computes a fact of its own.
    """
    state = request.app.state
    home = state.settings.home
    return ContextSources(
        registry=state.workspace.registry,
        missions=MissionReader(home),
        home=home,
        # The project the workspace currently has open. Never changed
        # here: composing a context must not mount anything.
        mounted_project_id=state.workspace.current_project_id,
        fabric=state.fabric,
        environment=state.node_projection.snapshot(),
    )


def _options(request: Request) -> ComposeOptions:
    params = request.query_params
    return ComposeOptions(
        surface=params.get("surface") or "general",
        # Any value other than the literal `false` reads git, matching the
        # reference's `!== 'false'`.
        include_git=params.get("git") != "false",
    )


@router.get("/{project_id}/context/contract")
async def contract(project_id: str, request: Request) -> Any:
    """The agent-facing text contract."""
    options = _options(request)
    view = compose_context_view(project_id, context_sources(request), options)
    if is_unavailable(view):
        return JSONResponse(
            status_code=404,
            content={"error": f'no project is registered with id "{project_id}"'},
        )
    return {
        "projectId": project_id,
        "surface": options.surface,
        "contract": render_context_contract(view),
    }


@router.get("/{project_id}/context")
async def view(project_id: str, request: Request) -> Any:
    result = compose_context_view(project_id, context_sources(request), _options(request))
    if is_unavailable(result):
        return JSONResponse(status_code=404, content=result.to_json())
    return result.to_json()
