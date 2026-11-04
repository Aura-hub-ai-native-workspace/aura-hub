"""http.request reports what the server answered, and only a success is
verified (F-15).

The executor returns a non-2xx answer as a result (as Node's fetch does), not
as an error. The register once described that as a false success. Through the
real fabric it is not: the request ran, but its status check fails, so the
invocation is `unverified`, never `succeeded`, and the output keeps the real
status and body for the caller. Pinned here so it cannot drift into a success.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from aura.fabric import FabricConfig, builtin_executors, invoke_fabric


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code = int(self.path.strip("/") or 200)
        body = f"answer {code}".encode()
        self.send_response(code)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture()
def server():
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture()
def fabric(tmp_path, monkeypatch):
    from aura.audit import AuditStore
    from aura.fabric import CapabilityFabric, FabricHost

    class Host(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True

    home = tmp_path / "home"
    monkeypatch.setenv("AURA_HOME", str(home))
    audit = AuditStore(home / "audit" / "trail.jsonl")
    fab = CapabilityFabric(Host())
    fab.attach_audit_store(audit.load, audit.append)
    execs = builtin_executors(home)
    for exe in execs.values():
        try:
            fab.register(exe)
        except Exception:
            pass
    return FabricConfig(fabric=fab, policy_config={}, permissions={"read": True, "write": True},
                        executors=execs, audit_store=audit), tmp_path


def _call(fabric, url):
    cfg, cwd = fabric
    return invoke_fabric("http.request", {"url": url},
                         {"cwd": str(cwd), "actor": {"kind": "agent", "id": "test"}}, cfg)


def test_a_success_status_is_verified(fabric, server):
    result = _call(fabric, f"{server}/200")
    assert result["outcome"] == "succeeded"
    assert result["verification"]["passed"] is True
    assert result["output"]["status"] == 200


@pytest.mark.parametrize("code", [400, 404, 500, 503])
def test_a_non_success_status_runs_but_is_never_a_success(fabric, server, code):
    result = _call(fabric, f"{server}/{code}")
    assert result["outcome"] == "unverified"
    assert result["verification"]["passed"] is False
    assert "did not confirm" in result["detail"]
    assert result["output"]["status"] == code          # the real answer is kept
    assert result["output"]["text"] == f"answer {code}"


def test_an_unreachable_server_is_a_failure_not_a_status(fabric):
    result = _call(fabric, "http://127.0.0.1:9/never")
    assert result["outcome"] == "failed"
