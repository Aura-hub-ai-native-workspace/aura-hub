"""Provider bridge — the Central Agent's single model-inference boundary.

A narrow facade over the existing `ModelPort`, adding structure without
transport: structured results with provider/model identity, failure
taxonomy, correlation propagation, and secret hygiene. It performs no
planning, approval, execution, or verification — inference only, so it
can never become a second execution authority.

Contract: docs/architecture/PROVIDER-BRIDGE-CONTRACT.md.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from .intent import ModelPort
from .model_routing import FAILURE_CATEGORIES, RoutingError, _StreamStopped

#: Purposes the bridge will serve. Anything else is rejected rather
#: than silently served — the agent loop owns what inference is FOR.
PURPOSES = frozenset({"intent", "plan", "answer"})

#: Categories after which deterministic fallback is appropriate
#: (configuration problems, not outages). Anything else fails closed.
DEGRADED_CATEGORIES = frozenset({
    "PROVIDER_NOT_CONFIGURED",
    "MODEL_NOT_CONFIGURED",
    "PROVIDER_UNSUPPORTED",
})


@dataclass
class BridgeResult:
    """One model call, structured. Metadata only — never prompts,
    completions beyond the returned text/data, keys, or headers."""

    ok: bool
    provider: str = "unknown"
    model: str = "unknown"
    text: str | None = None
    data: dict | None = None
    latencyMs: float | None = None
    requestId: str | None = None
    sessionId: str | None = None
    purpose: str = "answer"
    degraded: bool = False
    error_category: str | None = None
    error: str | None = None


_SENSITIVE_KEY_RE = re.compile(
    r"api[_-]?key|apikey|authorization|bearer|secret|passwd|password|"
    r"client[_-]?secret|access[_-]?token|refresh[_-]?token",
    re.IGNORECASE)
_BEARER_VALUE_RE = re.compile(r"\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}",
                              re.IGNORECASE)


def redact_secrets(value: Any) -> Any:
    """Recursively replace secret-shaped values with [REDACTED].

    Applied before anything crosses into logs, telemetry, events, or
    test assertions. String values under sensitive key names, Bearer
    tokens embedded in text, and long hex blobs beside key-like words
    are all treated as hostile until proven otherwise.
    """
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if _SENSITIVE_KEY_RE.search(str(k))
                    else redact_secrets(v))
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        redacted = [redact_secrets(v) for v in value]
        return type(value)(redacted) if isinstance(value, tuple) else redacted
    if isinstance(value, str):
        cleaned = _BEARER_VALUE_RE.sub("Bearer [REDACTED]", value)
        if cleaned != value:
            return cleaned
        if len(value) >= 20 and re.fullmatch(r"[A-Za-z0-9\-._~+/=]+",
                                             value):
            return "[REDACTED]"
        return value
    return value


class ProviderBridge:
    """Structured inference over a ModelPort. One instance per agent;
    stateless across calls except for what the port itself tracks."""

    def __init__(self, port: ModelPort | None) -> None:
        self._port = port

    @property
    def available(self) -> bool:
        """A port exists. Reachability is proven per call, never cached."""
        return self._port is not None

    def _identity(self) -> tuple[str, str, float | None]:
        """Provider/model/latency from the port's last call, or honest
        unknowns. Reads telemetry only — never prompts, keys, or text."""
        try:
            telemetry = getattr(self._port, "telemetry", None)
            last = (telemetry() or {}).get("lastCall") \
                if callable(telemetry) else None
        except Exception:
            last = None
        if not isinstance(last, dict):
            return "unknown", "unknown", None
        return (str(last.get("provider") or "unknown"),
                str(last.get("model") or "unknown"),
                last.get("latencyMs")
                if isinstance(last.get("latencyMs"), (int, float))
                else None)

    def _base(self, purpose: str, session_id: str | None,
              request_id: str | None) -> dict:
        if purpose not in PURPOSES:
            raise ValueError(f"unsupported bridge purpose: {purpose!r}")
        return {"purpose": purpose, "sessionId": session_id,
                "requestId": request_id}

    def complete_json(self, purpose: str, system: str, user: str,
                      session_id: str | None = None,
                      request_id: str | None = None) -> BridgeResult:
        """Structured JSON completion. Returns ok=False (never raises
        for provider conditions) except on programmer errors."""
        base = self._base(purpose, session_id, request_id)
        port = self._port
        if port is None:
            return BridgeResult(ok=False, degraded=True,
                                error_category="PROVIDER_NOT_CONFIGURED",
                                error="no model provider configured", **base)
        started = time.monotonic()
        try:
            data = port.complete_json(system, user)
        except RoutingError as exc:
            category = exc.category \
                if exc.category in FAILURE_CATEGORIES \
                else "INTERNAL_PROVIDER_ERROR"
            return BridgeResult(
                ok=False, degraded=category in DEGRADED_CATEGORIES,
                error_category=category, error=str(exc)[:300], **base)
        except Exception as exc:
            return BridgeResult(
                ok=False, degraded=False,
                error_category="INTERNAL_PROVIDER_ERROR",
                error=f"{type(exc).__name__}: {exc}"[:300], **base)
        if data is None:
            return BridgeResult(
                ok=False, degraded=True,
                error_category="PROVIDER_UNAVAILABLE",
                error="the model returned nothing usable", **base)
        provider, model, latency = self._identity()
        if latency is None:
            latency = round((time.monotonic() - started) * 1000, 1)
        return BridgeResult(ok=True, provider=provider, model=model,
                            data=dict(data), latencyMs=latency, **base)

    def complete_stream(self, purpose: str, system: str, user: str,
                        on_token=None, should_stop=None,
                        session_id: str | None = None,
                        request_id: str | None = None) -> BridgeResult:
        """Structured streamed completion. Token delivery, cancellation,
        and empty-output handling mirror the port contract; this layer
        only adds identity, taxonomy, and correlation."""
        from .model_routing import classify_failure

        base = self._base(purpose, session_id, request_id)
        port = self._port
        if port is None:
            return BridgeResult(ok=False, degraded=True,
                                error_category="PROVIDER_NOT_CONFIGURED",
                                error="no model provider configured", **base)
        stream_fn = getattr(port, "complete_stream", None)
        if not callable(stream_fn):
            return BridgeResult(
                ok=False, degraded=True,
                error_category="PROVIDER_UNSUPPORTED",
                error="the configured port does not support streaming",
                **base)
        started = time.monotonic()
        try:
            text = stream_fn(system, user, on_token=on_token,
                             should_stop=should_stop)
        except _StreamStopped:
            return BridgeResult(
                ok=False, degraded=False,
                error_category="REQUEST_CANCELLED",
                error="stopped before completion", **base)
        except RoutingError as exc:
            category = exc.category \
                if exc.category in FAILURE_CATEGORIES \
                else "INTERNAL_PROVIDER_ERROR"
            return BridgeResult(
                ok=False, degraded=category in DEGRADED_CATEGORIES,
                error_category=category, error=str(exc)[:300], **base)
        except Exception as exc:
            return BridgeResult(
                ok=False, degraded=False,
                error_category=classify_failure(exc),
                error=f"{type(exc).__name__}: {exc}"[:300], **base)
        if not text or not str(text).strip():
            return BridgeResult(
                ok=False, degraded=False,
                error_category="INVALID_PROVIDER_RESPONSE",
                error="the model returned empty text", **base)
        provider, model, latency = self._identity()
        if latency is None:
            latency = round((time.monotonic() - started) * 1000, 1)
        return BridgeResult(ok=True, provider=provider, model=model,
                            text=str(text), latencyMs=latency, **base)


__all__ = ["BridgeResult", "ProviderBridge", "PURPOSES",
           "DEGRADED_CATEGORIES", "redact_secrets"]
