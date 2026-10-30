"""web.research's fetch applies the same destination rule as http.request (F-20).

The metadata block used to look at the URL text only, so a redirect from an
ordinary page, or a name that resolves to the metadata address, reached it.
Research is GET-only: local services stay readable (the search gateway is often
local) and environment proxies still apply.
"""

from __future__ import annotations

import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from aura.executors import http_policy
from aura.executors.web_research import http_get

HITS: list[str] = []


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        if self.path.startswith("/redir?"):
            self.send_response(302)
            self.send_header("location", self.path.split("to=", 1)[1])
            self.send_header("content-length", "0")
            self.end_headers()
            return
        body = b"page text"
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture()
def server():
    HITS.clear()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_a_local_gateway_or_page_is_still_readable(server):
    assert http_get(f"{server}/page", 5_000) == (200, "page text")


def test_a_redirect_to_cloud_metadata_is_refused(server):
    with pytest.raises(http_policy.DestinationRefused):
        http_get(f"{server}/redir?to=http://169.254.169.254/latest/meta-data/", 5_000)
    assert HITS == ["/redir?to=http://169.254.169.254/latest/meta-data/"]


def test_a_name_that_resolves_to_cloud_metadata_is_refused(monkeypatch):
    real = socket.getaddrinfo

    def fake(host, port, *a, **kw):
        if host == "meta.test":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", port))]
        return real(host, port, *a, **kw)

    monkeypatch.setattr(http_policy.socket, "getaddrinfo", fake)
    with pytest.raises(OSError, match="metadata"):
        http_get("http://meta.test/latest/meta-data/", 5_000)


def test_a_redirect_to_a_non_http_scheme_is_not_followed(server):
    import urllib.error

    with pytest.raises(urllib.error.HTTPError):
        http_get(f"{server}/redir?to=file:///etc/passwd", 5_000)
    assert len(HITS) == 1


def test_proxies_apply_to_research_and_not_to_other_autonomous_requests(server, monkeypatch):
    """A dead proxy makes the difference visible: a request that honours it
    fails, a request that goes direct reaches the local server."""
    import urllib.error
    import urllib.request

    for name in ("HTTP_PROXY", "http_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)

    def get(opener):
        with opener.open(urllib.request.Request(f"{server}/page"), timeout=5) as resp:
            return resp.status

    assert get(http_policy.build_opener(True)) == 200                 # direct
    assert get(http_policy.build_opener(True, proxies=False)) == 200  # direct
    with pytest.raises(urllib.error.URLError):
        get(http_policy.build_opener(True, proxies=True))             # went via the dead proxy
    with pytest.raises(urllib.error.URLError):
        get(http_policy.build_opener(False))                          # a user's request honours it too
