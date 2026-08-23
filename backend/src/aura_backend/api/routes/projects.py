"""The `/projects/*` HTTP surface.

Contract-compatible with packages/ai-service/src/server.ts.

Route order matters and is declared literal-first, because the reference
is a hand-written segment cascade in which earlier blocks shadow later
ones. FastAPI matches in declaration order, so `/projects/{id}/open` must
be declared before `/projects/{id}`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...workspace.projects import ProjectNotFound, ProjectRejected

router = APIRouter(prefix="/projects", tags=["projects"])


def _manager(request: Request):
    return request.app.state.workspace


@router.get("")
async def list_projects(request: Request) -> dict[str, Any]:
    manager = _manager(request)
    current = manager.current_project()
    return {
        "projects": [p.to_json() for p in manager.list_projects()],
        "current": current.to_json() if current else None,
    }


@router.post("")
async def add_project(request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    try:
        result = _manager(request).add_project(
            path=str(body.get("path") or ""),
            name=body.get("name"),
            icon=body.get("icon"),
        )
    except (ProjectRejected, OSError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return result.to_json()


@router.post("/{project_id}/open")
async def open_project(project_id: str, request: Request) -> Any:
    try:
        result = _manager(request).open(project_id)
    except KeyError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc).strip("'")})
    return result.to_json()


@router.get("/{project_id}/profile")
async def project_profile(project_id: str, request: Request) -> Any:
    profile = _manager(request).profile(project_id)
    if profile is None:
        return JSONResponse(status_code=404, content={"error": "no profile"})
    return profile.to_json()


# ── memory ───────────────────────────────────────────────────────────


@router.get("/{project_id}/memory")
async def list_memory(project_id: str, request: Request) -> dict[str, Any]:
    return {"items": _manager(request).list_memory(project_id)}


@router.post("/{project_id}/memory")
async def add_memory(project_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    return _manager(request).add_memory(
        project_id,
        kind=body.get("kind") or "conversation",
        title=str(body.get("title") or ""),
        body=str(body.get("body") or ""),
        pinned=bool(body.get("pinned")),
    )


@router.post("/{project_id}/memory/{item_id}/pin")
async def pin_memory(project_id: str, item_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    item = _manager(request).pin_memory(project_id, item_id, bool(body.get("pinned")))
    if item is None:
        return JSONResponse(status_code=404, content={"error": "no such memory"})
    return item


@router.delete("/{project_id}/memory/{item_id}")
async def remove_memory(project_id: str, item_id: str, request: Request) -> dict[str, Any]:
    return {"ok": _manager(request).remove_memory(project_id, item_id)}


# ── conversations ────────────────────────────────────────────────────


@router.get("/{project_id}/conversations")
async def list_conversations(project_id: str, request: Request) -> dict[str, Any]:
    return {"conversations": _manager(request).conversations_of(project_id).list()}


@router.post("/{project_id}/conversations")
async def create_conversation(project_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    return _manager(request).conversations_of(project_id).create(body.get("title")).to_json()


@router.get("/{project_id}/conversations/{conversation_id}")
async def get_conversation(project_id: str, conversation_id: str, request: Request) -> Any:
    conversation = _manager(request).conversations_of(project_id).get(conversation_id)
    if conversation is None:
        return JSONResponse(status_code=404, content={"error": "no such conversation"})
    return conversation.to_json()


@router.api_route("/{project_id}/conversations/{conversation_id}", methods=["PATCH", "POST"])
async def rename_conversation(project_id: str, conversation_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    conversation = (
        _manager(request)
        .conversations_of(project_id)
        .rename(conversation_id, str(body.get("title") or ""))
    )
    if conversation is None:
        return JSONResponse(status_code=404, content={"error": "no such conversation"})
    return conversation.to_json()


@router.delete("/{project_id}/conversations/{conversation_id}")
async def remove_conversation(
    project_id: str, conversation_id: str, request: Request
) -> dict[str, Any]:
    return {"ok": _manager(request).conversations_of(project_id).remove(conversation_id)}


@router.post("/{project_id}/conversations/{conversation_id}/message")
async def append_message(project_id: str, conversation_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    message = (
        _manager(request)
        .conversations_of(project_id)
        .append(
            conversation_id,
            role="assistant" if body.get("role") == "assistant" else "user",
            content=str(body.get("content") or ""),
            meta=body.get("meta"),
            error=bool(body.get("error")),
        )
    )
    # 200 with an error body, matching the reference: appending to a
    # conversation that vanished is not a transport failure.
    return message.to_json() if message else {"error": "no such conversation"}


@router.delete("/{project_id}/conversations/{conversation_id}/message/last")
async def remove_last_assistant(
    project_id: str, conversation_id: str, request: Request
) -> dict[str, Any]:
    manager = _manager(request)
    return {"ok": manager.conversations_of(project_id).remove_last_assistant(conversation_id)}


# ── the parameterised project routes come LAST ───────────────────────


@router.api_route("/{project_id}", methods=["PATCH", "POST"])
async def update_project(project_id: str, request: Request) -> Any:
    body = await request.json() if await request.body() else {}
    manager = _manager(request)
    record = manager.registry.get(project_id)
    if record is None:
        return JSONResponse(status_code=404, content={"error": "no such project"})
    try:
        if isinstance(body.get("name"), str):
            record = manager.rename_project(project_id, body["name"])
        if isinstance(body.get("favorite"), bool):
            record = manager.set_favorite(project_id, body["favorite"])
    except (ProjectNotFound, ProjectRejected) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return record.to_json()


@router.delete("/{project_id}")
async def remove_project(project_id: str, request: Request) -> dict[str, Any]:
    return {"ok": _manager(request).remove_project(project_id)}
