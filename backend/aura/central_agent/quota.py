"""Quota and limit detection for worker failures.

A worker task can fail for many reasons. Only a genuine usage/quota
exhaustion justifies handing the work to another worker; an ordinary
coding failure, a timeout, an auth problem or a malformed reply must
not be misread as "out of quota" and silently retried elsewhere.

This module classifies a failure string into one of a small set of
categories. It is intentionally conservative: an ambiguous failure
returns ``"unknown"`` and never ``"quota"``.
"""

from __future__ import annotations

import re

# Recognised quota / usage-limit phrasings, case-insensitive. These are
# the strings the CLIs actually print; keep them specific so a task that
# merely mentions "limit" in its own output is not misclassified.
_QUOTA_PATTERNS = (
    r"usage limit",
    r"rate limit",
    r"quota (exceeded|exhausted|reached|exceeded)",
    r"too many requests",
    r"\b429\b",
    r"exceeded your (?:usage|limit|quota|requests|tokens)",
    r"hit your (?:usage|limit|quota)",
    r"limit (reached|exceeded|exhausted)",
    r"out of (?:quota|credits|tokens)",
    r"insufficient (?:quota|credits)",
)

_AUTH_PATTERNS = (
    r"unauthoriz",
    r"\b401\b",
    r"\b403\b",
    r"invalid (?:api[- ]?key|token|credential)",
    r"authentication (?:failed|required|error)",
    r"not (?:logged in|authenticated|authorized)",
    r"please (?:log in|sign in|authenticate)",
    r"expired (?:token|session|credential)",
)

_NETWORK_PATTERNS = (
    r"ECONNRESET", r"ETIMEDOUT", r"ENOTFOUND", r"EAI_AGAIN",
    r"socket hang up", r"network (?:error|unreachable|timeout)",
    r"connection (?:refused|reset|timed out|closed)",
)

_TIMEOUT_PATTERNS = (
    r"timed out", r"timeout", r"TIMEOUT",
)

_MALFORMED_PATTERNS = (
    r"unrecognized flag", r"invalid (?:argument|option|flag)",
    r"command not found", r"ENOENT", r"no such file",
    r"malformed", r"unexpected token", r"parse error",
)


def classify_failure(text: str | None, *, timed_out: bool = False,
                     exit_code: int | None = None) -> str:
    """Return one of: 'quota', 'auth', 'network', 'timeout', 'malformed',
    'ordinary', 'unknown'.

    ``timed_out`` and ``exit_code`` are authoritative for timeout; the
    text is used for everything else. An empty/None text returns
    'unknown' rather than guessing."""
    if timed_out:
        return "timeout"
    s = (text or "").strip()
    if not s:
        return "unknown"
    low = s.lower()
    for pat in _QUOTA_PATTERNS:
        if re.search(pat, low):
            return "quota"
    for pat in _AUTH_PATTERNS:
        if re.search(pat, low):
            return "auth"
    for pat in _NETWORK_PATTERNS:
        if re.search(pat, low, re.IGNORECASE):
            return "network"
    for pat in _TIMEOUT_PATTERNS:
        if re.search(pat, low):
            return "timeout"
    for pat in _MALFORMED_PATTERNS:
        if re.search(pat, low):
            return "malformed"
    # An exit code with a non-empty, unclassified message is an ordinary
    # failure of the work itself, not a quota problem.
    if exit_code is not None and exit_code != 0:
        return "ordinary"
    return "unknown"


def is_quota_exhaustion(text: str | None, *, timed_out: bool = False,
                       exit_code: int | None = None) -> bool:
    return classify_failure(text, timed_out=timed_out,
                           exit_code=exit_code) == "quota"


__all__ = ["classify_failure", "is_quota_exhaustion"]
