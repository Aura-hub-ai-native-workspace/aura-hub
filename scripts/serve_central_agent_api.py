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
    python3 scripts/serve_central_agent_api.py --check   # imports only

The port defaults to 4320, matching ``service::PYTHON_PORT`` in the
desktop shell and ``ENVIRONMENT_BASE`` in the renderer.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

DEFAULT_PORT = 4320


def bundled_paths(root: Path) -> list[Path]:
    """Vendored dependency directories for the RUNNING interpreter, in order.

    A packaged AURA carries Starlette, uvicorn and Pydantic beside this
    script so the machine needs no Python setup of its own. Two directories,
    because the dependencies are not the same kind of thing:

    ``site-packages`` is pure Python and imports on any interpreter.

    ``abi/cp313`` and its siblings hold ``pydantic_core``, a compiled
    extension whose wheel is built against one CPython version and refuses
    to load into another. The build stages one directory per supported
    version; this picks the one matching whoever is running rather than
    hoping a single copy fits. An interpreter with no matching directory
    gets none and fails on a plain missing import, which is a better error
    than a mismatched binary's ``undefined symbol``.

    Absent directories are normal: a source checkout vendors nothing and
    falls through to whatever is already installed on the machine.
    """
    tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    return [p for p in (root / "abi" / tag, root / "site-packages") if p.is_dir()]


# Prepended so a packaged AURA runs the versions it shipped with rather than
# whatever the host happens to have. Resolved relative to this script, so it
# follows the application wherever it is installed.
for _bundled in reversed(bundled_paths(Path(__file__).resolve().parents[1])):
    sys.path.insert(0, str(_bundled))


def main() -> int:
    argv = sys.argv[1:]

    # `--check` is the desktop shell's pre-flight. It asks the question the
    # shell actually needs answered — "can THIS interpreter import the
    # backend?" — by running the imports through the very path setup above,
    # so a candidate is accepted on the same terms it will later run on.
    # Doing it here rather than in the shell keeps one copy of the vendored
    # path rules; a Rust-side re-implementation would be free to drift, and
    # the failure mode of that drift is every interpreter on the machine
    # being rejected while the backend would have started fine.
    if argv and argv[0] == "--check":
        import starlette  # noqa: F401
        import uvicorn
        from aura.api.server import create_app

        return 0

    port = int(argv[0]) if argv else DEFAULT_PORT

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
