"""http.request destination policy (F-20).

With the human approval gone, an autonomous plan could send any method to any
loopback or private-network service, for example an unauthenticated local
model server's delete call. Now an autonomous request (actor kind other than
"human", or no actor) may only GET or HEAD there. GET and HEAD are not claimed
to be side-effect free; they are the narrowest methods that keep read access.

The check runs on the address actually connected to, so a name that resolves to
a private address, a mixed DNS answer and a redirect cannot get around it.
Cloud metadata addresses are refused for every actor, after resolution too.
"""

from __future__ import annotations

import asyncio
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aura.executors import http_policy, http_request

HITS: list[tuple[str, str]] = []


class _Handler(BaseHTTPRequestHandler):
    def _answer(self):
        HITS.append((self.command, self.path))
        if self.path.startswith("/redir?"):
            self.send_response(302)
            self.send_header("location", self.path.split("to=", 1)[1])
            self.send_header("content-length", "0")
            self.end_headers()
            return
        body = b"" if self.command == "HEAD" else b"served"
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = _answer

    def log_message(self, *args):
        pass


@pytest.fixture()
def server():
    HITS.clear()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", srv.server_address[1]
    srv.shutdown()


AGENT = {"kind": "agent", "id": "central-agent"}
HUMAN = {"kind": "human", "id": "user"}


def _run(url, method="GET", actor=AGENT, body=None, omit_actor=False):
    context = {} if omit_actor else {"actor": actor}
    inv = {"input": {"url": url, "method": method, **({"body": body} if body is not None else {})},
           "context": context}
    return asyncio.run(http_request(inv))


# ── what an autonomous request may and may not do ──────────────────────────

@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_an_agent_can_read_a_local_service(server, method):
    base, _ = server
    result = _run(f"{base}/models", method)
    assert result["ok"] is True, result
    assert HITS == [(method, "/models")]


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_an_agent_cannot_change_a_local_service(server, method):
    base, _ = server
    result = _run(f"{base}/api/delete", method, body="{}")
    assert result["ok"] is False
    assert "GET or HEAD" in result["detail"]
    assert HITS == []          # nothing was sent: refused before the request


def test_a_missing_actor_is_treated_as_autonomous(server):
    base, _ = server
    assert _run(f"{base}/x", "POST", omit_actor=True)["ok"] is False
    assert HITS == []


@pytest.mark.parametrize("actor", [{"kind": "service", "id": "x"}, {"id": "no-kind"}, None, "human"])
def test_only_an_explicit_human_actor_is_exempt(server, actor):
    base, _ = server
    assert _run(f"{base}/x", "POST", actor=actor)["ok"] is False
    assert HITS == []


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_a_user_initiated_request_is_not_limited(server, method):
    base, _ = server
    result = _run(f"{base}/api/thing", method, actor=HUMAN, body="{}")
    assert result["ok"] is True, result
    assert HITS == [(method, "/api/thing")]


# ── name resolution and redirects cannot get around it ─────────────────────

def _resolves(monkeypatch, mapping):
    real = socket.getaddrinfo
    calls: list[str] = []

    def fake(host, port, *a, **kw):
        if host in mapping:
            calls.append(host)
            return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "",
                     (ip, port) if ":" not in ip else (ip, port, 0, 0)) for ip in mapping[host]]
        return real(host, port, *a, **kw)

    monkeypatch.setattr(http_policy.socket, "getaddrinfo", fake)
    return calls


def test_a_name_that_resolves_to_loopback_is_judged_by_the_address(server, monkeypatch):
    base, port = server
    _resolves(monkeypatch, {"internal.test": ["127.0.0.1"]})
    assert _run(f"http://internal.test:{port}/x", "POST")["ok"] is False
    assert HITS == []
    assert _run(f"http://internal.test:{port}/x", "GET")["ok"] is True
    assert HITS == [("GET", "/x")]


def test_a_mixed_dns_answer_is_refused_for_unsafe_methods(server, monkeypatch):
    _, port = server
    _resolves(monkeypatch, {"mixed.test": ["93.184.216.34", "127.0.0.1"]})
    result = _run(f"http://mixed.test:{port}/x", "POST")
    assert result["ok"] is False
    assert HITS == []


def test_the_name_is_resolved_once_and_that_answer_is_what_is_connected(server, monkeypatch):
    """No second lookup between the check and the connection (rebinding)."""
    _, port = server
    calls = _resolves(monkeypatch, {"once.test": ["127.0.0.1"]})
    assert _run(f"http://once.test:{port}/x", "GET")["ok"] is True
    assert calls == ["once.test"]


@pytest.mark.parametrize("actor", [AGENT, HUMAN])
def test_a_name_that_resolves_to_cloud_metadata_is_refused_for_everyone(monkeypatch, actor):
    _resolves(monkeypatch, {"meta.test": ["169.254.169.254"]})
    result = _run("http://meta.test/latest/meta-data/", "GET", actor=actor)
    assert result["ok"] is False
    assert "metadata" in result["detail"]


@pytest.mark.parametrize("actor", [AGENT, HUMAN])
def test_a_redirect_to_cloud_metadata_is_refused(server, actor):
    base, _ = server
    result = _run(f"{base}/redir?to=http://169.254.169.254/latest/meta-data/", "GET", actor=actor)
    assert result["ok"] is False
    assert "metadata" in result["detail"]
    assert HITS == [("GET", "/redir?to=http://169.254.169.254/latest/meta-data/")]


def test_a_redirect_to_a_non_http_scheme_is_refused(server):
    base, _ = server
    result = _run(f"{base}/redir?to=file:///etc/passwd", "GET")
    # Not followed: the caller gets the redirect status, never the file.
    assert result["output"]["status"] == 302
    assert "root:" not in str(result)
    assert len(HITS) == 1


def test_a_redirect_between_local_services_is_still_a_read(server):
    base, port = server
    result = _run(f"{base}/redir?to={base}/landed", "GET")
    assert result["ok"] is True
    assert [h[1] for h in HITS] == [f"/redir?to={base}/landed", "/landed"]


def test_proxy_settings_do_not_hide_the_destination_from_an_agent(server, monkeypatch):
    base, _ = server
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    assert _run(f"{base}/x", "GET")["ok"] is True
    assert HITS == [("GET", "/x")]


# ── address classes ────────────────────────────────────────────────────────

NON_PUBLIC = ["127.0.0.1", "127.8.8.8", "::1", "10.0.0.5", "172.16.1.1", "192.168.1.1",
              "169.254.1.1", "100.64.0.1", "0.0.0.0", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
              "fc00::1", "fe80::1", "fe80::1%eth0"]
PUBLIC = ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]


@pytest.mark.parametrize("addr", NON_PUBLIC)
def test_non_public_addresses_allow_only_safe_methods_for_an_agent(addr):
    http_policy.check_address(addr, "GET", True)
    http_policy.check_address(addr, "HEAD", True)
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        with pytest.raises(http_policy.DestinationRefused):
            http_policy.check_address(addr, method, True)
        http_policy.check_address(addr, method, False)      # a user may


@pytest.mark.parametrize("addr", PUBLIC)
def test_public_addresses_are_not_limited_by_this_policy(addr):
    for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        http_policy.check_address(addr, method, True)


@pytest.mark.parametrize("addr", ["169.254.169.254", "::ffff:169.254.169.254", "100.100.100.200",
                                  "fd00:ec2::254"])
@pytest.mark.parametrize("autonomous", [True, False])
def test_metadata_addresses_are_refused_for_every_actor_and_method(addr, autonomous):
    for method in ("GET", "HEAD", "POST"):
        with pytest.raises(http_policy.DestinationRefused):
            http_policy.check_address(addr, method, autonomous)


# ── through the real fabric ────────────────────────────────────────────────

@pytest.fixture()
def fabric(tmp_path, monkeypatch):
    from aura.audit import AuditStore
    from aura.fabric import CapabilityFabric, FabricConfig, FabricHost, builtin_executors

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


def _fabric_call(fabric, url, method, actor):
    from aura.fabric import invoke_fabric

    cfg, cwd = fabric
    return invoke_fabric("http.request", {"url": url, "method": method, "body": "{}"},
                         {"cwd": str(cwd), "actor": actor}, cfg)


def test_the_fabric_refuses_an_agent_post_and_the_service_never_sees_it(fabric, server):
    base, _ = server
    result = _fabric_call(fabric, f"{base}/api/delete", "DELETE", AGENT)
    assert result["outcome"] == "failed"
    assert "GET or HEAD" in result["detail"]
    assert HITS == []


def test_the_fabric_lets_a_user_send_the_same_request(fabric, server):
    base, _ = server
    result = _fabric_call(fabric, f"{base}/api/thing", "PUT", HUMAN)
    assert result["outcome"] == "succeeded", result
    assert HITS == [("PUT", "/api/thing")]


def test_the_fabric_lets_an_agent_read(fabric, server):
    base, _ = server
    result = _fabric_call(fabric, f"{base}/models", "GET", AGENT)
    assert result["outcome"] == "succeeded", result
    assert HITS == [("GET", "/models")]
