"""Laya shadow planner — candidate plans are recorded, never executed.

Covers: disabled-by-default, schema and model failures with bounded
retries, redaction of secrets, correlation identifiers, typed persistence
with owner-only permissions and retention, the guarantee that shadow
output cannot reach execution or the Fabric, containment of shadow
failures, and isolation of the model port from the authoritative one.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from aura.central_agent import shadow_planner as sp
from aura.central_agent.planner import TaskPlanner
from aura.contracts import AgentIntent, TaskPlan

SESSION = "agt-test1"
NOW = "2026-01-01T00:00:00Z"
SECRET = "Bearer abcdefghijklmnop1234567890"


def _planner() -> TaskPlanner:
    return TaskPlanner(
        known_capabilities=lambda: {"agent.delegate", "git.status"},
        known_nodes=lambda: {"opencode"},
    )


def _intent() -> AgentIntent:
    return AgentIntent(goal="review the auth module", expectedOutcome="reviewed")


def _good_proposal(label: str = "a") -> dict:
    return {"tasks": [{
        "id": label, "description": f"{label} work",
        "capabilityId": "agent.delegate",
        "input": {"task": "do the work"},
        "verificationKind": "exit-code",
        "verification": "the worker exits 0",
    }]}


class FakePort:
    """A ModelPort stand-in. ``reply`` is returned or raised on each call."""

    def __init__(self, reply=None, exc: BaseException | None = None) -> None:
        self.reply = reply
        self.exc = exc
        self.calls = 0

    def complete_json(self, system: str, user: str):
        self.calls += 1
        if self.exc is not None:
            raise self.exc
        return self.reply


def _authoritative(planner: TaskPlanner) -> TaskPlan:
    return planner.plan_from_model(_intent(), SESSION, NOW, _good_proposal("a"))


def _run(port, tmp_path: Path, proposal_planner=None, max_attempts=2,
         auth: TaskPlan | None = None):
    planner = proposal_planner or _planner()
    store = sp.ShadowPlanStore(tmp_path)
    shadow = sp.ShadowPlanner(port, store, max_attempts=max_attempts)
    future = shadow.observe(
        intent=_intent(), system="sys", user="usr", session_id=SESSION,
        request_id="req-42",
        authoritative_plan=auth or _authoritative(planner),
        planner=planner)
    assert future is not None
    record = future.result(timeout=10)
    return record, store


# ── default and flag ─────────────────────────────────────────────────────


class TestFlag:
    def test_disabled_unless_explicitly_enabled(self):
        assert sp.shadow_enabled({}) is False
        assert sp.shadow_enabled({"AURA_LAYA_SHADOW": "0"}) is False
        assert sp.shadow_enabled({"AURA_LAYA_SHADOW": ""}) is False
        assert sp.shadow_enabled({"AURA_LAYA_SHADOW": "1"}) is True

    def test_agent_builds_no_shadow_by_default(self, tmp_path, monkeypatch):
        monkeypatch.delenv("AURA_LAYA_SHADOW", raising=False)
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.intent import IntentCompiler
        from aura.fabric import FabricConfig

        cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                           permissions={}, executors={}, secrets=None)
        agent = CentralAgent(fabric_cfg=cfg,
                             session_store=AgentSessionStore(tmp_path),
                             intent_compiler=IntentCompiler(mode="heuristic"))
        assert agent._shadow is None

    def test_disabled_planner_schedules_nothing(self, tmp_path):
        shadow = sp.ShadowPlanner(FakePort(_good_proposal()),
                                  sp.ShadowPlanStore(tmp_path), enabled=False)
        assert shadow.observe(intent=_intent(), system="s", user="u",
                              session_id=SESSION, request_id=None,
                              authoritative_plan=None,
                              planner=_planner()) is None
        assert shadow.store.list() == []


# ── outcomes ─────────────────────────────────────────────────────────────


class TestOutcomes:
    def test_valid_candidate_is_validated_and_compared(self, tmp_path):
        record, store = _run(FakePort(_good_proposal()), tmp_path)
        assert record.status == "validated"
        assert record.executed is False
        assert record.candidateSummary["taskCount"] == 1
        assert record.comparison["sameCapabilities"] is True
        assert record.comparison["taskCountDelta"] == 0
        assert record.governance["capabilitiesKnown"] is True
        assert record.governance["structureValid"] is True
        assert record.attempts == 1
        assert [r["status"] for r in store.list(SESSION)] == ["validated"]

    def test_schema_failure_is_recorded_not_raised(self, tmp_path):
        bad = {"tasks": [{"id": "x", "description": "d",
                          "capabilityId": "shell.exec",
                          "input": {"task": "rm -rf"}}]}
        record, store = _run(FakePort(bad), tmp_path)
        assert record.status == "schema-rejected"
        assert record.errorCategory == "SCHEMA:unknown-capability"
        assert record.error
        assert record.comparison is None
        assert record.executed is False
        assert store.list(SESSION)[0]["status"] == "schema-rejected"

    def test_model_failure_retries_are_bounded(self, tmp_path):
        port = FakePort(reply=None)  # "returned nothing usable": transient
        record, _ = _run(port, tmp_path, max_attempts=5)
        assert record.status == "model-failed"
        assert record.errorCategory == "PROVIDER_UNAVAILABLE"
        assert record.attempts == sp.MAX_ATTEMPTS == 2
        assert port.calls == 2

    def test_permanent_model_error_is_not_retried(self, tmp_path):
        from aura.central_agent.model_routing import RoutingError

        port = FakePort(exc=RoutingError("no model", "MODEL_NOT_CONFIGURED"))
        record, _ = _run(port, tmp_path)
        assert record.status == "model-failed"
        assert record.attempts == 1
        assert port.calls == 1

    def test_internal_error_is_contained(self, tmp_path):
        class Broken:
            def plan_from_model(self, *a, **k):
                raise RuntimeError("boom")

            def known_capability_ids(self):
                return {"agent.delegate"}

            def known_node_ids(self):
                return set()

        planner = _planner()
        store = sp.ShadowPlanStore(tmp_path)
        shadow = sp.ShadowPlanner(FakePort(_good_proposal()), store)
        future = shadow.observe(intent=_intent(), system="s", user="u",
                                session_id=SESSION, request_id=None,
                                authoritative_plan=_authoritative(planner),
                                planner=Broken())
        record = future.result(timeout=10)
        # Schema rejection path catches the planner's own exception type.
        assert record.status == "schema-rejected"
        assert "boom" in record.error


# ── redaction and correlation ────────────────────────────────────────────


class TestRedactionAndCorrelation:
    def test_secrets_in_candidate_are_redacted_before_storage(self, tmp_path):
        proposal = _good_proposal()
        proposal["authorization"] = SECRET
        proposal["api_key"] = "sk-live-abcdefghijklmnopqrstuvwx"
        record, store = _run(FakePort(proposal), tmp_path)
        assert record.status == "schema-rejected"  # unsupported top-level key
        assert record.candidate["authorization"] == "[REDACTED]"
        assert record.candidate["api_key"] == "[REDACTED]"
        on_disk = next(store.root.rglob("*.json")).read_text()
        assert "abcdefghijklmnop1234567890" not in on_disk
        assert "sk-live-" not in on_disk

    def test_error_text_cannot_leak_a_bearer_token(self, tmp_path):
        from aura.central_agent.model_routing import RoutingError

        port = FakePort(exc=RoutingError(SECRET, "PROVIDER_UNAVAILABLE"))
        record, store = _run(port, tmp_path)
        assert "abcdefghijklmnop1234567890" not in record.error
        assert "abcdefghijklmnop1234567890" not in next(
            store.root.rglob("*.json")).read_text()

    def test_record_carries_correlation_identifiers(self, tmp_path):
        planner = _planner()
        auth = _authoritative(planner)
        record, store = _run(FakePort(_good_proposal()), tmp_path, auth=auth)
        assert record.sessionId == SESSION
        assert record.requestId == "req-42"
        assert record.authoritativePlanId == auth.planId
        assert record.schemaVersion == sp.SCHEMA_VERSION
        assert record.createdAt.endswith("Z")
        assert record.shadowId.startswith("shadow-")

    def test_no_credential_fields_in_record_schema(self):
        fields = {f.lower() for f in sp.ShadowPlanRecord.model_fields}
        for forbidden in ("apikey", "api_key", "token", "secret", "password",
                          "authorization", "credential", "bearer"):
            assert forbidden not in fields


# ── persistence and retention ────────────────────────────────────────────


class TestPersistence:
    def test_record_is_owner_only(self, tmp_path):
        _, store = _run(FakePort(_good_proposal()), tmp_path)
        path = next(store.root.rglob("*.json"))
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

    def test_session_id_cannot_escape_store_root(self, tmp_path):
        store = sp.ShadowPlanStore(tmp_path)
        assert store._session_dir("../../etc").resolve().is_relative_to(
            store.root.resolve())

    def test_retention_prunes_oldest(self, tmp_path):
        store = sp.ShadowPlanStore(tmp_path, max_records=2)
        for i in range(3):
            store.write(sp.ShadowPlanRecord(
                shadowId=f"shadow-{i}", sessionId=SESSION,
                createdAt=NOW, status="model-failed"))
        names = sorted(p.stem for p in store.root.rglob("*.json"))
        assert len(names) == 2
        assert "shadow-0" not in names


# ── governance: a shadow plan can never execute ──────────────────────────


class TestCannotExecute:
    def test_shadow_run_never_reaches_fabric_or_executor(self, tmp_path,
                                                         monkeypatch):
        import aura.fabric as fabric
        from aura.central_agent.execution import ExecutionController

        def refuse(*_a, **_k):
            raise AssertionError("shadow planning must not execute")

        monkeypatch.setattr(fabric, "invoke_fabric", refuse)
        monkeypatch.setattr(ExecutionController, "execute", refuse)
        record, _ = _run(FakePort(_good_proposal()), tmp_path)
        assert record.status == "validated"
        assert record.executed is False

    def test_module_has_no_execution_or_authority_imports(self):
        source = Path(sp.__file__).read_text(encoding="utf-8")
        for forbidden in ("invoke_fabric", "ExecutionController", "fabric",
                          "AuthorityChecker", "executors", "approve(",
                          "permissions"):
            assert forbidden not in source, forbidden

    def test_observe_returns_a_record_never_a_plan(self, tmp_path):
        planner = _planner()
        shadow = sp.ShadowPlanner(FakePort(_good_proposal()),
                                  sp.ShadowPlanStore(tmp_path))
        future = shadow.observe(intent=_intent(), system="s", user="u",
                                session_id=SESSION, request_id=None,
                                authoritative_plan=_authoritative(planner),
                                planner=planner)
        result = future.result(timeout=10)
        assert isinstance(result, sp.ShadowPlanRecord)
        assert not isinstance(result, TaskPlan)


# ── containment in the agent ─────────────────────────────────────────────


class TestContainment:
    def test_shadow_exception_never_reaches_the_request(self, tmp_path):
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.intent import IntentCompiler
        from aura.fabric import FabricConfig

        class Exploding:
            enabled = True

            def observe(self, **_k):
                raise RuntimeError("shadow exploded")

        cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                           permissions={}, executors={}, secrets=None)
        agent = CentralAgent(fabric_cfg=cfg,
                             session_store=AgentSessionStore(tmp_path),
                             intent_compiler=IntentCompiler(mode="heuristic"),
                             shadow_planner=Exploding())
        session = agent.sessions.create("p1")
        # Must not raise even though the shadow raises.
        agent._observe_shadow(_intent(), "review it", session,
                              _authoritative(_planner()))

    def test_disabled_shadow_is_a_no_op_in_the_agent(self, tmp_path):
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.intent import IntentCompiler
        from aura.fabric import FabricConfig

        cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                           permissions={}, executors={}, secrets=None)
        agent = CentralAgent(fabric_cfg=cfg,
                             session_store=AgentSessionStore(tmp_path),
                             intent_compiler=IntentCompiler(mode="heuristic"))
        session = agent.sessions.create("p1")
        agent._observe_shadow(_intent(), "x", session, None)  # no error
        # Nothing was scheduled, so no shadow record exists.
        assert sp.ShadowPlanStore(tmp_path).list() == []


# ── comparison and isolation ─────────────────────────────────────────────


class TestComparison:
    def test_identical_plans_agree_on_every_dimension(self):
        summary = sp.summarize_plan(_authoritative(_planner()))
        cmp = sp.compare_summaries(summary, summary)
        assert cmp["sameCapabilities"] and cmp["sameDependencyStructure"]
        assert cmp["sameWorkerRoles"] and cmp["sameNodePins"]
        assert cmp["taskCountDelta"] == 0
        # Raw measures only: no single combined score is produced.
        assert not any("score" in k.lower() for k in cmp)


class TestIsolation:
    def test_shadow_gets_its_own_routed_port(self):
        from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort

        spec = ProviderSpec(id="p", base_url="http://x", model="m",
                            api_key_env="")
        authoritative = RoutedModelPort([spec])
        isolated = sp.isolated_port(authoritative)
        assert isolated is not authoritative
        assert isolated.health is not authoritative.health
        assert isolated.providers == authoritative.providers

    def test_non_routed_ports_are_passed_through(self):
        port = FakePort(_good_proposal())
        assert sp.isolated_port(port) is port


class TestAuthoritativeResultUnchanged:
    def test_enabling_shadow_does_not_change_the_request_outcome(self, tmp_path):
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.intent import IntentCompiler
        from aura.fabric import FabricConfig

        def agent_with(shadow):
            cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                               permissions={}, executors={}, secrets=None)
            return CentralAgent(
                fabric_cfg=cfg,
                session_store=AgentSessionStore(tmp_path / ("s" if shadow else "b")),
                intent_compiler=IntentCompiler(mode="heuristic"),
                shadow_planner=shadow)

        message = "Review this project for security problems."
        baseline = agent_with(None).submit(message, project_id="p1")
        shadow_store = sp.ShadowPlanStore(tmp_path / "s")
        shadowed_agent = agent_with(sp.ShadowPlanner(
            FakePort(_good_proposal()), shadow_store))
        shadowed = shadowed_agent.submit(message, project_id="p1")
        shadowed_agent._shadow.wait(timeout=10)

        assert (shadowed.status, shadowed.outcome) == (baseline.status, baseline.outcome)
        assert shadowed.performed == baseline.performed
        assert shadowed.verified == baseline.verified
        # The shadow did run, and its record stayed evidence-only.
        records = shadow_store.list()
        assert records and all(r["executed"] is False for r in records)


class _Gate:
    """A port whose call blocks until released, to hold a shadow run in flight."""

    def __init__(self) -> None:
        import threading

        self.release = threading.Event()
        self.calls = 0

    def complete_json(self, system, user):
        self.calls += 1
        self.release.wait(10)
        return _good_proposal()


def _observe(shadow, planner, session=SESSION):
    return shadow.observe(intent=_intent(), system="s", user="u",
                          session_id=session, request_id=None,
                          authoritative_plan=_authoritative(planner),
                          planner=planner)


class TestBudgets:
    def test_concurrency_is_bounded_and_overflow_is_skipped(self, tmp_path):
        gate = _Gate()
        store = sp.ShadowPlanStore(tmp_path)
        shadow = sp.ShadowPlanner(gate, store, max_concurrent=1,
                                  max_per_minute=100)
        planner = _planner()
        first = _observe(shadow, planner)
        second = _observe(shadow, planner)  # slot still held by `first`
        skipped = second.result(timeout=5)
        assert skipped.status == "skipped"
        assert skipped.errorCategory == "BUDGET"
        gate.release.set()
        assert first.result(timeout=10).status == "validated"
        assert shadow.skipped == 1
        assert gate.calls == 1  # the skipped run made no model call

    def test_rate_limit_skips_over_budget_runs(self, tmp_path):
        now = [0.0]
        shadow = sp.ShadowPlanner(FakePort(_good_proposal()),
                                  sp.ShadowPlanStore(tmp_path),
                                  max_per_minute=2, clock=lambda: now[0])
        planner = _planner()
        for _ in range(2):
            _observe(shadow, planner).result(timeout=10)
        assert _observe(shadow, planner).result(timeout=5).status == "skipped"
        now[0] = 61.0  # the sliding window has moved on
        assert _observe(shadow, planner).result(timeout=10).status == "validated"

    def test_skipped_runs_are_still_recorded(self, tmp_path):
        gate = _Gate()
        store = sp.ShadowPlanStore(tmp_path)
        shadow = sp.ShadowPlanner(gate, store, max_concurrent=1,
                                  max_per_minute=100)
        planner = _planner()
        _observe(shadow, planner)
        _observe(shadow, planner)
        gate.release.set()
        shadow.wait(timeout=10)
        assert sorted(r["status"] for r in store.list(SESSION)) == [
            "skipped", "validated"]

    def test_prompt_forwarded_to_the_model_is_bounded(self, tmp_path):
        seen = {}

        class Capture:
            def complete_json(self, system, user):
                seen["user"] = user
                return _good_proposal()

        shadow = sp.ShadowPlanner(Capture(), sp.ShadowPlanStore(tmp_path))
        planner = _planner()
        huge = "x" * (sp.PROMPT_CHAR_CAP * 3)
        shadow.observe(intent=_intent(), system="s", user=huge,
                       session_id=SESSION, request_id=None,
                       authoritative_plan=_authoritative(planner),
                       planner=planner).result(timeout=10)
        assert len(seen["user"]) == sp.PROMPT_CHAR_CAP

    def test_worker_threads_are_daemons(self, tmp_path):
        gate = _Gate()
        shadow = sp.ShadowPlanner(gate, sp.ShadowPlanStore(tmp_path))
        _observe(shadow, _planner())
        assert all(t.daemon for t in shadow._threads)
        gate.release.set()
        shadow.wait(timeout=10)


class TestPrivateStorage:
    def test_directories_and_files_are_owner_only_from_creation(self, tmp_path):
        store = sp.ShadowPlanStore(tmp_path)
        store.write(sp.ShadowPlanRecord(shadowId="shadow-p", sessionId=SESSION,
                                        createdAt=NOW, status="model-failed"))
        assert stat.S_IMODE(os.stat(store.root).st_mode) & 0o077 == 0
        assert stat.S_IMODE(os.stat(store._session_dir(SESSION)).st_mode) & 0o077 == 0
        file = store._session_dir(SESSION) / "shadow-p.json"
        assert stat.S_IMODE(os.stat(file).st_mode) == 0o600
        assert not list(store.root.rglob("*.tmp"))


# ── dependency validation, regressions, scrubbing ────────────────────────
#
# The three candidates below reconstruct the invalid outputs observed in the
# first real-model evaluation (PR #68). The stored records had task ids and
# dependsOn values replaced by [REDACTED] by an over-broad redaction rule,
# so the exact labels are rebuilt from the validator's own error messages.


def _task(tid, depends=(), **extra):
    return {"id": tid, "description": f"{tid} work",
            "capabilityId": "agent.delegate",
            "input": {"task": f"do {tid}"},
            "verificationKind": "exit-code",
            "verification": "the worker exits 0",
            "dependsOn": list(depends), **extra}


def _propose(candidate: dict) -> dict:
    return candidate


OBSERVED_INVALID = {
    "unknown-dependency-token-refresh": (
        "depends on unknown task 'token-refresh-implementation'",
        _propose({"tasks": [
            _task("token-refresh", ["token-refresh-implementation"]),
            _task("ai-review", ["token-refresh"]),
        ]})),
    "unknown-dependency-test-failures": (
        "depends on unknown task 'test-failures'",
        _propose({"tasks": [
            _task("open-code-investigate-tests", ["test-failures"]),
            _task("kilo-investigate-tests", ["test-failures"]),
        ]})),
    "unknown-dependency-build-status": (
        "depends on unknown task 'build-status'",
        _propose({"tasks": [
            _task("investigate-build-failure", ["build-status"]),
            _task("fix-build-failure", ["investigate-build-failure"]),
        ]})),
}


class TestDependencyRejections:
    @pytest.mark.parametrize("name", sorted(OBSERVED_INVALID))
    def test_observed_invalid_candidates_are_rejected_with_the_unknown_id(
            self, tmp_path, name):
        expected_message, proposal = OBSERVED_INVALID[name]
        record, store = _run(FakePort(proposal), tmp_path)
        assert record.status == "schema-rejected"
        assert record.errorCategory == "SCHEMA:unknown-dependency"
        assert expected_message in record.error
        # The regression: the ids are kept, not replaced by [REDACTED].
        stored_ids = [t["id"] for t in record.candidate["tasks"]]
        assert "[REDACTED]" not in stored_ids
        assert record.candidate["tasks"][0]["dependsOn"][0] != "[REDACTED]"
        assert store.list(SESSION)[0]["status"] == "schema-rejected"

    def test_duplicate_ids_are_rejected(self, tmp_path):
        record, _ = _run(FakePort({"tasks": [_task("a"), _task("a")]}), tmp_path)
        assert record.errorCategory == "SCHEMA:duplicate-id"

    def test_self_dependency_is_rejected(self, tmp_path):
        record, _ = _run(FakePort({"tasks": [_task("a", ["a"])]}), tmp_path)
        assert record.errorCategory == "SCHEMA:self-dependency"

    def test_cycle_is_rejected(self, tmp_path):
        proposal = {"tasks": [_task("a", ["b"]), _task("b", ["a"])]}
        record, _ = _run(FakePort(proposal), tmp_path)
        assert record.errorCategory == "SCHEMA:dependency-cycle"

    def test_acceptance_naming_unknown_task_is_rejected(self, tmp_path):
        proposal = {"tasks": [_task("a")],
                    "acceptance": [{"kind": "audit-only", "description": "x",
                                    "tasks": ["ghost"]}]}
        record, _ = _run(FakePort(proposal), tmp_path)
        assert record.errorCategory == "SCHEMA:acceptance-unknown-task"

    def test_a_valid_dependency_chain_validates(self, tmp_path):
        proposal = {"tasks": [_task("investigate"),
                              _task("fix", ["investigate"])],
                    "acceptance": [{"kind": "audit-only", "description": "done",
                                    "tasks": ["investigate", "fix"]}]}
        record, _ = _run(FakePort(proposal), tmp_path)
        assert record.status == "validated"
        assert record.candidateSummary["dependencyEdges"] == [
            ["agent.delegate", "agent.delegate"]]
        assert record.candidateSummary["acceptanceCoverage"] == 1.0


class TestScrubbing:
    def test_identifiers_and_labels_are_never_scrubbed(self):
        for text in ("token-refresh-implementation", "build-status",
                     "open-code-investigate-tests"):
            assert sp.scrub_text(text) == text

    def test_known_secret_shapes_are_scrubbed(self):
        samples = [
            "use sk-abcdefghijklmnop1234 for it",
            "token ghp_abcdefghijklmnop1234567890",
            "AKIAABCDEFGHIJKLMNOP",
            "Bearer abcdefghijklmnop1234567890",
            "password=hunter2",
            "api_key: somethingsecret",
            "deadbeef" * 6,
        ]
        for text in samples:
            out = sp.scrub_text(text)
            assert "[REDACTED]" in out, text

    def test_private_key_block_is_scrubbed(self):
        header = "BEGIN " + "RSA PRIVATE" + " KEY"
        footer = "END " + "RSA PRIVATE" + " KEY"
        block = f"-----{header}-----\nMIIBOgIBAAJBAL\n-----{footer}-----"
        assert "MIIBOg" not in sp.scrub_text(block)

    def test_secret_named_keys_are_replaced_whole(self):
        out = sp.scrub_structure({"tasks": [{"id": "t1",
                                             "input": {"api_key": "x"}}]})
        assert out["tasks"][0]["input"]["api_key"] == "[REDACTED]"
        assert out["tasks"][0]["id"] == "t1"

    def test_user_secret_is_not_forwarded_to_the_model(self, tmp_path):
        seen = {}

        class Capture:
            def complete_json(self, system, user):
                seen["user"] = user
                return _good_proposal()

        planner = _planner()
        shadow = sp.ShadowPlanner(Capture(), sp.ShadowPlanStore(tmp_path))
        shadow.observe(intent=_intent(), system="s",
                       user="deploy with sk-live-abcdefghijklmnop123456 please",
                       session_id=SESSION, request_id=None,
                       authoritative_plan=_authoritative(planner),
                       planner=planner).result(timeout=10)
        assert "sk-live-" not in seen["user"]
        assert "[REDACTED]" in seen["user"]

    def test_secret_echoed_into_a_description_is_scrubbed_before_storage(
            self, tmp_path):
        proposal = {"tasks": [_task("a")]}
        proposal["tasks"][0]["description"] = "use token ghp_abcdefghijklmnop1234567890"
        record, store = _run(FakePort(proposal), tmp_path)
        assert record.status == "validated"
        assert "ghp_abcdefghijklmnop" not in record.candidate["tasks"][0]["description"]
        assert "ghp_abcdefghijklmnop" not in next(store.root.rglob("*.json")).read_text()


class TestShadowPrompt:
    def test_prompt_defines_ids_before_dependency_references(self, tmp_path):
        from aura.central_agent import AgentSessionStore, CentralAgent
        from aura.central_agent.intent import IntentCompiler
        from aura.fabric import FabricConfig

        cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                           permissions={}, executors={}, secrets=None)
        agent = CentralAgent(fabric_cfg=cfg,
                             session_store=AgentSessionStore(tmp_path),
                             intent_compiler=IntentCompiler(mode="heuristic"))
        prompt = agent._shadow_system_prompt()
        assert "TASK IDS AND DEPENDENCIES" in prompt
        assert "define every task" in prompt
        assert "ONLY ids" in prompt
        assert "never depends on itself" in prompt
        assert "ACCEPTANCE" in prompt
        # The authoritative prompt is not changed by the shadow rules.
        from aura.central_agent.service import _PLAN_PROPOSAL_SYSTEM
        assert "TASK IDS AND DEPENDENCIES" not in _PLAN_PROPOSAL_SYSTEM
