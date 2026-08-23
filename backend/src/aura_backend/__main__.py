"""Entry point: `python -m aura_backend`.

Refuses the port rather than fighting for it — if anything already
listens on the configured port, this process reports and exits. It never
kills the other process (the same rule the desktop shell follows).
"""

from __future__ import annotations

import socket
import sys

import uvicorn

from .api import create_app
from .config import load_settings


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main() -> int:
    settings = load_settings()
    if not _port_free(settings.port):
        print(
            f"aura-backend: port {settings.port} is already in use. "
            "Refusing to take it — the owning process is left alone. "
            "Stop it or choose another port (AURA_PY_PORT / AI_PORT).",
            file=sys.stderr,
        )
        return 1
    app = create_app(settings)
    role = "production" if not settings.shadow_mode else "shadow"
    print(f"aura-backend ({role}) listening on 127.0.0.1:{settings.port}, home={settings.home}")
    uvicorn.run(app, host="127.0.0.1", port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
