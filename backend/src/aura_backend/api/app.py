"""HTTP application factory.

Routes are registered per subsystem as each one is migrated; contracts
mirror the TypeScript service (see docs/PYTHON_BACKEND_MIGRATION_MAP.md).
This factory is the composition root — the only place subsystems are
wired together, mirroring server.ts in the reference implementation.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..config import Settings
from ..core.errors import AuraError


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="AURA service (python)", version=__version__)
    app.state.settings = settings

    @app.exception_handler(AuraError)
    async def _aura_error(_request: Request, exc: AuraError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content=exc.payload())

    @app.get("/health")
    async def health() -> dict:
        return {
            "ok": True,
            "service": "aura",
            "backend": "python",
            "version": __version__,
            "shadow": settings.shadow_mode,
        }

    return app
