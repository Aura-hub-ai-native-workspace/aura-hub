"""Claude quota exhaustion hands off to the next available worker.

A task that fails with a recognised quota/usage-limit message is retried
on a different worker within the bounded budget. An ordinary failure, an
auth failure, a timeout, a network blip or a malformed reply is NOT
treated as quota exhaustion and does not trigger a cross-worker handoff.
"""

from __future__ import annotations

import pytest

from aura.central_agent.quota import classify_failure, is_quota_exhaustion


@pytest.mark.parametrize("text", [
    "You've hit your usage limit for this session.",
    "rate limit exceeded, retry after 60s",
    "Error: quota exceeded",
    "HTTP 429 Too Many Requests",
    "exceeded your usage limit",
    "out of credits",
    "insufficient quota",
])
def test_quota_phrases_classify_as_quota(text):
    assert is_quota_exhaustion(text) is True
    assert classify_failure(text) == "quota"


@pytest.mark.parametrize("text", [
    "SyntaxError: invalid syntax",
    "Tests failed: 3 assertions",
    "authentication failed: invalid api key",
    "unauthorized (401)",
    "ECONNRESET",
    "timed out after 120s",
    "Unrecognized flag: --dir",
    "I couldn't find the file",
    "",
    None,
])
def test_non_quota_failures_are_not_quota(text):
    assert is_quota_exhaustion(text) is False
    assert classify_failure(text) != "quota"


def test_timeout_flag_wins_over_text():
    # A task that printed a quota-looking line but actually timed out is
    # a timeout, not a quota exhaustion.
    assert classify_failure("usage limit reached", timed_out=True) == "timeout"
    assert is_quota_exhaustion("usage limit reached", timed_out=True) is False


def test_auth_is_not_quota():
    assert classify_failure("401 unauthorized: invalid api key") == "auth"
    assert not is_quota_exhaustion("401 unauthorized: invalid api key")
