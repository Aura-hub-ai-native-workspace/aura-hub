"""Read-only enforcement, scope classes, and parse diagnostics for the shadow.

These cover the reported regressions: a read-only security review and a
parallel read-only investigation both produced a ``code`` worker. A candidate
that breaks an explicit or authority-derived read-only constraint is rejected,
not rewritten, and valid coding requests still pass.
"""

from __future__ import annotations

import os
import stat

import pytest

from aura.central_agent import shadow_planner as sp
from aura.central_agent.model_routing import RoutingError
from aura.central_agent.planner import TaskPlanner
from aura.contracts import AgentIntent

SESSION = "agt-ro1"
NOW = "2026-01-01T00:00:00Z"


def _planner() -> TaskPlanner:
    return TaskPlanner(
        known_capabilities=lambda: {"agent.delegate", "git.status", "git.commit"},
        known_nodes=lambda: {"opencode"},
    )


def _intent(goal: str, constraints=()) -> AgentIntent:
    return AgentIntent(goal=goal, expectedOutcome="done",
                       constraints=list(constraints))


def _task(tid, role=None, capability="agent.delegate", **extra):
    task = {"id": tid, "description": f"{tid} work",
            "capabilityId": capability,
            "input": {"task": f"do {tid}"},
            "verificationKind": "exit-code",
            "verification": "the worker exits 0", **extra}
    if role is not None:
        task["workerRole"] = role
    return task


def _proposal(*tasks) -> dict:
    return {"tasks": list(tasks)}


class _Reply:
    def __init__(self, data):
        self.data = data


class _Port:
    def __init__(self, reply=None, exc=None):
        self.reply, self.exc = reply, exc

    def complete_json(self, system, user):
        if self.exc is not None:
            raise self.exc
        return self.reply


def _observe(tmp_path, intent, proposal, auth=None, port=None):
    planner = _planner()
    store = sp.ShadowPlanStore(tmp_path)
    if port is None:
        port = _ProposalPort(proposal)
    shadow = sp.ShadowPlanner(port, store, max_attempts=1)
    if auth is None:
        auth = planner.plan_from_model(
            _intent("x"), SESSION, NOW,
            _proposal(_task("a")))
    future = shadow.observe(intent=intent, system="sys", user=intent.goal,
                            session_id=SESSION, request_id="req-1",
                            authoritative_plan=auth, planner=planner)
    assert future is not None
    return future.result(timeout=10), store


class _ProposalPort:
    """Returns a fixed proposal through the same bridge the shadow uses."""

    def __init__(self, proposal):
        self.proposal = proposal

    def complete_json(self, system, user):
        return self.proposal


def _research_auth(planner: TaskPlanner):
    return planner.plan_from_model(
        _intent("x"), SESSION, NOW,
        _proposal(_task("r1", role="research")))


# ── read-only detection ──────────────────────────────────────────────────


class TestReadOnlyDetection:
    def test_explicit_no_modify_phrase_is_read_only(self):
        intent = _intent("Inspect the project. Do not modify any files.")
        assert sp.read_only_request(intent, intent.goal, None)

    def test_authority_research_only_plan_is_read_only(self):
        planner = _planner()
        auth = _research_auth(planner)
        intent = _intent("Review this project for security problems.")
        assert sp.read_only_request(intent, intent.goal, auth)

    def test_coding_request_is_not_read_only(self):
        planner = _planner()
        auth = planner.plan_from_model(
            _intent("x"), SESSION, NOW,
            _proposal(_task("c", role="code"), _task("v", role="review")))
        intent = _intent("Implement token refresh in src/auth and have another AI review it")
        assert not sp.read_only_request(intent, intent.goal, auth)


# ── the reported regressions ─────────────────────────────────────────────


class TestReportedReadOnlyCases:
    def test_security_review_with_code_worker_is_rejected(self, tmp_path):
        intent = _intent("Review this project for security problems.")
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("security-review", role="code")),
            auth=_research_auth(_planner()))
        assert record.status == "schema-rejected"
        assert record.errorCategory == "SCHEMA:read-only-role"
        assert record.executed is False

    def test_parallel_read_only_with_review_worker_is_rejected(self, tmp_path):
        msg = ("Have OpenCode and Kilo Code investigate the failing tests in "
               "parallel, read only, do not modify files.")
        intent = _intent(msg)
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("opencode", role="research"),
            _task("kilo", role="review")),
            auth=_research_auth(_planner()))
        assert record.status == "schema-rejected"
        assert record.errorCategory == "SCHEMA:read-only-role"

    def test_read_only_with_unset_role_is_rejected(self, tmp_path):
        intent = _intent("Inspect the project. Do not modify any files.")
        record, _ = _observe(tmp_path, intent, _proposal(_task("inspect")))
        assert record.errorCategory == "SCHEMA:read-only-unset-role"

    def test_read_only_with_research_worker_validates(self, tmp_path):
        intent = _intent("Inspect the project. Do not modify any files.")
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("inspect", role="research")))
        assert record.status == "validated"
        assert record.executed is False

    def test_read_only_direct_read_capability_validates(self, tmp_path):
        intent = _intent("Check git status. Do not modify any files.")
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("status", capability="git.status")))
        assert record.status == "validated"

    def test_read_only_direct_write_capability_is_rejected(self, tmp_path):
        intent = _intent("Check git status. Do not modify any files.")
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("commit", capability="git.commit")))
        assert record.errorCategory == "SCHEMA:read-only-capability"
        assert "git.commit" in record.error

    def test_authority_read_only_is_enforced_without_the_phrase(self, tmp_path):
        intent = _intent("Review this project for security problems.")
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("sec", role="code")), auth=_research_auth(_planner()))
        assert record.errorCategory == "SCHEMA:read-only-role"


class TestCodingRequestsStillSupported:
    def test_implement_and_review_validates(self, tmp_path):
        intent = _intent("Implement token refresh in src/auth and have another AI review it")
        record, _ = _observe(tmp_path, intent, _proposal(
            _task("implement", role="code"), _task("review", role="review")))
        assert record.status == "validated"

    def test_code_worker_without_read_only_is_not_blocked(self, tmp_path):
        intent = _intent("Fix the failing parser test")
        record, _ = _observe(tmp_path, intent, _proposal(_task("fix", role="code")))
        assert record.status == "validated"


# ── scope classification ─────────────────────────────────────────────────


class TestScopeClasses:
    @pytest.mark.parametrize("message,label", [
        ("task t1 scope path '.' is not a bounded repo-relative path", "unbounded-scope"),
        ("task t1 declares 7 scope paths; bound is 4", "unbounded-scope"),
        ("task t1 has a non-string scope path", "unbounded-scope"),
        ("task t1 repeats a scope path", "duplicate-scope"),
        ("task t2 scope ['x'] expands beyond its dependencies' scope", "scope-widening"),
    ])
    def test_scope_messages_have_their_own_class(self, message, label):
        assert sp.classify_rejection(message) == label

    def test_dot_scope_is_rejected_as_unbounded_end_to_end(self, tmp_path):
        bad = _task("t1", role="research", scopePaths=["."])
        record, _ = _observe(tmp_path, _intent("Inspect the project"),
                             _proposal(bad))
        assert record.status == "schema-rejected"
        assert record.errorCategory == "SCHEMA:unbounded-scope"


# ── parse diagnostics and opt-in raw capture ─────────────────────────────


def _failing_port(raw: str):
    exc = RoutingError("model routing failed (p: provider JSON did not parse)",
                       "INVALID_PROVIDER_RESPONSE")
    exc.diagnostics = {"responseChars": len(raw), "finishReason": "stop",
                       "extraction": "balanced", "parseErrorOffset": 2120,
                       "parseErrorKind": "JSONDecodeError"}
    exc.raw = raw

    class Port:
        def complete_json(self, system, user):
            raise exc

    return Port()


class TestParseDiagnostics:
    def test_model_failure_records_bounded_diagnostics(self, tmp_path, monkeypatch):
        monkeypatch.delenv(sp.RAW_ENV_FLAG, raising=False)
        raw = "SECRET-REPLY-TEXT " * 50
        record, _ = _observe(tmp_path, _intent("Inspect"), None,
                             port=_failing_port(raw))
        assert record.status == "model-failed"
        assert record.diagnostics["parseErrorOffset"] == 2120
        assert record.diagnostics["responseChars"] == len(raw)
        assert "SECRET-REPLY-TEXT" not in record.model_dump_json()
        assert record.rawCapturePath is None

    def test_raw_capture_is_off_by_default(self, tmp_path, monkeypatch):
        monkeypatch.delenv(sp.RAW_ENV_FLAG, raising=False)
        record, store = _observe(tmp_path, _intent("Inspect"), None,
                                 port=_failing_port("{broken"))
        assert record.rawCapturePath is None
        assert not list(store.root.rglob("*.raw.txt"))

    def test_opt_in_capture_is_owner_only_and_scrubbed(self, tmp_path, monkeypatch):
        monkeypatch.setenv(sp.RAW_ENV_FLAG, "1")
        raw = '{"tasks": [ "bad" "pair"] Bearer abcdefghijklmnop1234567890'
        record, store = _observe(tmp_path, _intent("Inspect"), None,
                                 port=_failing_port(raw))
        assert record.rawCapturePath and record.rawCapturePath.endswith(".raw.txt")
        path = store.root / record.rawCapturePath
        if os.name != "nt":   # POSIX permission bits; Windows reports 0o666/0o777 whatever the ACL says
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        text = path.read_text()
        assert "abcdefghijklmnop1234567890" not in text
        assert '"bad" "pair"' in text

    def test_raw_captures_are_capped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sp, "RAW_CAP_FILES", 3)
        store = sp.ShadowPlanStore(tmp_path)
        for i in range(6):
            store.write_raw(SESSION, f"shadow-{i}", f"reply {i}")
        assert len(list(store.root.rglob("*.raw.txt"))) == 3
