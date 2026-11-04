"""Web search works out of the box (built-in keyless provider) without ever reaching a real network here."""
import asyncio
import urllib.parse

import pytest

from aura.executors import web_research as wr

PAGE = '''
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;rut=x">Alpha &amp; Omega</a>
<a class="result__snippet" href="x">The first <b>result</b> snippet.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fb">Beta</a>
<a class="result__snippet" href="x">Second snippet.</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">An ad</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa">duplicate</a></div>
'''


@pytest.fixture()
def builtin(monkeypatch):
    monkeypatch.setenv("AURA_SEARCH_PROVIDER", "on")


def _run(query="how do rust lifetimes work", **extra):
    seen = []

    def fetch(url, timeout_ms, accept="*/*"):
        seen.append((url, accept))
        return (200, PAGE) if "duckduckgo.com/html" in url else (200, "<p>page body text</p>")

    inv = {"input": {wr.CONSENT_KEY: True, "query": query, **extra}, "context": {}}
    return asyncio.run(wr.web_research_run(inv, fetch_fn=fetch)), seen


def test_results_are_unwrapped_deduplicated_and_ads_dropped():
    got = wr.parse_builtin_results(PAGE)
    assert [r["url"] for r in got] == ["https://example.org/a", "https://example.net/b"]
    assert got[0]["title"] == "Alpha & Omega" and "first result snippet" in got[0]["snippet"]


def test_with_nothing_configured_search_just_works(builtin):
    out, seen = _run()
    assert out["ok"] is True, out
    # Bing answers first (unreadable here), then DuckDuckGo supplies the results: one engine failing is not the end.
    q = urllib.parse.quote("how do rust lifetimes work")
    assert [u for u, _ in seen[:2]] == ["https://www.bing.com/search?q=" + q, "https://html.duckduckgo.com/html/?q=" + q]
    assert out["output"]["count"] == 2 and "[source=https://example.org/a" in out["output"]["stdout"]


def test_consent_is_still_required_and_nothing_is_fetched_without_it(builtin):
    seen = []
    out = asyncio.run(wr.web_research_run({"input": {"query": "x"}}, fetch_fn=lambda *a, **k: seen.append(a)))
    assert out["ok"] is False and seen == []


def test_it_can_be_turned_off_and_a_bad_explicit_gateway_is_never_rerouted(monkeypatch, builtin):
    monkeypatch.setenv("AURA_SEARCH_PROVIDER", "off")
    assert _run()[0]["ok"] is False
    monkeypatch.setenv("AURA_SEARCH_PROVIDER", "on")
    monkeypatch.setenv("AURA_SEARCH_ENDPOINT", "http://169.254.169.254/latest")
    out, seen = _run()
    assert out["ok"] is False and seen == []             # refused, not quietly sent to the built-in engine


def test_an_unreadable_answer_is_a_failure_not_a_silent_empty(builtin):
    out = asyncio.run(wr.web_research_run({"input": {wr.CONSENT_KEY: True, "query": "q"}},
                                          fetch_fn=lambda *a, **k: (200, "<html>captcha</html>")))
    assert out["ok"] is False and "built-in search" in out["detail"]
    assert "Bing" in out["detail"] and "DuckDuckGo" in out["detail"]       # every engine tried is named


BING = """
<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly93d3cucHl0aG9uLm9yZy8&amp;ntb=1">Welcome to <strong>Python</strong>.org</a></h2>
<div class="b_caption"><p>The mission of the Python Software Foundation.</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/direct">Direct</a></h2><p>Second.</p></li>
<li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">Images</a></h2></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly93d3cucHl0aG9uLm9yZy8">dup</a></h2></li></ol>
"""


def test_bing_results_are_decoded_deduplicated_and_internal_links_dropped():
    got = wr.parse_bing_results(BING)
    assert [r["url"] for r in got] == ["https://www.python.org/", "https://example.com/direct"]
    assert got[0]["title"] == "Welcome to Python.org" and "Software Foundation" in got[0]["snippet"]


def test_bing_is_used_when_it_answers_and_duckduckgo_is_not_asked(builtin):
    seen = []

    def fetch(url, timeout_ms, accept="*/*"):
        seen.append(url)
        return (200, BING) if "bing.com/search" in url else (200, "<p>page body text</p>")

    out = asyncio.run(wr.web_research_run({"input": {wr.CONSENT_KEY: True, "query": "python"}}, fetch_fn=fetch))
    assert out["ok"] is True and out["output"]["count"] == 2
    assert not any("duckduckgo" in u for u in seen)


def test_a_blocked_engine_falls_through_and_a_dead_network_says_so(builtin):
    def blocked(url, timeout_ms, accept="*/*"):
        return (202, "<html>anomaly</html>") if "duckduckgo" in url else (200, BING)

    assert asyncio.run(wr.web_research_run({"input": {wr.CONSENT_KEY: True, "query": "q"}}, fetch_fn=blocked))["ok"]

    def dead(url, timeout_ms, accept="*/*"):
        raise OSError("network unreachable")

    out = asyncio.run(wr.web_research_run({"input": {wr.CONSENT_KEY: True, "query": "q"}}, fetch_fn=dead))
    assert out["ok"] is False and "network unreachable" in out["detail"]
