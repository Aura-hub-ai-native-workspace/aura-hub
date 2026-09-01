#!/usr/bin/env python3
"""Central Agent API host — verification harness entry point.

Runs the existing `aura.api.build_default_api` server as a long-lived
process so browser/UI verification suites can drive the real service.
This file adds NO backend behavior: it imports public constructors and
calls serve_forever, exactly as the tests do in-process.

    AURA_HOME=/tmp/... python3 scripts/serve_central_agent_api.py [port]
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4320
    home = os.environ.get("AURA_HOME")
    from aura.api import build_default_api

    server, _agent = build_default_api(home=home, port=port)
    print(f"CENTRAL_AGENT_READY {port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
