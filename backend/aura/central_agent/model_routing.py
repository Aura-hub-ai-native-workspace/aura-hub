"""Model routing — provider-agnostic LLM access for the agent layer.

Design rules (mission §8):
- The Agent depends on ModelPort, never on a provider SDK.
- Provider SELECTION comes from an operator-written JSON file; API KEYS
  come only from the environment at call time and are never persisted,
  logged, or placed into session state.
- Health tracking is per-provider consecutive failures; a failing provider
  falls back down the configured chain until one answers or all fail
  (honest error, no fabricated output).
- Timeouts are hard; retries are capped.

Wire shape assumed: OpenAI-compatible POST {baseUrl}/chat/completions.

Sovereign extensions:
- api_key_env may be "" (empty) for keyless local/private servers (Ollama etc.)
- network_class classifies each endpoint: "local" | "private" | "cloud" | "unknown"
- Sovereign policy loaded from ~/.aura/sovereign.json blocks cloud endpoints
  when sovereign_mode is enabled — no silent fallback.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .intent import ModelPort

#: Network classification for sovereignty enforcement.
#: "local"   — loopback or LAN address under operator control
#: "private" — remote but privately operated (VPN/LAN GPU server)
#: "cloud"   — external commercial API endpoint
#: "unknown" — not classified; treated as cloud in sovereign mode
NETWORK_CLASSES = frozenset({"local", "private", "cloud", "unknown"})


@dataclass(frozen=True)
class ProviderSpec:
    """Operator-declared endpoint. NEVER carries secrets.

    api_key_env: env var NAME resolved fresh each call.
      Set to "" (empty string) for keyless servers such as Ollama — the
      Authorization header is omitted entirely rather than sent blank.
    network_class: sovereignty classification used by SovereignPolicy.
    """

    id: str
    base_url: str
    model: str
    api_key_env: str = ""       # "" = keyless (Ollama, private servers)
    timeout_s: float = 30.0
    max_retries: int = 2
    #: Wall-clock budget for ONE PLANNING completion, in seconds.
    #: Separate from ``timeout_s``, which is the transport budget for one
    #: request. A plan is a long generation, not a chat turn: a slow local
    #: model must not be killed because the endpoint is slow rather than
    #: broken. 0 = use DEFAULT_PLAN_TIMEOUT_S.
    plan_timeout_s: float = 0.0
    #: Retries allowed for ONE planning completion. 0 = try each provider
    #: once and fail over. A retried plan multiplies the wall clock a slow
    #: model already spends, so the default is one attempt per provider.
    plan_max_retries: int = 0
    max_context_chars: int = 24_000
    #: Hard ceiling on generated tokens for a non-streaming completion.
    #: A degenerate model can enter a verbatim repetition loop and never
    #: terminate; without a ceiling the request can only end by socket
    #: timeout, which is indistinguishable from an outage. Bounded
    #: generation turns an unending loop into a normal, reportable
    #: response (finish_reason="length"). 0 = provider default (unbounded).
    max_output_tokens: int = 2048
    supports_json_mode: bool = True
    enabled: bool = True
    #: Extra HTTP headers for this endpoint only (e.g.
    #: {"ngrok-skip-browser-warning": "true"} for tunnels that gate
    #: browser traffic behind an interstitial page). Never secrets:
    #: anything secret-shaped belongs in api_key_env.
    headers: tuple = ()
    network_class: str = "unknown"   # "local" | "private" | "cloud" | "unknown"


@dataclass
class ProviderHealth:
    consecutive_failures: int = 0
    last_error: str | None = None
    calls: int = 0


def default_model_port(path: str | None = None,
                       sovereign_policy=None):
    """The Central Agent's reasoning model, or None when unconfigured.

    AURA's own reasoning is a SEPARATE concern from the worker runtimes:
    a machine with Claude Code and OpenCode connected still has no model
    AURA can think with, because those are workers it delegates to, not
    its own planner. This is the one place the two are joined, and it
    joins them only when an operator has written a provider file.

    Returns None rather than raising: no provider means AURA falls back
    to deterministic planning and says so, which is the honest degraded
    mode — never a fabricated plan and never a hidden default endpoint.
    Keys are read from the environment at call time by the port itself
    and are never persisted here.

    sovereign_policy: optional SovereignPolicy; when supplied, providers
    whose network_class is blocked are excluded BEFORE building the port.
    """
    specs = [s for s in load_providers(path) if s.enabled]
    if sovereign_policy is not None:
        specs = [s for s in specs
                 if sovereign_policy.allows(s.network_class)]
    if not specs:
        return None
    return RoutedModelPort(specs, sovereign_policy=sovereign_policy)


PROVIDER_FILE_OK = "ok"
PROVIDER_FILE_MISSING = "missing"
PROVIDER_FILE_MALFORMED = "malformed"
PROVIDER_FILE_UNREADABLE = "unreadable"


@dataclass(frozen=True)
class ProviderFile:
    """The outcome of reading the operator's provider file, before any entry is interpreted.

    ``status`` is one of ok | missing | malformed | unreadable. ``entries`` holds the raw
    entry objects, and only when status is ok. ``detail`` is a type name or a fixed phrase,
    never file content, so it is safe to log.
    """
    status: str
    entries: tuple = ()
    detail: str = ""


def read_provider_document(path: str | Path | None = None) -> ProviderFile:
    """Read the provider file and return its entries, reporting every failure explicitly.

    Accepts both documented shapes: a wrapper object with a ``providers`` list, and a bare
    list. Anything else is malformed. A missing file is reported as missing, not as an
    empty configuration, so a caller can tell "not configured" from "configured but broken".
    """
    from ..config import aura_path

    file = Path(path) if path else aura_path("agent", "providers.json")
    if not file.exists():
        return ProviderFile(PROVIDER_FILE_MISSING)
    try:
        text = file.read_text(encoding="utf-8")
    except OSError as exc:
        return ProviderFile(PROVIDER_FILE_UNREADABLE, detail=type(exc).__name__)
    try:
        raw = json.loads(text)
    except ValueError:
        return ProviderFile(PROVIDER_FILE_MALFORMED, detail="invalid JSON")
    if isinstance(raw, dict):
        entries = raw.get("providers")
    elif isinstance(raw, list):
        entries = raw
    else:
        return ProviderFile(PROVIDER_FILE_MALFORMED, detail="top level is neither object nor list")
    if not isinstance(entries, list):
        return ProviderFile(PROVIDER_FILE_MALFORMED, detail="providers is not a list")
    return ProviderFile(PROVIDER_FILE_OK, entries=tuple(e for e in entries if isinstance(e, dict)))


#: Where the AURA service publishes its secret-free view of the provider chosen
#: in Settings (ai-service: provider/agentView.ts). Written by that service
#: only; this process never reads the encrypted credential store.
SETTINGS_VIEW_FILE = "providers.settings.json"
#: A model the person chose in Settings may be a small local one on a CPU: give
#: it the idle budget the ai-service gives the same server, not a cloud API's 30s.
SETTINGS_PROVIDER_TIMEOUT_S = 120.0
#: Default wall-clock budget for ONE planning completion. A plan is a long
#: generation even on a fast model, and the transport timeout above is sized
#: for one request, not for a whole plan. Eight minutes matches the budget
#: the Node planner already uses for the same work.
DEFAULT_PLAN_TIMEOUT_S = 480.0
#: Ceiling on the text collected from one planning stream. A plan is
#: structured and can legitimately be long; the answer ceiling (12k) is
#: sized for prose and would truncate a real plan.
MAX_PLAN_CHARS = 64_000
#: Ollama serves a 4096-token window unless told otherwise and the OpenAI-
#: compatible endpoint cannot change that; keep each prompt block small enough
#: that the request is not silently truncated from the front.
SETTINGS_PROVIDER_CONTEXT_CHARS = 5_500


def settings_view_path() -> Path:
    from ..config import aura_path

    return aura_path("agent", SETTINGS_VIEW_FILE)


def read_settings_view() -> dict | None:
    """The published view of the Settings provider, or None when absent or unreadable."""
    try:
        raw = json.loads(settings_view_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def settings_provider_status() -> dict:
    """What Settings has selected and whether the Central Agent can call it.

    ``configured`` is about the Settings choice; ``callable`` says whether the
    Central Agent can reach it (a key-based provider cannot be: its key stays in
    the AURA service). Never contains an address that carries credentials.
    """
    view = read_settings_view()
    active = (view or {}).get("active")
    if not isinstance(active, dict) or not active.get("providerId"):
        return {"configured": False, "callable": False, "reason": "none-selected"}
    return {"configured": True, "providerId": str(active["providerId"]),
            "model": str(active.get("model") or ""), "callable": bool(active.get("callable")),
            "reason": str(active.get("reason") or "")}


def _settings_provider_spec() -> ProviderSpec | None:
    view = read_settings_view()
    active = (view or {}).get("active")
    if not isinstance(active, dict) or not active.get("callable"):
        return None
    try:
        base_url = str(active["baseUrl"]).rstrip("/")
        return ProviderSpec(
            id=str(active["providerId"]), base_url=base_url, model=str(active["model"]),
            api_key_env="", timeout_s=SETTINGS_PROVIDER_TIMEOUT_S,
            plan_timeout_s=DEFAULT_PLAN_TIMEOUT_S, plan_max_retries=0,
            max_context_chars=SETTINGS_PROVIDER_CONTEXT_CHARS, max_output_tokens=2048,
            enabled=True, headers=(), network_class=_infer_network_class(base_url))
    except (KeyError, TypeError, ValueError):
        return None


def provider_fingerprint() -> tuple:
    """Changes whenever either provider file does (mtime and size, no content)."""
    from ..config import aura_path

    out = []
    for f in (aura_path("agent", "providers.json"), settings_view_path()):
        try:
            st = f.stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def load_providers(path: str | None = None) -> list[ProviderSpec]:
    """The providers AURA's reasoning may use, in order.

    1. The operator's own file (~/.aura/agent/providers.json), when it has entries.
    2. The provider chosen in Settings, when the AURA service says the Central
       Agent can call it (self-hosted, keyless). Appended after the operator's
       entries, and skipped when the operator already listed that id: **the
       operator file wins**, and the two never silently conflict.

    An explicit ``path`` reads only that file (tests, tooling).
    """
    specs = _load_operator_providers(path)
    if path is None:
        extra = _settings_provider_spec()
        if extra is not None and all(s.id != extra.id for s in specs):
            specs.append(extra)
    return specs


def _load_operator_providers(path: str | None = None) -> list[ProviderSpec]:
    """Read the operator's provider file (~/.aura/agent/providers.json).

    Unknown fields are ignored; entries missing id/baseUrl/model are
    skipped rather than guessed. apiKeyEnv is now optional — omitting it
    (or setting it to "") marks the provider as keyless (e.g. Ollama,
    private GPU servers). An absent/empty file means NO model routing —
    the deterministic fallback remains the honest default.

    New field: networkClass ("local" | "private" | "cloud" | "unknown").
    Defaults to "local" when baseUrl is a loopback/LAN address, otherwise
    "cloud". Operators SHOULD set this explicitly for private GPU servers.
    """
    document = read_provider_document(path)
    if document.status != PROVIDER_FILE_OK:
        return []
    out: list[ProviderSpec] = []
    for e in document.entries:
        try:
            raw_headers = e.get("headers") or {}
            headers = tuple(
                (str(k), str(v)) for k, v in raw_headers.items()) \
                if isinstance(raw_headers, dict) else ()
            base_url = str(e["baseUrl"]).rstrip("/")
            # api_key_env is optional — keyless providers (Ollama, private
            # servers) omit it or set it to "".
            api_key_env = str(e.get("apiKeyEnv") or "")
            # networkClass: infer from URL when not declared.
            raw_class = str(e.get("networkClass") or "").lower()
            if raw_class not in NETWORK_CLASSES:
                raw_class = _infer_network_class(base_url)
            spec = ProviderSpec(
                id=str(e["id"]), base_url=base_url,
                model=str(e["model"]),
                api_key_env=api_key_env,
                timeout_s=float(e.get("timeoutS", 30)),
                plan_timeout_s=float(e.get("planTimeoutS", 0) or 0),
                plan_max_retries=int(e.get("planMaxRetries", 0) or 0),
                max_context_chars=int(e.get("maxContextChars", 24_000)),
                max_output_tokens=int(e.get("maxOutputTokens", 2048)),
                enabled=e.get("enabled", True) is not False,
                headers=headers,
                network_class=raw_class)
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        out.append(spec)
    return [s for s in out if s.enabled]


def _infer_network_class(base_url: str) -> str:
    """Best-effort classification when the operator does not declare one.

    Loopback → local.  RFC-1918 / link-local ranges → private.
    Everything else → cloud (conservative — unknown treated as cloud
    so sovereign mode is fail-closed, never accidentally permissive).
    """
    try:
        import ipaddress
        import urllib.parse as _up
        host = _up.urlparse(base_url).hostname or ""
        if host in ("localhost", "127.0.0.1", "::1") or host.startswith("127."):
            return "local"
        addr = ipaddress.ip_address(host)
        if addr.is_loopback:
            return "local"
        if addr.is_private:
            return "private"
        return "cloud"
    except (ValueError, Exception):
        # Not an IP — hostname could be internal or external. Without
        # explicit classification we treat it as unknown (= cloud).
        return "unknown"


def _response_diagnostics(content: str, choice: dict, extraction: str,
                         exc: "json.JSONDecodeError | None") -> dict:
    """Sizes, offsets and status words about a reply. Never reply text."""
    finish = choice.get("finish_reason") if isinstance(choice, dict) else None
    return {
        "responseChars": len(content),
        "finishReason": str(finish)[:32] if finish is not None else None,
        "extraction": extraction,
        "parseErrorOffset": exc.pos if exc is not None else None,
        "parseErrorKind": type(exc).__name__ if exc is not None else None,
    }


class RoutingError(Exception):
    diagnostics: dict | None = None
    raw: str | None = None
    #: Useful text produced before the stream was stopped (a loop, a deadline).
    partial: str | None = None

    """All configured providers failed or none is configured.

    Carries a structured failure `category` (see classify_failure) in
    addition to the human message; the message text is unchanged for
    backward compatibility with existing callers and tests.
    """

    def __init__(self, message: str,
                 category: str = "PROVIDER_UNAVAILABLE") -> None:
        super().__init__(message)
        self.category = category


#: Structured failure taxonomy for the provider bridge contract
#: (docs/architecture/PROVIDER-BRIDGE-CONTRACT.md). Categories describe
#: what happened, never why in secret terms: no keys, headers, prompts,
#: or completions may appear in a classified message.
FAILURE_CATEGORIES = frozenset({
    "PROVIDER_NOT_CONFIGURED",
    "MODEL_NOT_CONFIGURED",
    "PROVIDER_UNSUPPORTED",
    "AUTHENTICATION_FAILED",
    "RATE_LIMITED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "INVALID_PROVIDER_RESPONSE",
    "REQUEST_CANCELLED",
    "INTERNAL_PROVIDER_ERROR",
    # The model produced output, but it is not an answer: it fell into a
    # verbatim loop. The text before the loop is kept (RoutingError.partial).
    "DEGENERATE_OUTPUT",
})


def classify_failure(exc: BaseException) -> str:
    """Map a transport/model exception to a failure category.

    Inspects status codes and timeout signals only; the exception text
    itself is never trusted (it may echo endpoint details, never keys —
    keys travel in headers urllib never includes in exceptions).
    """
    if isinstance(exc, _StreamStopped):
        return "REQUEST_CANCELLED"
    status = getattr(exc, "code", None)
    if not isinstance(status, int):
        status = getattr(exc, "status", None)
    if isinstance(status, int):
        if status in (401, 403):
            return "AUTHENTICATION_FAILED"
        if status == 429:
            return "RATE_LIMITED"
        if 500 <= status <= 599:
            return "PROVIDER_UNAVAILABLE"
        return "INTERNAL_PROVIDER_ERROR"
    name = type(exc).__name__
    text = f"{name}: {exc}".lower()
    if ("timeout" in text or "timed out" in text
            or name in ("TimeoutError", "socket.timeout")):
        return "PROVIDER_TIMEOUT"
    if name in ("ConnectionError", "ConnectionRefusedError",
                "gaierror") or "connection" in text or "unreachable" in text \
            or "name resolution" in text or "nodename nor servname" in text:
        return "PROVIDER_UNAVAILABLE"
    if isinstance(exc, ValueError):
        return "INVALID_PROVIDER_RESPONSE"
    return "INTERNAL_PROVIDER_ERROR"


class _StreamStopped(Exception):
    """Cancellation landed mid-stream. Not a failure: partial tokens
    already emitted stay visible and the run settles as cancelled."""


#: Cap on one streamed answer. Read-only synthesis, not a dump.
MAX_STREAM_CHARS = 12_000
#: Wall-clock ceiling on one streamed answer. The socket timeout only catches
#: SILENCE; a model that keeps writing slowly (or looping) never trips it.
MAX_STREAM_SECONDS = 300.0


class _StreamEndedEarly(Exception):
    """AURA stopped a stream that was still producing text: it was looping
    (`kind="loop"`) or ran out its time (`kind="deadline"`). `partial` is the
    useful text so far. Not a provider failure and never a finished answer."""

    def __init__(self, kind: str, partial: str) -> None:
        super().__init__(kind)
        self.kind = kind
        self.partial = partial


def _sse_content(data: str) -> str:
    """The text delta of one OpenAI-compatible SSE data line, or ''."""
    try:
        body = json.loads(data)
    except (ValueError, TypeError):
        return ""
    try:
        delta = (body["choices"][0].get("delta") or {})
        return str(delta.get("content") or "")
    except (KeyError, IndexError, TypeError, AttributeError):
        return ""


CIRCUIT_COOLDOWN_S = 60.0


class RoutedModelPort(ModelPort):
    """ModelPort over a provider chain, tried in order.

    sovereign_policy: when set, providers whose network_class is blocked
    are skipped with an honest error — never silently routed to cloud.
    """

    def __init__(self, providers: list[ProviderSpec],
                 post=None, sovereign_policy=None) -> None:
        self.providers = providers
        self.health: dict[str, ProviderHealth] = {
            p.id: ProviderHealth() for p in providers}
        self._post = post or _http_post_json
        self._circuit_opened_at: dict[str, float] = {}
        self._sovereign_policy = sovereign_policy
        #: Last model call metadata (P1-D observability). Metadata only:
        #: provider id, model name, latency, network_class, outcome —
        #: never keys, headers, prompts, or completions.
        self._last_call: dict | None = None
        #: The most recent real request per provider (ok / error, no content):
        #: what "the model answered" is really based on.
        self._last_by_provider: dict[str, dict] = {}

    def health_snapshot(self) -> dict:
        """Operator-facing per-provider snapshot (legacy name, kept for
        existing callers). See telemetry() for the secret-free route
        payload."""
        now = time.monotonic()
        return {"providers": [
            {"id": p.id, "baseUrl": p.base_url, "model": p.model,
             "networkClass": p.network_class,
             "keyless": not p.api_key_env,
             "calls": self.health[p.id].calls,
             "consecutiveFailures": self.health[p.id].consecutive_failures,
             "lastError": self.health[p.id].last_error,
             "circuit": ("open" if now - self._circuit_opened_at.get(p.id, 0.0)
                         < CIRCUIT_COOLDOWN_S else "closed")}
            for p in self.providers]}

    def telemetry(self) -> dict:
        """Secret-free snapshot of routing state for operators.

        Provider ids, model names, network classification, call counts,
        failures, circuits, and the last call's metadata. API keys,
        headers, prompts, and completions NEVER appear here.
        """
        sovereign = self._sovereign_policy
        return {
            "configured": bool(self.providers),
            "sovereignMode": getattr(sovereign, "sovereign_mode", False),
            "providers": [
                {"id": p.id, "model": p.model,
                 "networkClass": p.network_class,
                 "keyless": not p.api_key_env,
                 "sovereignAllowed": (
                     sovereign.allows(p.network_class)
                     if sovereign is not None else True),
                 "calls": self.health[p.id].calls,
                 "consecutiveFailures":
                     self.health[p.id].consecutive_failures,
                 "lastError": self.health[p.id].last_error,
                 "lastRequest": self._last_by_provider.get(p.id),
                 "circuit": ("open" if self._circuit_open(p) else "closed")}
                for p in self.providers],
            "lastCall": dict(self._last_call) if self._last_call else None,
        }

    def _record_call(self, spec: ProviderSpec, started: float,
                     ok: bool, error: str | None = None) -> None:
        self._last_call = {
            "provider": spec.id,
            "model": spec.model,
            "latencyMs": round((time.monotonic() - started) * 1000, 1),
            "ok": ok,
            "error": (error or "")[:200] if error else None,
        }
        self._last_by_provider[spec.id] = dict(self._last_call)

    def _circuit_open(self, spec: ProviderSpec) -> bool:
        opened_at = self._circuit_opened_at.get(spec.id)
        if opened_at is None:
            return False
        if time.monotonic() - opened_at >= CIRCUIT_COOLDOWN_S:
            del self._circuit_opened_at[spec.id]
            self.health[spec.id].consecutive_failures = 0
            return False
        return True

    def complete_stream(self, system: str, user: str,
                          on_token=None, should_stop=None) -> str | None:
        """Stream user-facing answer text over the provider chain.

        OpenAI-compatible SSE (`stream: true`) on the same endpoints,
        keys and health tracking as `complete_json` — one routing
        abstraction, not a second provider path. `should_stop` aborts
        between chunks (cancellation reaches the provider stream, not
        just the UI). Mid-stream failure raises RoutingError: partial
        tokens already emitted stay visible and the caller falls back
        to its deterministic record — never a fabricated completion.

        Keyless providers (api_key_env == "") skip the Authorization
        header entirely — this is the normal case for Ollama and other
        self-hosted servers that authenticate by network location, not key.
        """
        last_error = "no providers configured"
        last_exc: BaseException | None = None
        attempted = False
        for spec in self.providers:
            health = self.health[spec.id]
            if self._circuit_open(spec):
                continue
            if self._sovereign_policy is not None:
                if not self._sovereign_policy.allows(spec.network_class):
                    health.last_error = (
                        f"blocked by sovereign policy"
                        f" (network_class={spec.network_class!r})")
                    last_exc = _SovereignBlocked(
                        f"{spec.id}: network_class {spec.network_class!r}"
                        f" not permitted in sovereign mode")
                    continue
            if not spec.model:
                health.last_error = "entry has no model configured"
                last_exc = ValueError(f"{spec.id}: no model configured")
                continue
            # Keyless check: api_key_env="" means no key required.
            if spec.api_key_env:
                key = os.environ.get(spec.api_key_env, "")
                if not key:
                    health.last_error = f"env {spec.api_key_env} not set"
                    last_exc = ValueError(f"{spec.id}: provider key not configured")
                    continue
            else:
                key = ""  # keyless — no Authorization header
            attempted = True
            payload = {
                "model": spec.model,
                "messages": [
                    {"role": "system",
                     "content": fit_text(system, spec.max_context_chars)},
                    {"role": "user",
                     "content": fit_text(user, spec.max_context_chars)},
                ],
                "temperature": 0.2,
                "stream": True,
                "reasoning_effort": "none",
            }
            # Bound generation at the provider too, not only after the fact: an
            # unbounded stream from a looping model costs minutes of CPU.
            if spec.max_output_tokens > 0:
                payload["max_tokens"] = spec.max_output_tokens
            headers: dict[str, str] = {
                "content-type": "application/json",
                "accept": "text/event-stream",
                **dict(spec.headers),
            }
            if key:
                headers["authorization"] = f"Bearer {key}"
            started = time.monotonic()
            try:
                return self._stream_one(spec, payload, headers,
                                        on_token, should_stop)
            except _StreamStopped:
                self._record_call(spec, started, False, "stopped")
                return None
            except _StreamEndedEarly as early:
                # Output existed but is not an answer. Counted as a failed call
                # for health, never retried on another provider mid-stream (its
                # tokens are already on screen), and reported with its partial.
                health.consecutive_failures += 1
                health.last_error = ("stopped: repeating itself" if early.kind == "loop"
                                     else "stopped: took too long")
                self._record_call(spec, started, False, health.last_error)
                err = RoutingError(
                    f"{spec.id}: {health.last_error}",
                    "DEGENERATE_OUTPUT" if early.kind == "loop" else "PROVIDER_TIMEOUT")
                err.partial = early.partial
                raise err
            except Exception as exc:
                health.consecutive_failures += 1
                health.last_error = str(exc)[:200]
                last_error = f"{spec.id}: {str(exc)[:120]}"
                last_exc = exc
                if health.consecutive_failures >= 5:
                    self._circuit_opened_at.setdefault(
                        spec.id, time.monotonic())
                self._record_call(spec, started, False, str(exc))
                continue
        raise RoutingError(f"model routing failed ({last_error})",
                           _routing_category(self.providers, attempted,
                                             last_exc))

    def _stream_one(self, spec: ProviderSpec, payload: dict,
                    headers: dict, on_token, should_stop,
                    deadline_s: float | None = None,
                    idle_s: float | None = None,
                    use_guard: bool = True,
                    max_chars: int | None = None,
                    incremental: bool = False) -> str:
        """One provider's SSE stream. Raises _StreamStopped on
        cancellation, other exceptions on transport/model failure.

        deadline_s: overall wall-clock ceiling for the stream. The default
        is MAX_STREAM_SECONDS; a caller with its own budget passes it, so
        "how long may this whole generation take" is a decision the caller
        makes rather than a constant every path shares.
        idle_s: how long the connection may stay silent before it counts as
        hung. Defaults to the provider's transport timeout; that value is
        then an IDLE check between chunks instead of a total deadline,
        which is what keeps a slow-but-alive model from being killed.
        use_guard: whether to stop a model that has fallen into a verbatim
        repetition loop. Prose answers want it; a structured payload does
        not, because repeated JSON fields are legitimate structure.
        max_chars: ceiling on the collected text.
        incremental: read whatever has arrived instead of waiting for a
        full buffer, so the deadline is checked often rather than only
        once per 4 KiB.
        """
        import urllib.request as _request

        started = time.monotonic()
        req = _request.Request(
            f"{spec.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers, method="POST")
        health = self.health[spec.id]
        parts: list[str] = []
        total = 0
        done = False
        from .repetition import RepetitionGuard

        guard = RepetitionGuard()
        ceiling = MAX_STREAM_SECONDS if deadline_s is None else deadline_s
        room_limit = MAX_STREAM_CHARS if max_chars is None else max_chars
        # The socket timeout is the idle check: the connection may go quiet
        # for this long between chunks, but not for the whole generation.
        resp = _request.urlopen(req, timeout=spec.timeout_s if idle_s is None
                                else idle_s)
        try:
            buf = b""
            while not done:
                if callable(should_stop) and should_stop():
                    raise _StreamStopped()
                if time.monotonic() - started > ceiling:
                    raise _StreamEndedEarly("deadline", "".join(parts))
                chunk = resp.read1(4096) if incremental else resp.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.decode("utf-8", "replace").strip()
                    if not text.startswith("data:"):
                        continue
                    data = text[5:].strip()
                    if data == "[DONE]":
                        done = True
                        break
                    piece = _sse_content(data)
                    if not piece:
                        continue
                    # Cancellation is honoured per piece, not only per network
                    # read: one read can carry dozens of tokens.
                    if callable(should_stop) and should_stop():
                        raise _StreamStopped()
                    room = room_limit - total
                    if room <= 0:
                        done = True
                        break
                    piece = piece[:room]
                    parts.append(piece)
                    total += len(piece)
                    health.calls += 1
                    if callable(on_token):
                        on_token(piece)
                    if use_guard and guard.feed(piece):
                        raise _StreamEndedEarly("loop", guard.useful_text())
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001 — close is best-effort
                pass
        if not parts:
            raise ValueError("provider returned no text")
        health.consecutive_failures = 0
        self._circuit_opened_at.pop(spec.id, None)
        self._record_call(spec, started, True)
        return "".join(parts)

    def complete_json(self, system: str, user: str) -> dict | None:
        last_error = "no providers configured"
        last_exc: BaseException | None = None
        attempted = False
        for spec in self.providers:
            health = self.health[spec.id]
            if self._circuit_open(spec):
                continue  # cooling down; re-enters rotation after the window
            if self._sovereign_policy is not None:
                if not self._sovereign_policy.allows(spec.network_class):
                    health.last_error = (
                        f"blocked by sovereign policy"
                        f" (network_class={spec.network_class!r})")
                    last_exc = _SovereignBlocked(
                        f"{spec.id}: network_class {spec.network_class!r}"
                        f" not permitted in sovereign mode")
                    continue
            if not spec.model:
                health.last_error = "entry has no model configured"
                last_exc = ValueError(f"{spec.id}: no model configured")
                continue
            # Keyless check: api_key_env="" means no key required (Ollama etc.)
            if spec.api_key_env:
                key = os.environ.get(spec.api_key_env, "")
                if not key:
                    health.last_error = f"env {spec.api_key_env} not set"
                    last_exc = ValueError(f"{spec.id}: provider key not configured")
                    continue
            else:
                key = ""  # keyless server
            attempted = True
            payload = {
                "model": spec.model,
                "messages": [
                    {"role": "system", "content": fit_text(system, spec.max_context_chars)},
                    {"role": "user", "content": fit_text(user, spec.max_context_chars)},
                ],
                "temperature": 0,
                "reasoning_effort": "none",
            }
            if spec.max_output_tokens > 0:
                payload["max_tokens"] = spec.max_output_tokens
            headers: dict[str, str] = {
                "content-type": "application/json",
                **dict(spec.headers),
            }
            if key:
                headers["authorization"] = f"Bearer {key}"
            attempt = 0
            while attempt <= spec.max_retries:
                attempt += 1
                health.calls += 1
                started = time.monotonic()
                try:
                    body = self._post(
                        f"{spec.base_url}/chat/completions",
                        payload, headers, spec.timeout_s)
                    choice = body["choices"][0]
                    content = (choice["message"]["content"] or "")
                    match, extraction = _extract_json_object(content)
                    if match is None:
                        # The provider SPOKE but produced no JSON object.
                        # Retrying the same endpoint hides a systematic
                        # problem — fail over with an honest reason instead.
                        raise ModelResponseError(
                            "provider returned no JSON object",
                            diagnostics=_response_diagnostics(
                                content, choice, extraction, None),
                            raw=content)
                    try:
                        parsed = json.loads(match)
                    except json.JSONDecodeError as exc:
                        raise ModelResponseError(
                            f"provider JSON did not parse: {exc}",
                            diagnostics=_response_diagnostics(
                                content, choice, extraction, exc),
                            raw=content) from None
                    health.consecutive_failures = 0
                    self._circuit_opened_at.pop(spec.id, None)
                    self._record_call(spec, started, True)
                    return parsed
                except Exception as exc:
                    health.consecutive_failures += 1
                    health.last_error = str(exc)[:200]
                    last_error = f"{spec.id}: {str(exc)[:120]}"
                    last_exc = exc
                    if health.consecutive_failures >= 5:
                        self._circuit_opened_at.setdefault(
                            spec.id, time.monotonic())
                    if attempt > spec.max_retries:
                        self._record_call(spec, started, False, str(exc))
                        break
                    time.sleep(min(2 ** attempt * 0.25, 2.0))
        err = RoutingError(f"model routing failed ({last_error})",
                           _routing_category(self.providers, attempted,
                                             last_exc))
        err.diagnostics = getattr(last_exc, "diagnostics", None)
        err.raw = getattr(last_exc, "raw", None)
        raise err

    def complete_json_plan(self, system: str, user: str) -> dict | None:
        """One JSON object for a PLANNING completion, on its own budget.

        A plan is a long generation, not a chat turn, so it does not
        share the transport budget: the provider's ``timeout_s`` becomes
        an IDLE check between chunks (a slow-but-alive model keeps
        streaming and is not killed), while the overall ceiling is the
        planning budget. Retries are not multiplied by that budget: a
        retried plan costs the owner the whole wait again, so each
        provider gets one attempt unless the operator says otherwise.
        """
        last_error = "no providers configured"
        last_exc: BaseException | None = None
        attempted = False
        for spec in self.providers:
            health = self.health[spec.id]
            if self._circuit_open(spec):
                continue  # cooling down; re-enters rotation after the window
            if self._sovereign_policy is not None \
                    and not self._sovereign_policy.allows(spec.network_class):
                health.last_error = (
                    f"blocked by sovereign policy"
                    f" (network_class={spec.network_class!r})")
                last_exc = _SovereignBlocked(
                    f"{spec.id}: network_class {spec.network_class!r}"
                    f" not permitted in sovereign mode")
                continue
            if not spec.model:
                health.last_error = "entry has no model configured"
                last_exc = ValueError(f"{spec.id}: no model configured")
                continue
            if spec.api_key_env:
                key = os.environ.get(spec.api_key_env, "")
                if not key:
                    health.last_error = f"env {spec.api_key_env} not set"
                    last_exc = ValueError(f"{spec.id}: provider key not configured")
                    continue
            else:
                key = ""  # keyless server
            attempted = True
            payload = {
                "model": spec.model,
                "messages": [
                    {"role": "system", "content": fit_text(system, spec.max_context_chars)},
                    {"role": "user", "content": fit_text(user, spec.max_context_chars)},
                ],
                "temperature": 0,
                "stream": True,
                "reasoning_effort": "none",
            }
            if spec.max_output_tokens > 0:
                payload["max_tokens"] = spec.max_output_tokens
            headers: dict[str, str] = {
                "content-type": "application/json",
                "accept": "text/event-stream",
                **dict(spec.headers),
            }
            if key:
                headers["authorization"] = f"Bearer {key}"
            budget = spec.plan_timeout_s or DEFAULT_PLAN_TIMEOUT_S
            attempt = 0
            while attempt <= max(0, spec.plan_max_retries):
                attempt += 1
                health.calls += 1
                started = time.monotonic()
                try:
                    content = self._stream_one(
                        spec, payload, headers, None, None,
                        deadline_s=budget, idle_s=spec.timeout_s,
                        use_guard=False, max_chars=MAX_PLAN_CHARS,
                        incremental=True)
                    match, extraction = _extract_json_object(content)
                    if match is None:
                        # The provider SPOKE but produced no JSON object.
                        raise ModelResponseError(
                            "provider returned no JSON object",
                            diagnostics=_response_diagnostics(
                                content, {}, extraction, None),
                            raw=content)
                    try:
                        parsed = json.loads(match)
                    except json.JSONDecodeError as exc:
                        raise ModelResponseError(
                            f"provider JSON did not parse: {exc}",
                            diagnostics=_response_diagnostics(
                                content, {}, extraction, exc),
                            raw=content) from None
                    health.consecutive_failures = 0
                    self._circuit_opened_at.pop(spec.id, None)
                    self._record_call(spec, started, True)
                    return parsed
                except Exception as exc:
                    health.consecutive_failures += 1
                    health.last_error = str(exc)[:200]
                    last_error = f"{spec.id}: {str(exc)[:120]}"
                    last_exc = exc
                    if health.consecutive_failures >= 5:
                        self._circuit_opened_at.setdefault(
                            spec.id, time.monotonic())
                    if attempt > max(0, spec.plan_max_retries):
                        self._record_call(spec, started, False, str(exc))
                        break
                    time.sleep(min(2 ** attempt * 0.25, 2.0))
        err = RoutingError(f"model routing failed ({last_error})",
                           _routing_category(self.providers, attempted,
                                             last_exc))
        err.diagnostics = getattr(last_exc, "diagnostics", None)
        err.raw = getattr(last_exc, "raw", None)
        raise err


def _routing_category(providers: list[ProviderSpec], attempted: bool,
                      last_exc: BaseException | None) -> str:
    """Final category when the whole chain yields nothing.

    Nothing attempted means configuration, not outage: an empty chain,
    entries skipped for missing keys/models, or all providers blocked by
    sovereign policy → PROVIDER_NOT_CONFIGURED (MODEL_NOT_CONFIGURED when
    every enabled entry lacks a model).  Otherwise the last failure decides.
    """
    if not attempted:
        if providers and all(not p.model for p in providers if p.enabled):
            return "MODEL_NOT_CONFIGURED"
        return "PROVIDER_NOT_CONFIGURED"
    if last_exc is None:
        return "PROVIDER_UNAVAILABLE"
    if isinstance(last_exc, _SovereignBlocked):
        return "PROVIDER_NOT_CONFIGURED"
    return classify_failure(last_exc)


class _SovereignBlocked(Exception):
    """Raised internally when sovereign policy rejects a provider."""


def fit_text(text: str, limit: int) -> str:
    """Bound ``text`` to ``limit`` characters, keeping the END.

    The question or instruction a prompt ends with is the part that must never
    be cut, so when something has to go it is the middle: the head keeps a third
    of the budget, the tail two thirds, and a marker says text was removed.
    """
    if limit <= 0 or len(text) <= limit:
        return text
    marker = "\n…[trimmed to fit the model's context]…\n"
    room = max(0, limit - len(marker))
    head = room // 3
    return text[:head] + marker + text[len(text) - (room - head):]


def _http_post_json(url: str, payload: dict, headers: dict,
                    timeout_s: float) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read(8 * 1024 * 1024))


def _balanced_end(text: str, start: int) -> int | None:
    """Index of the brace closing the object opened at ``start``, honouring
    JSON string literals and escapes, or None when it never closes."""
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
    return None


def _extract_json_object(text: str) -> tuple[str | None, str]:
    """The JSON object a reply carries, and how it was found.

    Rules, chosen so that no nested fragment is ever accepted in place of a
    malformed whole:
      * a fenced block wins when present;
      * otherwise each top-level ``{`` is tried in order. A candidate that
        does not close means the reply was cut off inside it, so the scan
        stops there; a candidate that closes and parses is returned;
      * a candidate that closes but does not parse is skipped together with
        everything inside it (no nested object is accepted from a malformed
        outer one), so prose braces before the real object are tolerated.

    Status: ``fenced``, ``balanced`` (a parse-valid object was found),
    ``invalid`` (closed candidates existed, none parsed; the first is
    returned so the parser can report its offset), ``unbalanced`` (the reply
    was cut off inside an object) or ``none``.
    """
    import re

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        return fenced.group(1), "fenced"
    first_invalid: str | None = None
    pos = text.find("{")
    while pos != -1:
        end = _balanced_end(text, pos)
        if end is None:
            if first_invalid is not None:
                return first_invalid, "invalid"
            return text[pos:], "unbalanced"
        candidate = text[pos:end + 1]
        try:
            if isinstance(json.loads(candidate), dict):
                return candidate, "balanced"
        except ValueError:
            pass
        if first_invalid is None:
            first_invalid = candidate
        pos = text.find("{", end + 1)
    if first_invalid is not None:
        return first_invalid, "invalid"
    return None, "none"


def _first_json_object(text: str) -> str | None:
    return _extract_json_object(text)[0]


class ModelResponseError(ValueError):
    """The provider answered, but the reply was not a usable JSON object.

    ``diagnostics`` holds only sizes, offsets and status words, never reply
    text. ``raw`` holds the reply in memory so a caller that opted in can
    capture it. It is never placed in messages or logs.
    """

    def __init__(self, message: str, *, diagnostics: dict, raw: str) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics
        self.raw = raw

