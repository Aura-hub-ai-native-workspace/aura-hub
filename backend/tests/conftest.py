"""Pytest bootstrap: make `aura` importable when running from anywhere.

Deferred future-feature suites
-------------------------------
Some tests describe a capability that is deliberately NOT in the current
release. They are not skipped, disabled or deleted: they are simply not
collected by default, because a suite the release is not responsible for
must not be able to fail the release. Their files are untouched and stay
where they are, so implementing the capability later is a matter of
deleting one name from ``DEFERRED_SUITES`` below.

To run them — which is how you check the work before the capability exists
and how you check it once it does — set::

    AURA_RUN_DEFERRED_TESTS=1 python -m pytest backend/tests

Today that is exactly one suite, and it is expected to FAIL while the
capability is absent: it asserts ``web.research`` is registered, and
v0.1.20 excludes it (see
``tests/unit/test_web_research_excluded.py`` for the behaviour the release
does guarantee — that a mission needing it fails closed).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
for p in (str(BACKEND),):
    if p not in sys.path:
        sys.path.insert(0, p)

#: Suites for capabilities that are not in this release, relative to this
#: directory. Collected only when AURA_RUN_DEFERRED_TESTS is set.
# NOTE: test_web_research.py was deferred while web.research was gated; it is
# now in the default suite because the capability is live and governed (v0.1.20).
DEFERRED_SUITES: tuple[()] = ()

if os.environ.get("AURA_RUN_DEFERRED_TESTS") != "1" and DEFERRED_SUITES:
    collect_ignore = list(DEFERRED_SUITES)

# Frozen-contract locations, shared by vector/golden suites.
MIGRATION_DOCS = REPO / "docs" / "migration"
VECTORS_FILE = MIGRATION_DOCS / "canonicalization-vectors.json"
GOLDEN_DIR = MIGRATION_DOCS / "golden"
SCHEMA_DIR = MIGRATION_DOCS / "schemas"


# ── worker billing policy in tests ────────────────────────────────────────
# Product default is deny-all (aura/workers/billing.py). Tests that exercise
# dispatch with fake workers would all be refused, so they run under a policy
# that lets every worker id through. This is test-only plumbing: the product
# reads the owner's file and has no bypass. Tests that check the policy itself
# opt out with ``@pytest.mark.real_billing_policy``.
import pytest  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "real_billing_policy: run with the product's real deny-by-default worker billing policy")
    config.addinivalue_line(
        "markers", "real_agent_architecture: run with the product's default (agents write code, Laya does not)")


@pytest.fixture(autouse=True)
def _workers_allowed_unless_testing_the_policy(request, monkeypatch):
    if request.node.get_closest_marker("real_billing_policy"):
        return
    from aura.workers import billing

    class _All(frozenset):
        def __contains__(self, item):  # every worker id is allowed
            return True

    monkeypatch.setattr(billing, "load_policy", lambda home=None: (frozenset(), _All()))


@pytest.fixture(autouse=True)
def _aura_authoring_allowed_unless_testing_the_architecture(request, monkeypatch):
    """Older tests exercise AURA-written files. The product default is that the
    planning model writes nothing (plan_handoff.authoring_allowed), so those tests
    opt in here; tests of the architecture itself use ``real_agent_architecture``."""
    if request.node.get_closest_marker("real_agent_architecture"):
        return
    from aura.central_agent import plan_handoff

    monkeypatch.setattr(plan_handoff, "authoring_allowed", lambda: True)


@pytest.fixture(autouse=True)
def _every_test_gets_its_own_aura_home(tmp_path_factory, monkeypatch):
    """No test may read or write the person's real ~/.aura. A test that wants a
    specific home sets AURA_HOME itself (that overrides this)."""
    monkeypatch.setenv("AURA_HOME", str(tmp_path_factory.mktemp("aura-home")))


@pytest.fixture(autouse=True)
def _no_real_search_engine_in_tests(monkeypatch):
    """The product falls back to a built-in keyless search provider when no gateway is
    configured. No test may reach a real search engine, so the suite runs with that
    fallback off (the old "nothing configured" state); tests of the fallback itself
    set AURA_SEARCH_PROVIDER back and inject their own fetch."""
    monkeypatch.setenv("AURA_SEARCH_PROVIDER", "off")
