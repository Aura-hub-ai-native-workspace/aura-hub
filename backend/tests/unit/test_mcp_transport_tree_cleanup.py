"""Closing an MCP stdio client ends the server's whole process tree.

`close()` terminated only the server process it launched. Servers are often a
launcher (`npx`, `uvx`, a shell wrapper) that starts the real worker; closing
the client left that worker running, holding its ports and the project files,
and repeated connect/close cycles accumulated them. The server is started in its
own session, so the group can be swept.

POSIX only: Windows has no process groups to signal (see the platform audit,
`docs/audit/evidence/cross-platform/`).
"""
from __future__ import annotations

import os
import sys
import time

import pytest

from aura.central_agent import mcp_transport as mt

pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX process groups")

SERVER = r"""
import subprocess, sys
child = subprocess.Popen(["sleep", "300"])
open(sys.argv[1], "w").write(str(child.pid))
for _ in sys.stdin:      # a polite server: exits when its stdin closes
    pass
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:  # a zombie is dead for this purpose
        return open(f"/proc/{pid}/stat").read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


def _client(tmp_path):
    marker = tmp_path / "worker.pid"
    cls = next(c for n, c in vars(mt).items() if n.endswith("Client") and hasattr(c, "close"))
    client = cls([sys.executable, "-c", SERVER, str(marker)], cwd=str(tmp_path), timeout_s=5)
    for _ in range(100):
        if marker.exists() and marker.read_text().strip():
            break
        time.sleep(0.05)
    return client, int(marker.read_text())


def test_close_ends_the_workers_the_server_started(tmp_path):
    client, worker = _client(tmp_path)
    try:
        assert _alive(worker)
        client.close()
        for _ in range(100):
            if not _alive(worker):
                break
            time.sleep(0.05)
        assert not _alive(worker), "the server's worker outlived close()"
    finally:
        try:
            os.kill(worker, 9)
        except ProcessLookupError:
            pass
