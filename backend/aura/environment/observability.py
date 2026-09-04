"""Making a scan diagnosable without making it dangerous.

Two jobs, deliberately in one place because they are the same judgement made
twice: what may be said about a scan, and what may never be.

:func:`redact` is defense in depth. The scanner does not put raw process
output into any user-visible field — it parses a version out and constructs
its own sentence — but exception text, resolved paths and package metadata
all pass through, and any of them could carry a credential a user put
somewhere surprising. Rather than trusting every future call site to
remember, anything that can reach a log, an API response or a UI card is
scrubbed of values that look like secrets on the way out.

:func:`scan_logger` emits structured, non-secret events so a failure in the
field can be explained from a log rather than reproduced. It logs *counts and
outcomes*, never captured output.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

LOGGER_NAME = "aura.environment"

#: Environment variable names whose *values* must never appear in output.
#: A generous pattern: the cost of redacting something harmless is a few
#: characters, the cost of missing something is a leaked credential.
_SECRET_NAME_RE = re.compile(
    r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|"
    r"PRIVATE|SIGNATURE|SALT|CERT|PASSPHRASE|ACCESS|BEARER)",
    re.IGNORECASE,
)

#: Values shorter than this are too likely to be ordinary words ("true",
#: "1", a username) for blind substring replacement to be safe.
_MIN_SECRET_LENGTH = 8

#: Shapes that are self-evidently credentials wherever they came from.
_SECRET_SHAPES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_\-]{16,}", re.IGNORECASE),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    re.compile(r"(?i)\b(?:bearer|token|api[_-]?key)\s*[:=]\s*\S{8,}"),
)

REDACTED = "[redacted]"


def _secret_values() -> list[str]:
    """Values of environment variables whose names look like credentials."""
    values: list[str] = []
    for name, value in os.environ.items():
        if not value or len(value) < _MIN_SECRET_LENGTH:
            continue
        if _SECRET_NAME_RE.search(name):
            values.append(value)
    # Longest first, so a value that contains another is masked whole.
    values.sort(key=len, reverse=True)
    return values


def redact(text: str) -> str:
    """Remove anything credential-shaped from ``text``.

    Safe to apply to already-clean strings; it is a no-op on them.
    """
    if not text:
        return text
    cleaned = text
    for value in _secret_values():
        if value in cleaned:
            cleaned = cleaned.replace(value, REDACTED)
    for shape in _SECRET_SHAPES:
        cleaned = shape.sub(REDACTED, cleaned)
    return cleaned


def redact_mapping(payload: dict[str, Any]) -> dict[str, Any]:
    """Redact every string in a payload, recursively."""
    out: dict[str, Any] = {}
    for key, value in payload.items():
        out[key] = _redact_value(value)
    return out


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return redact_mapping(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    return value


def scan_logger() -> logging.Logger:
    """The logger for environment scanning.

    Deliberately not configured here — the host application owns handlers and
    levels. Nothing logged through it contains captured process output,
    environment values, or anything :func:`redact` would remove.
    """
    return logging.getLogger(LOGGER_NAME)


def log_scan(
    *,
    duration_ms: int,
    catalog_probed: int,
    found: int,
    discovered: int,
    verified: int,
    executed: int,
    blocked: int,
    refreshed: bool,
    cached: bool,
) -> None:
    """One structured line per scan: enough to explain a bad result later."""
    scan_logger().info(
        "environment scan complete",
        extra={
            "aura_event": "environment.scan",
            "duration_ms": duration_ms,
            "catalog_probed": catalog_probed,
            "found": found,
            "discovered": discovered,
            "verified": verified,
            "executed": executed,
            "blocked": blocked,
            "refreshed": refreshed,
            "cached": cached,
        },
    )


def log_refusal(*, name: str, executable: str, reason: str) -> None:
    """Why AURA declined to run something. The most useful line in the log."""
    scan_logger().info(
        "environment probe refused",
        extra={
            "aura_event": "environment.refused",
            "tool": redact(name),
            "executable": redact(executable),
            "reason": redact(reason),
        },
    )


def log_probe_failure(*, node_id: str, status: str, detail: str) -> None:
    scan_logger().warning(
        "environment probe failed",
        extra={
            "aura_event": "environment.probe_failed",
            "node": node_id,
            "status": status,
            "detail": redact(detail),
        },
    )
