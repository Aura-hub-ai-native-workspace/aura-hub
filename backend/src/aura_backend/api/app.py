"""HTTP application factory.

Routes are registered per subsystem as each one is migrated; contracts
mirror the TypeScript service (see docs/PYTHON_BACKEND_MIGRATION_MAP.md).
This factory is the composition root — the only place subsystems are
wired together, mirroring server.ts in the reference implementation.

Boot order is load-bearing there and reproduced here as each phase lands.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..config import Settings
from ..core.errors import AuraError
from ..environment import EnvironmentScanner, NodeProjection
from ..fabric import ApprovalStore, AuditStore, CapabilityFabric, ServiceFabricHost, load_policy
from ..tools.executors import machine_executors
from ..tools.internal_executors import workspace_executors
from ..workspace import WorkspaceManager
from .routes import context as context_routes
from .routes import environment as environment_routes
from .routes import fabric as fabric_routes
from .routes import projects as project_routes


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="AURA service (python)", version=__version__)
    app.state.settings = settings

    # ── the single governance authority ──────────────────────────────
    # Constructed once, for the life of the process. Nothing in this
    # backend may cause an external effect except through it.
    #
    # The node projections are read at DECISION time rather than
    # construction time, so a node connected mid-session takes effect
    # immediately. They stay empty until Phase 8 supplies the environment
    # scanner — which means node-backed capabilities are denied with
    # `no-provider` rather than silently allowed.
    # The project registry. Everything that executes waits on this: it is
    # the only place a `cwd` comes from.
    workspace = WorkspaceManager(settings.home)
    app.state.workspace = workspace

    scanner = EnvironmentScanner()
    projection = NodeProjection()
    app.state.scanner = scanner
    app.state.node_projection = projection
    app.state.present_nodes = projection.present_nodes
    app.state.provided_node_capabilities = projection.provided_capabilities

    host = ServiceFabricHost(
        present_nodes=lambda: app.state.present_nodes(),
        provided_node_capabilities=lambda: app.state.provided_node_capabilities(),
    )
    fabric = CapabilityFabric(host)
    # The operator's saved caution settings outlive the process. Loaded
    # through the sanitizer, so a corrupt file degrades to the shipped
    # default instead of loosening anything.
    fabric.set_policy(load_policy(settings.home))
    # Pending gates outlive the process too: a question asked before a
    # restart is still waiting for its answer afterwards, with the same id.
    fabric.attach_approval_store(ApprovalStore(settings.home))
    # So does the trail. Without this, everything the Fabric governed is
    # forgotten on exit.
    fabric.attach_audit_store(AuditStore(settings.home))
    # The machine-facing executors. The ten AURA-internal ones need the
    # workspace manager (Phase 3) and are deliberately absent, so they
    # report `unsupported` — which is true — rather than being stubbed.
    for executor in machine_executors(scanner):
        fabric.register(executor)
    # Six of the ten AURA-internal executors. The other four need the
    # mission store, the knowledge graph and the workflow engine, and
    # report `unsupported` until those phases land.
    for executor in workspace_executors(workspace):
        fabric.register(executor)
    app.state.fabric = fabric
    app.state.run_scopes = host.run_scopes

    # Declared before the project routes: `/projects/{id}/context`
    # must not be shadowed by a broader `/projects/{id}` match,
    # mirroring the reference's literal-first segment cascade.
    app.include_router(context_routes.router)
    app.include_router(project_routes.router)
    app.include_router(environment_routes.router)
    app.include_router(fabric_routes.router)

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
