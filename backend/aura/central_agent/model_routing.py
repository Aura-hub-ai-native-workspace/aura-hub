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
from dataclasses import dataclass, field
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
    max_context_chars: int = 24_000
    supports_json_mode: bool = True
    enabled: bool = True
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


def load_providers(path: str | None = None) -> list[ProviderSpec]:
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
    from ..config import aura_path

    file = Path(path) if path else aura_path("agent", "providers.json")
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    entries = raw.get("providers") if isinstance(raw, dict) else raw
    out: list[ProviderSpec] = []
    for e in entries if isinstance(entries, list) else []:
        if not isinstance(e, dict):
            continue
        try:
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
                max_context_chars=int(e.get("maxContextChars", 24_000)),
                enabled=e.get("enabled", True) is not False,
                network_class=raw_class)
        except (KeyError, TypeError, ValueError):
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


class RoutingError(Exception):
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
                     "content": system[:spec.max_context_chars]},
                    {"role": "user",
                     "content": user[:spec.max_context_chars]},
                ],
                "temperature": 0.2,
                "stream": True,
            }
            headers: dict[str, str] = {
                "content-type": "application/json",
                "accept": "text/event-stream",
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
                    headers: dict, on_token, should_stop) -> str:
        """One provider's SSE stream. Raises _StreamStopped on
        cancellation, other exceptions on transport/model failure."""
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
        resp = _request.urlopen(req, timeout=spec.timeout_s)
        try:
            buf = b""
            while not done:
                if callable(should_stop) and should_stop():
                    raise _StreamStopped()
                chunk = resp.read(4096)
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
                    room = MAX_STREAM_CHARS - total
                    if room <= 0:
                        done = True
                        break
                    piece = piece[:room]
                    parts.append(piece)
                    total += len(piece)
                    health.calls += 1
                    if callable(on_token):
                        on_token(piece)
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
                    {"role": "system", "content": system[:spec.max_context_chars]},
                    {"role": "user", "content": user[:spec.max_context_chars]},
                ],
                "temperature": 0,
            }
            headers: dict[str, str] = {"content-type": "application/json"}
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
                    content = (body["choices"][0]["message"]["content"] or "")
                    match = _first_json_object(content)
                    if match is None:
                        # The provider SPOKE but produced no JSON object.
                        # Retrying the same endpoint hides a systematic
                        # problem — fail over with an honest reason instead.
                        raise ValueError("provider returned no JSON object")
                    health.consecutive_failures = 0
                    self._circuit_opened_at.pop(spec.id, None)
                    self._record_call(spec, started, True)
                    return json.loads(match)
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
        raise RoutingError(f"model routing failed ({last_error})",
                           _routing_category(self.providers, attempted,
                                             last_exc))


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


def _http_post_json(url: str, payload: dict, headers: dict,
                    timeout_s: float) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read(8 * 1024 * 1024))


def _first_json_object(text: str) -> str | None:
    import re

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        return fenced.group(1)
    bare = re.search(r"\{.*\}", text, re.S)
    return bare.group(0) if bare else None

