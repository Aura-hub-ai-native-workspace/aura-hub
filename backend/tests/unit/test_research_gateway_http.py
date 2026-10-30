"""Web research against a controlled local gateway, over real HTTP.

This proves the integration (configuration, request, parsing, provenance,
citations, failure kinds). It is NOT live web research: the gateway here is a
fixture that serves canned SearXNG-shaped JSON.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest


class _Gateway(BaseHTTPRequestHandler):
    mode = "ok"      # ok | empty | malformed | html | 429 | 500 | slow
    queries: list[str] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        q = parse_qs(urlsplit(self.path).query)
        type(self).queries.append((q.get("q") or [""])[0])
        mode = type(self).mode
        if mode == "slow":
            time.sleep(2.0)
        if mode in ("403", "429", "500"):
            self.send_response(int(mode)); self.end_headers(); return
        if mode == "html":
            body, ctype = b"<html>not a gateway</html>", "text/html"
        elif mode == "malformed":
            body, ctype = json.dumps({"hits": []}).encode(), "application/json"
        elif mode == "empty":
            body, ctype = json.dumps({"results": []}).encode(), "application/json"
        else:
            body, ctype = json.dumps({"results": [
                {"title": "PEP 8", "url": "https://peps.python.org/pep-0008/", "content": "Style guide for Python code."},
                {"title": "Bad", "url": "javascript:alert(1)", "content": "x"},
                {"title": "Docs", "url": "https://docs.python.org/3/", "content": "Python docs."}]}).encode(), "application/json"
        self.send_response(200); self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)


@pytest.fixture()
def gateway():
    _Gateway.mode = "ok"; _Gateway.queries = []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/search"
    srv.shutdown()


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("AURA_SEARCH_ENDPOINT", raising=False)
    (tmp_path / "home").mkdir()
    return tmp_path / "home"


def client():
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    return TestClient(create_app())


def test_unconfigured_is_reported_and_nothing_is_invented(home):
    c = client()
    assert c.get("/agent/research/config").json() == {"configured": False, "endpoint": None, "source": None}
    r = c.post("/agent/chat", json={"message": "What is PEP 8?"}).json()["result"]
    assert r["research"]["status"] == "unavailable" and r["research"]["kind"] == "not-configured"
    assert r["research"]["allSources"] == [] and r["sources"] == []


def test_saving_validates_with_a_real_probe_and_then_research_returns_real_sources(home, gateway):
    c = client()
    out = c.post("/agent/research/config", json={"searchEndpoint": gateway})
    assert out.status_code == 200 and out.json()["saved"] and out.json()["results"] == 2
    assert json.loads((home / "web.json").read_text())["searchEndpoint"] == gateway
    assert c.get("/agent/research/config").json() == {"configured": True, "endpoint": gateway, "source": "file"}

    r = c.post("/agent/chat", json={"message": "What is PEP 8?"}).json()["result"]
    assert r["research"]["status"] == "ok" and r["research"]["consulted"] == 2
    urls = [s["url"] for s in r["research"]["allSources"]]
    assert urls == ["https://peps.python.org/pep-0008/", "https://docs.python.org/3/"]  # the javascript: row never arrives
    assert all(s["retrievedAt"] for s in r["research"]["allSources"])               # timestamps kept
    assert any("pep" in q.lower() for q in _Gateway.queries[1:])                     # the user's question was searched


def test_provenance_reaches_shared_context_for_later_planning(home, gateway):
    c = client()
    c.post("/agent/research/config", json={"searchEndpoint": gateway})
    c.post("/agent/chat", json={"message": "What is PEP 8?", "projectId": "proj-a"})
    ctx = c.get("/agent/context/proj-a", params={"q": "PEP 8"}).json()   # the package is relevance-bounded
    assert "Research" in ctx["text"] and "peps.python.org" in ctx["text"]
    assert "peps.python.org" not in c.get("/agent/context/proj-b", params={"q": "PEP 8"}).json()["text"]    # project isolation


@pytest.mark.parametrize("mode,fragment", [
    ("html", "not a SearXNG-compatible"), ("malformed", "not a SearXNG-compatible"),
    ("429", "rate limiting"), ("500", "HTTP 500"), ("403", "search.formats")])
def test_a_bad_gateway_is_refused_and_not_saved(home, gateway, mode, fragment):
    _Gateway.mode = mode
    out = client().post("/agent/research/config", json={"searchEndpoint": gateway})
    assert out.status_code == 400 and fragment in out.json()["reason"] and out.json()["saved"] is False
    assert not (home / "web.json").exists()


@pytest.mark.parametrize("raw", ["", "ftp://x/y", "http://user:pw@127.0.0.1:1/s", "http://169.254.169.254/x", "nonsense", 5])
def test_unusable_addresses_are_refused_without_any_request(home, raw):
    out = client().post("/agent/research/config", json={"searchEndpoint": raw})
    assert out.status_code == 400 and out.json()["saved"] is False and not (home / "web.json").exists()


def test_saving_keeps_other_web_json_keys_and_clear_removes_only_the_endpoint(home, gateway):
    (home / "web.json").write_text(json.dumps({"maxResults": 3}))
    c = client()
    c.post("/agent/research/config", json={"searchEndpoint": gateway})
    assert json.loads((home / "web.json").read_text()) == {"maxResults": 3, "searchEndpoint": gateway}
    c.delete("/agent/research/config")
    assert json.loads((home / "web.json").read_text()) == {"maxResults": 3}


def test_environment_override_blocks_saving_and_says_so(home, gateway, monkeypatch):
    monkeypatch.setenv("AURA_SEARCH_ENDPOINT", gateway)
    c = client()
    assert c.get("/agent/research/config").json()["source"] == "environment"
    out = c.post("/agent/research/config", json={"searchEndpoint": gateway})
    assert out.status_code == 400 and "AURA_SEARCH_ENDPOINT" in out.json()["reason"]


def test_research_failures_in_a_chat_are_distinct_and_never_become_sources(home, gateway):
    c = client()
    c.post("/agent/research/config", json={"searchEndpoint": gateway})
    for mode, what in (("empty", "empty"), ("malformed", "unavailable"), ("500", "unavailable"), ("429", "unavailable"), ("html", "unavailable")):
        _Gateway.mode = mode
        r = c.post("/agent/chat", json={"message": f"What is the latest Python release? ({mode})"}).json()["result"]
        assert r["research"]["status"] == what, (mode, r["research"])
        assert r["research"]["allSources"] == [] and r["sources"] == []


def test_a_gateway_that_answers_too_slowly_is_reported_as_such(home, gateway, monkeypatch):
    import aura.executors.web_research as wr

    c = client()
    c.post("/agent/research/config", json={"searchEndpoint": gateway})
    _Gateway.mode = "slow"
    monkeypatch.setattr(wr, "DEFAULT_TIMEOUT_MS", 500)
    r = c.post("/agent/chat", json={"message": "What is the latest Rust release?"}).json()["result"]
    assert r["research"]["status"] == "unavailable" and r["research"]["allSources"] == []


def test_a_searxng_403_tells_the_owner_how_to_enable_json_in_chat_too(home, gateway):
    c = client()
    c.post("/agent/research/config", json={"searchEndpoint": gateway})
    _Gateway.mode = "403"
    r = c.post("/agent/chat", json={"message": "What is the latest Python release?"}).json()["result"]
    assert r["research"]["status"] == "unavailable" and r["research"]["kind"] == "refused"
    assert "search.formats" in r["research"]["detail"] and r["research"]["allSources"] == []


def test_the_model_is_told_that_aura_searched_and_it_did_not_browse():
    from aura.central_agent.research import research_status_line

    line = research_status_line({"status": "ok", "sources": [{"id": 1}, {"id": 2}]})
    assert "you did not browse the web" in line and "conflict" in line and "interpretation" in line


def test_a_current_facts_answer_without_research_says_so_on_the_answer_itself(home, monkeypatch):
    """No gateway + a time-sensitive question: the caveat is part of the answer text."""
    import json as _json
    import threading as _t
    from http.server import BaseHTTPRequestHandler as H, ThreadingHTTPServer as S

    class Model(H):
        def log_message(self, *a): pass
        def do_GET(self):
            b = _json.dumps({"data": [{"id": "m"}]}).encode(); self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length", "0")))
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
            self.wfile.write(("data: " + _json.dumps({"choices": [{"delta": {"content": "It is 3.11.3."}}]}) + "\n\ndata: [DONE]\n\n").encode())

    srv = S(("127.0.0.1", 0), Model); _t.Thread(target=srv.serve_forever, daemon=True).start()
    (home / "agent").mkdir(exist_ok=True)
    (home / "agent" / "providers.settings.json").write_text(_json.dumps({"active": {
        "providerId": "ollama", "model": "m", "callable": True, "baseUrl": f"http://127.0.0.1:{srv.server_address[1]}/v1"}}))
    try:
        c = client()
        current = c.post("/agent/chat", json={"message": "Who won the most recent Nobel Prize in Physics this year?"}).json()["result"]
        assert current["summary"].startswith("Not verified against the web") and "It is 3.11.3." in current["summary"]
        timeless = c.post("/agent/chat", json={"message": "Explain what a mutex is."}).json()["result"]
        assert "Not verified against the web" not in timeless["summary"]       # not every answer is caveated
    finally:
        srv.shutdown()


@pytest.mark.parametrize("q,expected", [
    ("Who won the most recent Nobel Prize in Physics this year?", True),
    ("What is the latest stable release of Rust?", True),
    ("What is the current price of bitcoin?", True),
    ("A seek bar with current time and duration, and recently played tracks.", False),
    ("Explain what a mutex is.", False),
])
def test_only_real_current_fact_questions_get_the_unverified_caveat(q, expected):
    from aura.central_agent.research import asks_for_current_facts

    assert asks_for_current_facts(q) is expected
