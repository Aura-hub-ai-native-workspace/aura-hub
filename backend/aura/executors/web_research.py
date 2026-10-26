"""web.research — governed external web research, on the user's say-so.

Why this exists and why it is shaped this way
---------------------------------------------
AURA's own capability surface is where research belongs, not inside a
worker. A worker reaching the network means opening the sandbox's egress
door to arbitrary hosts; this capability runs in AURA's process, so the
Fabric's policy engine and audit trail all see it, and
the single door (``governance.netgate``) stays shut for the worker.

No search provider is hardcoded
-------------------------------
There is no engine name baked into this file. The operator points AURA at
a search gateway in ``~/.aura/web.json`` (or ``AURA_SEARCH_ENDPOINT``),
speaking the SearXNG-compatible JSON contract::

    GET <endpoint>?q=<url-encoded query>&format=json
    200 -> {"results": [{"title": "...", "url": "...", "content": "..."}]}

That is a self-hostable shape (SearXNG is the common one), which keeps
the choice — and any API key it needs — with the machine's owner rather
than with a vendor baked into the product. When no endpoint is configured
the capability REFUSES, saying so in plain words. It never invents
results, never falls back to a hardcoded engine, and never reports a
search it did not perform.

Consent is AURA-owned and fail-closed
-------------------------------------
``input["webResearch"]`` must be exactly ``True``. It is stamped by the
planner from the request-scoped preference the human set in the composer,
never from model output, and the check here is the last gate before any
socket is opened. A plan that somehow reaches this executor without that
flag gets a refusal, not a fetch.

Everything fetched is untrusted data
------------------------------------
Search results and page bodies are attacker-influenceable text. They are
length-bounded, emitted in the same fenced ``[source=...]`` form
``knowledge.search`` uses so the answer synthesizer and the inter-task
handoff envelope both treat them as data, and never echoed into a
command, a path, or a policy decision.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

#: Hosts that serve cloud instance metadata. Never legitimate research
#: targets, in the search gateway's own answers or on a fetched page.
_BLOCKED_HOSTS = frozenset({
    "169.254.169.254", "100.100.100.200", "fd00:ec2::254", "[fd00:ec2::254]",
})

#: Bounds. A research answer is evidence, not a crawl: a handful of
#: results, a bounded excerpt from each, a hard ceiling on the total text
#: that can reach a synthesis prompt.
MAX_RESULTS_CAP = 10
DEFAULT_MAX_RESULTS = 5
MAX_FETCH_PAGES = 3
PER_RESULT_CHARS = 1_200
MAX_STDOUT_CHARS = 8_000
MAX_HTTP_BYTES = 512 * 1024
DEFAULT_TIMEOUT_MS = 10_000
MAX_TIMEOUT_MS = 30_000

#: The consent key. Absent, false, "true" or 1 all refuse — only the
#: literal boolean the planner stamps counts.
CONSENT_KEY = "webResearch"

_NOT_CONSENTED = (
    "Web research was not enabled for this request, so nothing was "
    "fetched. It runs only when the person asks for it in the composer."
)
_NOT_CONFIGURED = (
    "No web research gateway is configured, so nothing was fetched. "
    "Point AURA at one in ~/.aura/web.json (searchEndpoint), or set "
    "AURA_SEARCH_ENDPOINT."
)


def _ok(detail: str, output: Any = None) -> dict:
    r: dict = {"ok": True, "detail": detail}
    if output is not None:
        r["output"] = output
    return r


def _no(detail: str) -> dict:
    return {"ok": False, "detail": detail}


# ── configuration ────────────────────────────────────────────────────────────


def load_web_config(home=None) -> dict:
    """Search-gateway configuration, or an empty dict when none is set.

    ``~/.aura/web.json`` is the documented home; ``AURA_SEARCH_ENDPOINT``
    overrides just the endpoint so a shell session can point AURA at a
    different gateway without editing the file. Nothing here invents a
    default endpoint — an unconfigured machine genuinely has no gateway,
    and the capability says so rather than reaching somewhere on its own.
    """
    from pathlib import Path

    if home is None:
        try:
            from ..config import aura_home

            home = aura_home()
        except Exception:  # noqa: BLE001 — config is best-effort, never fatal
            home = Path.home() / ".aura"
    cfg: dict = {}
    try:
        path = Path(home) / "web.json"
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                cfg = raw
    except Exception:  # noqa: BLE001 — unreadable config is "not configured"
        cfg = {}
    endpoint = os.environ.get("AURA_SEARCH_ENDPOINT")
    if endpoint:
        cfg = {**cfg, "searchEndpoint": endpoint}
    return cfg


def _public_endpoint(url: str) -> str:
    """The address as it may be shown or logged: scheme, host, port and path only."""
    u = urllib.parse.urlsplit(url)
    port = f":{u.port}" if u.port else ""
    return f"{u.scheme}://{u.hostname or ''}{port}{u.path}".rstrip("/")


def check_endpoint_syntax(raw: object) -> tuple[str | None, str]:
    """(endpoint, "") when usable, else (None, reason). Pure; no network.

    A credential in the address (``user:pass@host``) is refused: the address is
    stored in a plain JSON file, and this build does not keep gateway secrets.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None, "Enter the address of a SearXNG-compatible search endpoint."
    url = raw.strip()
    if not url.lower().startswith(("http://", "https://")):
        return None, "The address must start with http:// or https://."
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018 — raises ValueError on a bad port
    except ValueError:
        return None, "That address is not valid."
    if not host or host in _BLOCKED_HOSTS:
        return None, "That address is not allowed."
    if parts.username or parts.password:
        return None, ("Credentials in the address are not accepted: it is stored in a plain file. "
                      "Use a gateway that needs none.")
    return url, ""


def probe_gateway(endpoint: str, *, timeout_ms: int = 4_000, fetch_fn=None) -> dict:
    """One bounded test query. ``{"ok": bool, "reason": str, "results": int}``.

    Never saves anything. It asks the gateway a harmless query and checks that
    what comes back is what a search gateway returns, so an address that merely
    answers (a web page, an API of something else) is not accepted as a gateway.
    """
    fetch = fetch_fn or http_get
    joiner = "&" if urllib.parse.urlsplit(endpoint).query else "?"
    try:
        status, payload = fetch(f"{endpoint}{joiner}q=test&format=json", timeout_ms, accept="application/json")
    except urllib.error.HTTPError as exc:
        code = getattr(exc, "code", 0) or 0
        reason = ("The gateway refused the request (HTTP %d). A SearXNG instance answers 403 when its JSON "
                  "format is not enabled: add `json` to `search.formats` in its settings.yml." % code
                  if code in (401, 403) else
                  "The gateway is rate limiting requests (429). Try again shortly." if code == 429 else
                  f"The gateway answered HTTP {code}.")
        return {"ok": False, "reason": reason, "results": 0}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        why = getattr(exc, "reason", exc)
        return {"ok": False, "reason": f"Could not reach the gateway: {type(why).__name__}.", "results": 0}
    if not (200 <= status < 300):
        return {"ok": False, "reason": f"The gateway answered HTTP {status}.", "results": 0}
    if not gateway_answer_is_wellformed(payload):
        return {"ok": False, "reason": "That address answered, but it is not a SearXNG-compatible "
                                       "search endpoint (no JSON \"results\" list).", "results": 0}
    return {"ok": True, "reason": "", "results": len(parse_results(payload))}


def research_config_status() -> dict:
    """Where search is configured from, without credentials. Never invents an endpoint."""
    cfg = load_web_config()
    endpoint = _endpoint(cfg)
    if endpoint is None:
        return {"configured": False, "endpoint": None, "source": None}
    return {"configured": True, "endpoint": _public_endpoint(endpoint),
            "source": "environment" if os.environ.get("AURA_SEARCH_ENDPOINT") else "file"}


def save_search_endpoint(raw: object, *, fetch_fn=None) -> dict:
    """Validate, probe, and only then save ``searchEndpoint`` in ``web.json``.

    Other keys in the file are kept. Atomic write. Refuses when the environment
    variable overrides the file (the saved value would not take effect).
    """
    endpoint, why = check_endpoint_syntax(raw)
    if endpoint is None:
        return {"ok": False, "reason": why, "saved": False}
    if os.environ.get("AURA_SEARCH_ENDPOINT"):
        return {"ok": False, "saved": False,
                "reason": "AURA_SEARCH_ENDPOINT is set in the environment and overrides the saved address. "
                          "Unset it to configure the gateway here."}
    probe = probe_gateway(endpoint, fetch_fn=fetch_fn)
    if not probe["ok"]:
        return {"ok": False, "saved": False, "reason": probe["reason"]}
    from pathlib import Path

    from ..config import aura_home

    path = Path(aura_home()) / "web.json"
    try:
        current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, ValueError):
        return {"ok": False, "saved": False,
                "reason": "The existing web.json could not be read, so it was left untouched."}
    if not isinstance(current, dict):
        return {"ok": False, "saved": False, "reason": "The existing web.json is not an object; left untouched."}
    current["searchEndpoint"] = endpoint
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(current, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return {"ok": True, "saved": True, "reason": "", "results": probe["results"],
            "endpoint": _public_endpoint(endpoint)}


def clear_search_endpoint() -> dict:
    from pathlib import Path

    from ..config import aura_home

    path = Path(aura_home()) / "web.json"
    try:
        current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, ValueError):
        return {"ok": False, "reason": "The existing web.json could not be read; left untouched."}
    if isinstance(current, dict) and "searchEndpoint" in current:
        del current["searchEndpoint"]
        tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(current, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    return {"ok": True, "reason": ""}


def _endpoint(cfg: dict) -> str | None:
    raw = cfg.get("searchEndpoint")
    if not isinstance(raw, str):
        return None
    url = raw.strip()
    if not url.lower().startswith(("http://", "https://")):
        return None
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not host or host in _BLOCKED_HOSTS:
        return None
    return url


def _int(cfg: dict, key: str, default: int, cap: int) -> int:
    try:
        val = int(cfg.get(key, default))
    except (TypeError, ValueError):
        return default
    if val < 1:
        return default
    return min(val, cap)


# ── the fetch seam ───────────────────────────────────────────────────────────


def http_get(url: str, timeout_ms: int, accept: str = "*/*") -> tuple[int, str]:
    """Bounded GET. Returns ``(status, text)``; raises on transport failure.

    A single named seam so the whole capability is testable without a
    network, exactly as the capability registry takes its probe functions.
    """
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", accept)
    req.add_header("User-Agent", "AURA-Hub/web.research (governed local agent)")
    with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as resp:
        raw = resp.read(MAX_HTTP_BYTES)
        return int(getattr(resp, "status", 0) or 0), raw.decode("utf-8", errors="replace")


def _safe_url(url: str) -> str | None:
    """A fetchable http(s) URL that is not a metadata address."""
    if not isinstance(url, str):
        return None
    url = url.strip()
    if not url.lower().startswith(("http://", "https://")):
        return None
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not host or host in _BLOCKED_HOSTS:
        return None
    return url


# ── extraction ───────────────────────────────────────────────────────────────

_SCRIPT_STYLE = re.compile(r"(?is)<(script|style|noscript)\b.*?</\1>")
_TAG = re.compile(r"(?s)<[^>]+>")
_WS = re.compile(r"[ \t\r\f\v]+")
_BLANKS = re.compile(r"\n{3,}")


def html_to_text(html: str, limit: int) -> str:
    """Readable plain text from a page body, bounded.

    Deliberately crude: this is an excerpt for a human or a model to judge,
    never a parse that has to be right. Tags go, scripts go, runs of
    whitespace collapse, and the result stops at ``limit``.
    """
    text = _SCRIPT_STYLE.sub(" ", html or "")
    text = _TAG.sub(" ", text)
    for ent, raw in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                     ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(ent, raw)
    text = _WS.sub(" ", text)
    text = _BLANKS.sub("\n\n", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + " …[truncated]"
    return text


def _clip(text: str, limit: int, label: str = "") -> str:
    text = (text or "").strip()
    if label:
        text = text.replace("\n", f"\n{label} ")
    if len(text) > limit:
        text = text[:limit].rstrip() + " …[truncated]"
    return text


def gateway_answer_is_wellformed(payload: str) -> bool:
    """True when the answer is a JSON object carrying a ``results`` list (possibly empty)."""
    try:
        data = json.loads(payload or "")
    except (TypeError, ValueError):
        return False
    return isinstance(data, dict) and isinstance(data.get("results"), list)


def parse_results(payload: str) -> list[dict]:
    """SearXNG-compatible ``{"results": [...]}`` into bounded records.

    A shape this does not recognise yields no results rather than a guess:
    a malformed gateway answer is an honest empty, and the caller says so.
    """
    try:
        data = json.loads(payload or "")
    except (TypeError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    rows = data.get("results")
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = _safe_url(row.get("url"))
        if not url:
            continue
        title = _clip(str(row.get("title") or ""), 200)
        snippet = _clip(str(row.get("content") or row.get("snippet") or ""),
                        PER_RESULT_CHARS)
        out.append({"title": title, "url": url, "snippet": snippet})
    return out


def render_stdout(results: list[dict], fetch_pages: int, timeout_ms: int,
                  fetch_fn=http_get) -> tuple[str, int]:
    """Bounded evidence block in the same shape ``knowledge.search`` emits.

    Per result: the gateway's own snippet, then — for the first
    ``fetch_pages`` results — the page body itself, so the evidence is the
    source rather than a summary of it. Returns ``(stdout, pages_fetched)``.
    """
    lines: list[str] = []
    fetched = 0
    for idx, rec in enumerate(results):
        lines.append(f'[source={rec["url"]}'
                     + (f' title="{_clip(rec["title"], 120)}"' if rec["title"] else "")
                     + "]")
        body = rec["snippet"]
        if idx < fetch_pages:
            try:
                status, page = fetch_fn(rec["url"], timeout_ms, accept="text/html")
                if 200 <= status < 400:
                    extracted = html_to_text(page, PER_RESULT_CHARS)
                    if extracted:
                        body = extracted
                        fetched += 1
            except Exception:  # noqa: BLE001 — one unreachable page is not a failure
                body = body or "(page could not be fetched)"
        lines.append(body or "(no readable text)")
        lines.append("[/source]")
        if sum(len(x) for x in lines) >= MAX_STDOUT_CHARS:
            lines.append("…[additional results omitted]")
            break
    return "\n\n".join(lines), fetched


# ── the executor ─────────────────────────────────────────────────────────────


async def web_research_run(inv: dict, *, fetch_fn=http_get) -> dict:
    """Bounded, consented, config-driven web research.

    Order matters: consent is checked before the configuration is even
    read, so a request that did not ask for research cannot cause a
    configuration read, a URL build, or a socket.
    """
    params = (inv.get("input") or inv.get("params")) or {}
    if not isinstance(params, dict):
        return _no("Web research input must be an object.")

    if params.get(CONSENT_KEY) is not True:
        return _no(_NOT_CONSENTED)

    query = params.get("query")
    if not isinstance(query, str) or not query.strip():
        return _no("A research query is required.")
    query = query.strip()
    if len(query) > 512:
        query = query[:512].rstrip()

    cfg = load_web_config()
    endpoint = _endpoint(cfg)
    if endpoint is None:
        return _no(_NOT_CONFIGURED)

    ctx = inv.get("context")
    raw_timeout = ctx.get("timeoutMs") if isinstance(ctx, dict) else None
    try:
        timeout_ms = int(raw_timeout) if raw_timeout is not None else DEFAULT_TIMEOUT_MS
    except (TypeError, ValueError):
        timeout_ms = DEFAULT_TIMEOUT_MS
    timeout_ms = max(1_000, min(timeout_ms, MAX_TIMEOUT_MS))

    max_results = _int(params, "max_results",
                       _int(cfg, "maxResults", DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP),
                       MAX_RESULTS_CAP)
    fetch_pages = _int(cfg, "fetchPages", MAX_FETCH_PAGES, MAX_FETCH_PAGES)

    joiner = "&" if urllib.parse.urlsplit(endpoint).query else "?"
    url = (f"{endpoint}{joiner}q={urllib.parse.quote(query)}"
           f"&format=json")

    try:
        status, payload = fetch_fn(url, timeout_ms, accept="application/json")
    except urllib.error.HTTPError as exc:
        code = getattr(exc, "code", 0) or 0
        if code in (401, 403):
            return _no(f"The search gateway refused the request ({code}). "
                       "A SearXNG instance answers 403 when its JSON format is not enabled "
                       "(add `json` to `search.formats` in its settings.yml); otherwise its "
                       "credentials are not usable from this machine.")
        return _no(f"The search gateway answered {code}.")
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        return _no(f"The search gateway did not answer: {reason}.")
    except TimeoutError:
        return _no("The search gateway did not answer in time.")
    except Exception as exc:  # noqa: BLE001 — any transport failure is honest failure
        return _no(f"The search request did not complete: {exc}")

    if not (200 <= status < 300):
        return _no(f"The search gateway answered {status}.")

    if not gateway_answer_is_wellformed(payload):
        # An answer this cannot read is a gateway problem, not "no results":
        # calling it empty would hide a misconfigured endpoint.
        return _no("The search gateway answered, but not in the expected format "
                   "(a JSON object with a \"results\" list). Check that the address is a "
                   "SearXNG-compatible search endpoint.")
    results = parse_results(payload)[:max_results]
    if not results:
        return _ok(
            f"No results for {query!r} (the gateway answered, with nothing "
            "matching).",
            {"query": query, "results": [], "count": 0,
             "stdout": "(the gateway returned no results)"},
        )

    stdout, pages = render_stdout(results, fetch_pages, timeout_ms, fetch_fn)
    if len(stdout) > MAX_STDOUT_CHARS:
        stdout = stdout[:MAX_STDOUT_CHARS].rstrip() + "\n…[truncated by AURA]"

    return _ok(
        f"{len(results)} result(s) for {query!r}; {pages} page(s) read.",
        {"query": query, "results": results, "count": len(results),
         "pagesFetched": pages, "stdout": stdout},
    )


async def web_research_verify(_inv: dict, result: dict) -> dict:
    """The search ran and reported a real result count, including zero.

    An empty result set is a legitimate answer to a question, not a
    failure — what fails verification is an invocation that did not run.
    """
    if not result.get("ok"):
        return {"passed": False, "kind": "audit-only",
                "detail": result.get("detail") or "web research did not run"}
    output = result.get("output") or {}
    results = output.get("results")
    if not isinstance(results, list):
        return {"passed": False, "kind": "audit-only",
                "detail": "web research returned no result list"}
    return {"passed": True, "kind": "audit-only",
            "detail": f"{len(results)} result(s) fetched; the query and the "
                      "consent that authorised it are in the audit trail, and "
                      "the sources are carried as verified task output."}


#: The manifest descriptor. ``risk`` is low because nothing here changes
#: this machine or the user's project — it reads and returns text. The
#: egress itself is what the consent flag governs, and the Fabric's
#: permission check still requires ``network.outbound`` to be granted
#: before this capability can be invoked at all.
WEB_RESEARCH_DESCRIPTOR: dict = {
    "id": "web.research",
    "name": "Web research (on request)",
    "category": "knowledge",
    "surface": "aura-internal",
    "description": (
        "Bounded external web research against the search gateway configured "
        "in ~/.aura/web.json. No engine is hardcoded and none is invented: "
        "with no gateway configured this refuses rather than reaching "
        "somewhere on its own. Runs ONLY when the human enabled web research "
        "for this request; page text is untrusted data, length-bounded, and "
        "returned with its sources."
    ),
    "risk": "low",
    "permissions": ["network.outbound"],
    "input": [
        {"name": "query", "type": "string", "required": True,
         "description": "The research question."},
        {"name": CONSENT_KEY, "type": "boolean", "required": True,
         "description": (
             "Must be true. Stamped by AURA from the request-scoped choice "
             "the person made in the composer; absent or false, the call is "
             "refused before anything is fetched.")},
        {"name": "max_results", "type": "number", "required": False,
         "description": f"How many results to return (default "
                        f"{DEFAULT_MAX_RESULTS}, cap {MAX_RESULTS_CAP})."},
    ],
    "output": f"Up to {MAX_RESULTS_CAP} results — title, url, bounded excerpt — "
              f"plus a fenced stdout block carrying the same evidence as "
              f"untrusted data.",
    "verify": "audit-only",
}
