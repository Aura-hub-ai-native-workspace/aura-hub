#!/usr/bin/env python3
"""Canonical Python API host — the desktop's Environment backend.

Runs the Starlette application from :mod:`aura.api.server`, which is the
ONE production Python API surface: workflows, the Capability Fabric, the
central agent AND every ``/environment`` route (scan, inventory, probe,
install, connect).

This file used to start ``aura.api.build_default_api`` instead. That is a
Central-Agent-only host from before the Environment routes existed: it
answers ``/health`` and ``/fabric/capabilities`` — so it looks like a
healthy AURA backend to anything fingerprinting the port — while
``/environment/inventory`` 404s. A desktop pointed at it showed an empty
Machine Inventory with nothing obviously wrong, which is precisely the
failure this repository refuses to ship.

    AURA_HOME=/tmp/... python3 scripts/serve_central_agent_api.py [port]

The port defaults to 4320, matching ``service::PYTHON_PORT`` in the
desktop shell and ``ENVIRONMENT_BASE`` in the renderer.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

DEFAULT_PORT = 4320


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

    import uvicorn
    from aura.api.server import create_app

    app = create_app()
    # Printed only after the application has been CONSTRUCTED. Construction
    # is what reads persisted state, so a store this host cannot load fails
    # here — visibly, before anything claims to be ready — rather than
    # leaving a supervisor waiting on a port that will never open.
    print(f"AURA_PYTHON_API_READY {port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
