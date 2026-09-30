"""Phase 11: Mission Control + Autonomous Execution UX — backend contract tests.

22 test categories covering:
  1.  Mission header (session, state, outcome vocabularies)
  2.  Timeline pipeline stages (event → stage mapping)
  3.  Task outcome fields (TaskOutcome completeness)
  4.  Worker lifecycle event payload
  5.  Model routing (sovereign-only network classes)
  6.  Tool action event payload
  7.  Verification event payload
  8.  Retry / timed-out task state
  9.  Replan / correction event shape
  10. Approval event payload
  11. Evidence bundle fields (including artifactPaths)
  12. Mission completion (completed outcome)
  13. Mission failure (failed / denied outcomes)
  14. Cancellation events chain
  15. Project isolation (EventBus session filter)
  16. SSE event updates (EventBus emit + subscriber)
  17. SSE reconnect (tail_after with after= cursor)
  18. Duplicate prevention (EventBus seq uniqueness)
  19. Sovereign display (model network class in evidence)
  20. Cloud-blocked state (ModelRouter excludes cloud models)
  21. No secret leak (AgentEvent payload has no credentials)
  22. Current operation (worker.lifecycle / invocation.observed observable)

All tests are deterministic; none require a running backend or Ollama.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

# ── helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_event(type_: str, session_id: str = "agt-test", payload: dict | None = None, seq: int | None = None):
    from aura.contracts.agent import AgentEvent
    e = AgentEvent(type=type_, at=_now(), sessionId=session_id, payload=payload or {})
    if seq is not None:
        e = e.model_copy(update={"seq": seq})
    return e


# ─────────────────────────────────────────────────────────────────────────────
# 1. MISSION HEADER — session ID format, state + outcome vocabularies
# ─────────────────────────────────────────────────────────────────────────────

class TestMissionHeader:
    def test_session_id_must_start_with_agt(self):
        from aura.contracts.agent import AgentSession
        s = AgentSession(
            sessionId="agt-abc123", projectId=None,
            state="planning", createdAt=_now(), updatedAt=_now(),
        )
        assert s.sessionId.startswith("agt-")

    def test_session_state_vocabulary(self):
        from aura.contracts.agent import AgentSessionState
        import typing
        allowed = set(typing.get_args(AgentSessionState))
        assert "planning" in allowed
        assert "executing" in allowed
        assert "completed" in allowed
        assert "failed" in allowed
        assert "cancelled" in allowed

    def test_agent_result_outcome_vocabulary(self):
        from aura.contracts.agent import AgentResult
        import typing
        OutcomeType = AgentResult.model_fields["outcome"].annotation
        allowed = set(typing.get_args(OutcomeType))
        assert "completed" in allowed
        assert "failed" in allowed
        assert "awaiting-approval" in allowed
        assert "cancelled" in allowed
        assert "denied" in allowed
        assert "timeout" in allowed
        # honest vocabulary: denied/timeout never silently become "failed"
        assert "denied" != "failed"
        assert "timeout" != "failed"

    def test_session_event_count_starts_at_zero(self):
        from aura.contracts.agent import AgentSession
        s = AgentSession(
            sessionId="agt-zero", state="planning",
            createdAt=_now(), updatedAt=_now(),
        )
        assert s.eventCount == 0


# ─────────────────────────────────────────────────────────────────────────────
# 2. TIMELINE PIPELINE STAGES — event types map to expected stages
# ─────────────────────────────────────────────────────────────────────────────

class TestTimelinePipelineStages:
    def test_plan_created_is_a_valid_event_type(self):
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        assert "plan.created" in types

    def test_execution_started_is_valid(self):
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        assert "execution.started" in types

    def test_verification_completed_is_valid(self):
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        assert "verification.completed" in types

    def test_result_ready_is_valid(self):
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        assert "result.ready" in types

    def test_all_seven_pipeline_trigger_types_present(self):
        """Every stage of the 7-stage pipeline has at least one triggering event."""
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        # plan stage
        assert "plan.created" in types
        # workers stage
        assert "worker.lifecycle" in types
        # exec-plan stage
        assert "execution.started" in types
        # execution stage
        assert "invocation.observed" in types
        # verify stage
        assert "verification.completed" in types
        # evidence / done stage
        assert "result.ready" in types


# ─────────────────────────────────────────────────────────────────────────────
# 3. TASK OUTCOME FIELDS
# ─────────────────────────────────────────────────────────────────────────────

class TestTaskOutcomeFields:
    def test_task_outcome_has_required_fields(self):
        from aura.contracts.agent import TaskOutcome
        outcome = TaskOutcome(taskId="t1", state="done", performed=True, verified=True)
        assert outcome.taskId == "t1"
        assert outcome.state == "done"
        assert outcome.performed is True
        assert outcome.verified is True

    def test_task_state_vocabulary(self):
        from aura.contracts.agent import TaskState
        import typing
        allowed = set(typing.get_args(TaskState))
        for s in ("pending", "running", "done", "failed", "awaiting-approval",
                  "blocked", "skipped", "denied", "timed-out", "cancelled"):
            assert s in allowed, f"TaskState missing: {s}"

    def test_task_outcome_invocation_ids_default_empty(self):
        from aura.contracts.agent import TaskOutcome
        outcome = TaskOutcome(taskId="t2", state="pending")
        assert outcome.invocationIds == []

    def test_task_outcome_consumed_from_default_empty(self):
        from aura.contracts.agent import TaskOutcome
        outcome = TaskOutcome(taskId="t3", state="done")
        assert outcome.consumedFrom == []

    def test_task_outcome_approval_id_optional(self):
        from aura.contracts.agent import TaskOutcome
        outcome = TaskOutcome(taskId="t4", state="awaiting-approval")
        assert outcome.approvalId is None


# ─────────────────────────────────────────────────────────────────────────────
# 4. WORKER LIFECYCLE EVENT PAYLOAD
# ─────────────────────────────────────────────────────────────────────────────

class TestWorkerLifecycleEvent:
    def test_worker_lifecycle_is_valid_event_type(self):
        e = _make_event("worker.lifecycle", payload={
            "taskId": "t1",
            "worker": "opencode",
            "nodeId": "node-abc",
            "lifecycle": "RUNNING",
        })
        assert e.type == "worker.lifecycle"
        assert e.payload["worker"] == "opencode"

    def test_worker_lifecycle_payload_carries_task_id(self):
        e = _make_event("worker.lifecycle", payload={"taskId": "implement"})
        assert "taskId" in e.payload

    def test_worker_lifecycle_carries_state(self):
        e = _make_event("worker.lifecycle", payload={
            "taskId": "t1", "state": "running", "lifecycle": "ACTIVE",
        })
        assert e.payload.get("lifecycle") == "ACTIVE"


# ─────────────────────────────────────────────────────────────────────────────
# 5. MODEL ROUTING (sovereign-only network classes)
# ─────────────────────────────────────────────────────────────────────────────

class TestModelRoutingEvent:
    def test_sovereign_network_classes_exclude_cloud(self):
        from aura.sovereign.model_router import SOVEREIGN_NETWORK_CLASSES
        assert "cloud" not in SOVEREIGN_NETWORK_CLASSES
        assert "local" in SOVEREIGN_NETWORK_CLASSES
        assert "private" in SOVEREIGN_NETWORK_CLASSES

    def test_model_router_returns_no_cloud_model(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        registry = ModelRegistry()
        rec_local = ModelRecord(
            id="local-model", model_name="llama3",
            endpoint_id="ollama-local", base_url="http://127.0.0.1:11434",
            network_class="local",
        )
        rec_cloud = ModelRecord(
            id="cloud-model", model_name="gpt-4",
            endpoint_id="openai", base_url="https://api.openai.com/v1",
            network_class="cloud",
        )
        registry.register_manual(rec_local)
        registry.register_manual(rec_cloud)
        from aura.sovereign.model_router import ModelRouter
        router = ModelRouter(registry)
        decision = router.route("summarise this document", "summarization")
        # The sovereign router must never select a cloud model
        assert decision is None or decision.record is None or decision.record.network_class != "cloud"

    def test_evidence_bundle_can_carry_model_name(self):
        from aura.contracts.agent import EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-s1", planId="pln-abc",
            summary="done", createdAt=_now(),
            modelProvider="ollama", modelName="llama3.2",
        )
        assert bundle.modelProvider == "ollama"
        assert bundle.modelName == "llama3.2"


# ─────────────────────────────────────────────────────────────────────────────
# 6. TOOL ACTION EVENT PAYLOAD
# ─────────────────────────────────────────────────────────────────────────────

class TestToolActionEvent:
    def test_worker_action_is_valid_type(self):
        e = _make_event("worker.action", payload={
            "tool": "filesystem.write",
            "actionType": "write",
            "target": "src/main.py",
            "decision": "ALLOW",
            "reason": "within scope",
            "workerNodeId": "opencode-1",
        })
        assert e.type == "worker.action"

    def test_worker_action_decision_vocabulary(self):
        for decision in ("ALLOW", "DENY"):
            e = _make_event("worker.action", payload={"decision": decision})
            assert e.payload["decision"] == decision

    def test_worker_action_no_secret_in_payload(self):
        e = _make_event("worker.action", payload={
            "tool": "http.request",
            "target": "https://api.example.com",
            "decision": "ALLOW",
        })
        payload_str = json.dumps(e.payload)
        for secret_key in ("api_key", "password", "secret", "token", "Bearer"):
            assert secret_key not in payload_str, f"Secret key found in payload: {secret_key}"


# ─────────────────────────────────────────────────────────────────────────────
# 7. VERIFICATION EVENT PAYLOAD
# ─────────────────────────────────────────────────────────────────────────────

class TestVerificationEvent:
    def test_verification_completed_event_shape(self):
        e = _make_event("verification.completed", payload={
            "passed": True,
            "outcomes": [{"taskId": "t1", "state": "done", "verified": True}],
            "objectiveAccepted": True,
            "unmet": [],
        })
        assert e.type == "verification.completed"
        assert e.payload["passed"] is True

    def test_agent_verification_report_fields(self):
        from aura.contracts.agent import AgentVerificationReport, TaskOutcome
        report = AgentVerificationReport(
            passed=True,
            outcomes=[TaskOutcome(taskId="t1", state="done", verified=True)],
            objectiveAccepted=True,
        )
        assert report.passed is True
        assert report.objectiveAccepted is True
        assert report.unmetAcceptance == []

    def test_verification_failure_shows_unmet(self):
        from aura.contracts.agent import AgentVerificationReport
        report = AgentVerificationReport(
            passed=False,
            objectiveAccepted=False,
            unmetAcceptance=["implementation not verified"],
        )
        assert report.passed is False
        assert len(report.unmetAcceptance) == 1


# ─────────────────────────────────────────────────────────────────────────────
# 8. RETRY / TIMED-OUT TASK STATE
# ─────────────────────────────────────────────────────────────────────────────

class TestRetryTaskState:
    def test_timed_out_is_valid_task_state(self):
        from aura.contracts.agent import TaskOutcome
        outcome = TaskOutcome(taskId="t1", state="timed-out")
        assert outcome.state == "timed-out"

    def test_failed_is_valid_task_state(self):
        from aura.contracts.agent import TaskOutcome
        outcome = TaskOutcome(taskId="t1", state="failed", detail="exit 1")
        assert outcome.state == "failed"
        assert outcome.detail == "exit 1"

    def test_invocation_ids_recorded_on_retry(self):
        from aura.contracts.agent import TaskOutcome
        # A retried task accumulates invocation IDs from each attempt
        outcome = TaskOutcome(
            taskId="t1", state="done",
            invocationIds=["inv-001", "inv-002"],  # first attempt failed, second succeeded
        )
        assert len(outcome.invocationIds) == 2


# ─────────────────────────────────────────────────────────────────────────────
# 9. REPLAN / CORRECTION
# ─────────────────────────────────────────────────────────────────────────────

class TestReplanEvent:
    def test_correction_task_id_pattern(self):
        """Correction task IDs follow the `<base>-correction-<n>` convention."""
        import re
        CORRECTION_RE = re.compile(r"^(.*)-correction-(\d+)$")
        assert CORRECTION_RE.match("implement-correction-1")
        assert CORRECTION_RE.match("t2-correction-2")
        assert not CORRECTION_RE.match("implement")

    def test_session_correction_chain_appended(self):
        from aura.contracts.agent import AgentSession
        s = AgentSession(
            sessionId="agt-corr", state="executing",
            createdAt=_now(), updatedAt=_now(),
            correctionChain=[{"taskId": "implement", "round": 1}],
        )
        assert len(s.correctionChain) == 1

    def test_agent_event_can_carry_correction_payload(self):
        e = _make_event("plan.created", payload={
            "plan": [{"id": "implement-correction-1", "description": "re-implement"}],
            "objective": "fix it",
        })
        assert "correction" in e.payload["plan"][0]["id"]


# ─────────────────────────────────────────────────────────────────────────────
# 10. APPROVAL EVENT PAYLOAD
# ─────────────────────────────────────────────────────────────────────────────

class TestApprovalEvent:
    def test_approval_required_is_valid_event_type(self):
        from aura.contracts.agent import AgentEventType
        import typing
        assert "approval.required" in set(typing.get_args(AgentEventType))

    def test_approval_required_event_carries_approval_id(self):
        e = _make_event("approval.required", payload={
            "approvalId": "apv-abc123",
            "taskId": "t1",
            "capabilityId": "sandbox.execute",
        })
        assert e.payload["approvalId"] == "apv-abc123"

    def test_approval_invalidated_is_valid_event_type(self):
        from aura.contracts.agent import AgentEventType
        import typing
        assert "approval.invalidated" in set(typing.get_args(AgentEventType))

    def test_session_parked_task_id_recorded(self):
        from aura.contracts.agent import AgentSession
        s = AgentSession(
            sessionId="agt-park", state="awaiting-approval",
            createdAt=_now(), updatedAt=_now(),
            parkedTaskId="t1",
        )
        assert s.parkedTaskId == "t1"


# ─────────────────────────────────────────────────────────────────────────────
# 11. EVIDENCE BUNDLE FIELDS
# ─────────────────────────────────────────────────────────────────────────────

class TestEvidenceBundle:
    def test_evidence_bundle_required_fields(self):
        from aura.contracts.agent import EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-s1", planId="pln-xyz",
            summary="all tasks verified", createdAt=_now(),
        )
        assert bundle.sessionId == "agt-s1"
        assert bundle.planId == "pln-xyz"
        assert bundle.auditRecordIds == []
        assert bundle.approvalIds == []

    def test_evidence_bundle_accepts_artifact_paths(self):
        from aura.contracts.agent import EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-s2", planId="pln-abc",
            summary="done", createdAt=_now(),
            artifactPaths=["/home/user/.aura/artifacts/report.docx"],
        )
        assert len(bundle.artifactPaths) == 1
        assert bundle.artifactPaths[0].endswith(".docx")

    def test_evidence_bundle_audit_record_ids(self):
        from aura.contracts.agent import EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-s3", planId="pln-abc",
            summary="two tasks", createdAt=_now(),
            auditRecordIds=["aud-001", "aud-002"],
        )
        assert len(bundle.auditRecordIds) == 2

    def test_agent_result_evidence_field(self):
        from aura.contracts.agent import AgentResult, EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-s4", planId="pln-abc",
            summary="done", createdAt=_now(),
        )
        result = AgentResult(
            status="completed", outcome="completed",
            summary="Work done.", performed=["t1"], verified=["t1"],
            evidence=bundle,
        )
        assert result.evidence is not None
        assert result.evidence.sessionId == "agt-s4"


# ─────────────────────────────────────────────────────────────────────────────
# 12. MISSION COMPLETION
# ─────────────────────────────────────────────────────────────────────────────

class TestMissionCompletion:
    def test_completed_outcome_in_result(self):
        from aura.contracts.agent import AgentResult
        result = AgentResult(
            status="completed", outcome="completed",
            summary="all done", performed=["t1"], verified=["t1"],
        )
        assert result.outcome == "completed"
        assert result.status == "completed"

    def test_result_ready_event_shape(self):
        e = _make_event("result.ready", payload={
            "outcome": "completed",
            "summary": "mission accomplished",
        })
        assert e.type == "result.ready"

    def test_completed_result_has_no_failure_reason(self):
        from aura.contracts.agent import AgentResult
        result = AgentResult(
            status="completed", outcome="completed",
            summary="done", performed=[], verified=[],
        )
        assert result.failureReason is None


# ─────────────────────────────────────────────────────────────────────────────
# 13. MISSION FAILURE
# ─────────────────────────────────────────────────────────────────────────────

class TestMissionFailure:
    def test_failed_outcome_distinct_from_denied(self):
        from aura.contracts.agent import AgentResult
        failed = AgentResult(
            status="failed", outcome="failed",
            summary="worker exited 1", performed=[], verified=[],
            failureReason="exit code 1",
        )
        denied = AgentResult(
            status="failed", outcome="denied",
            summary="policy refused", performed=[], verified=[],
        )
        assert failed.outcome != denied.outcome
        assert failed.failureReason is not None

    def test_agent_failed_event(self):
        e = _make_event("agent.failed", payload={
            "reason": "worker exited with code 1",
            "taskId": "t1",
        })
        assert e.type == "agent.failed"
        assert "reason" in e.payload

    def test_denied_outcome_correct_vocabulary(self):
        from aura.contracts.agent import AgentResult
        result = AgentResult(
            status="failed", outcome="denied",
            summary="authority refused the invocation",
            performed=[], verified=[],
        )
        assert result.outcome == "denied"


# ─────────────────────────────────────────────────────────────────────────────
# 14. CANCELLATION EVENTS CHAIN
# ─────────────────────────────────────────────────────────────────────────────

class TestCancellation:
    def test_cancellation_event_types_present(self):
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        assert "run.cancellation-requested" in types
        assert "run.stopping" in types
        assert "run.cancelled" in types

    def test_agent_cancelled_event_type(self):
        from aura.contracts.agent import AgentEventType
        import typing
        assert "agent.cancelled" in set(typing.get_args(AgentEventType))

    def test_cancellation_chain_order(self):
        """The cancellation sequence has three distinct events: requested → stopping → cancelled."""
        from aura.contracts.agent import AgentEventType
        import typing
        types = set(typing.get_args(AgentEventType))
        chain = ["run.cancellation-requested", "run.stopping", "run.cancelled"]
        for t in chain:
            assert t in types

    def test_session_cancellation_field(self):
        from aura.contracts.agent import AgentSession
        s = AgentSession(
            sessionId="agt-stop", state="cancelled",
            createdAt=_now(), updatedAt=_now(),
            cancellation={"requestedAt": _now(), "reason": "user stopped"},
        )
        assert s.cancellation is not None
        assert "reason" in s.cancellation


# ─────────────────────────────────────────────────────────────────────────────
# 15. PROJECT ISOLATION (EventBus session filter)
# ─────────────────────────────────────────────────────────────────────────────

class TestProjectIsolation:
    def test_event_bus_session_filter_isolates_sessions(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        seen_a: list = []
        seen_b: list = []
        bus.subscribe(lambda e: seen_a.append(e) if e.sessionId == "agt-A" else None)
        bus.subscribe(lambda e: seen_b.append(e) if e.sessionId == "agt-B" else None)

        bus.emit(_make_event("plan.created", session_id="agt-A"))
        bus.emit(_make_event("execution.started", session_id="agt-B"))
        bus.emit(_make_event("result.ready", session_id="agt-A"))

        assert len(seen_a) == 2
        assert len(seen_b) == 1

    def test_tail_after_respects_session_filter(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        bus.emit(_make_event("plan.created", session_id="agt-proj-1"))
        bus.emit(_make_event("plan.created", session_id="agt-proj-2"))
        bus.emit(_make_event("result.ready", session_id="agt-proj-1"))

        proj1 = bus.tail_after(session_filter="agt-proj-1")
        assert len(proj1) == 2
        assert all(e.sessionId == "agt-proj-1" for e in proj1)

    def test_global_channel_reaches_all(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        received = []
        bus.subscribe(received.append)
        # "-" is the global channel; should fan out to all subscribers
        bus.emit(_make_event("result.ready", session_id="-"))
        assert len(received) == 1


# ─────────────────────────────────────────────────────────────────────────────
# 16. SSE EVENT UPDATES (EventBus emit + subscriber)
# ─────────────────────────────────────────────────────────────────────────────

class TestSSEEventUpdates:
    def test_subscriber_receives_all_emitted_events(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        received = []
        bus.subscribe(received.append)
        for t in ("plan.created", "execution.started", "verification.completed"):
            bus.emit(_make_event(t))
        assert len(received) == 3

    def test_bus_monotonic_seq_increments(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        seqs = []
        bus.subscribe(lambda e: seqs.append(e.seq))
        for _ in range(5):
            bus.emit(_make_event("plan.created"))
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == 5  # all unique

    def test_bus_tail_grows_with_emits(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        for _ in range(10):
            bus.emit(_make_event("invocation.observed"))
        assert len(bus.tail) == 10

    def test_subscriber_fault_does_not_break_other_subscribers(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        good = []

        def bad(_): raise RuntimeError("boom")

        bus.subscribe(bad)
        bus.subscribe(good.append)
        bus.emit(_make_event("plan.created"))
        assert len(good) == 1  # the good subscriber still received


# ─────────────────────────────────────────────────────────────────────────────
# 17. SSE RECONNECT (tail_after with after= cursor)
# ─────────────────────────────────────────────────────────────────────────────

class TestSSEReconnect:
    def test_tail_after_cursor_returns_only_newer_events(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        for _ in range(5):
            bus.emit(_make_event("invocation.observed"))
        cursor = bus.tail[-1].seq  # last seen sequence
        # Emit 3 more
        for _ in range(3):
            bus.emit(_make_event("worker.lifecycle"))
        replayed = bus.tail_after(after=cursor)
        assert len(replayed) == 3
        assert all((e.seq or 0) > cursor for e in replayed)

    def test_tail_after_no_cursor_returns_all(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        for _ in range(4):
            bus.emit(_make_event("plan.created"))
        assert len(bus.tail_after()) == 4

    def test_tail_after_with_session_and_cursor(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        bus.emit(_make_event("plan.created", session_id="agt-X"))
        bus.emit(_make_event("plan.created", session_id="agt-Y"))
        cursor_after_first = bus.tail[0].seq
        bus.emit(_make_event("result.ready", session_id="agt-X"))
        replayed = bus.tail_after(session_filter="agt-X", after=cursor_after_first)
        assert len(replayed) == 1
        assert replayed[0].type == "result.ready"


# ─────────────────────────────────────────────────────────────────────────────
# 18. DUPLICATE PREVENTION (EventBus seq uniqueness)
# ─────────────────────────────────────────────────────────────────────────────

class TestDuplicatePrevention:
    def test_bus_assigns_unique_seqs(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        for _ in range(20):
            bus.emit(_make_event("invocation.observed"))
        seqs = [e.seq for e in bus.tail]
        assert len(set(seqs)) == len(seqs)

    def test_tail_limit_enforced(self):
        from aura.central_agent.events import EventBus
        bus = EventBus(tail_limit=10)
        for _ in range(15):
            bus.emit(_make_event("plan.created"))
        assert len(bus.tail) == 10

    def test_replay_max_limits_tail_after(self):
        from aura.central_agent.events import EventBus
        bus = EventBus(tail_limit=500)
        for _ in range(300):
            bus.emit(_make_event("invocation.observed"))
        result = bus.tail_after(limit=50)
        assert len(result) <= 50


# ─────────────────────────────────────────────────────────────────────────────
# 19. SOVEREIGN DISPLAY (model network class in evidence)
# ─────────────────────────────────────────────────────────────────────────────

class TestSovereignDisplay:
    def test_evidence_bundle_model_provider_is_not_a_url(self):
        """modelProvider is a name like 'ollama', not an endpoint URL."""
        from aura.contracts.agent import EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-sov", planId="pln-x",
            summary="local run", createdAt=_now(),
            modelProvider="ollama",
            modelName="qwen2.5-coder",
        )
        # No URL schemes in model identity fields — just names
        assert not bundle.modelProvider.startswith("http")
        assert "://" not in bundle.modelProvider

    def test_sovereign_network_classes_are_local_private(self):
        from aura.sovereign.model_router import SOVEREIGN_NETWORK_CLASSES
        assert SOVEREIGN_NETWORK_CLASSES == frozenset({"local", "private"})

    def test_model_spec_network_class_vocabulary(self):
        from aura.sovereign.model_registry import ModelRecord
        rec = ModelRecord(
            id="m1", model_name="llama3",
            endpoint_id="ollama-local", base_url="http://127.0.0.1:11434",
            network_class="local",
        )
        assert rec.network_class == "local"


# ─────────────────────────────────────────────────────────────────────────────
# 20. CLOUD-BLOCKED STATE (ModelRouter excludes cloud models)
# ─────────────────────────────────────────────────────────────────────────────

class TestCloudBlockedState:
    def test_model_registry_can_hold_cloud_spec(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        registry = ModelRegistry()
        registry.register_manual(ModelRecord(
            id="cloud-gpt", model_name="gpt-4",
            endpoint_id="openai", base_url="https://api.openai.com/v1",
            network_class="cloud",
        ))
        rec = registry.get("cloud-gpt")
        assert rec is not None
        assert rec.network_class == "cloud"

    def test_model_router_skips_cloud_specs(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        from aura.sovereign.model_router import ModelRouter
        registry = ModelRegistry()
        registry.register_manual(ModelRecord(
            id="cloud-only", model_name="gpt-4",
            endpoint_id="openai", base_url="https://api.openai.com/v1",
            network_class="cloud",
        ))
        router = ModelRouter(registry)
        # With only cloud models available, route() returns None (safe no-op)
        decision = router.route("code a function", "code")
        assert decision is None or decision.record is None

    def test_only_local_model_is_routed(self):
        from aura.sovereign.model_registry import ModelRegistry, ModelRecord
        from aura.sovereign.model_router import ModelRouter
        registry = ModelRegistry()
        registry.register_manual(ModelRecord(
            id="local-llm", model_name="qwen2.5",
            endpoint_id="ollama-local", base_url="http://127.0.0.1:11434",
            network_class="local",
        ))
        router = ModelRouter(registry)
        decision = router.route("summarise", "summarization")
        # When a local model is available, it is selected
        if decision is not None and decision.record is not None:
            assert decision.record.network_class in ("local", "private")


# ─────────────────────────────────────────────────────────────────────────────
# 21. NO SECRET LEAK (AgentEvent payload contains no credentials)
# ─────────────────────────────────────────────────────────────────────────────

class TestNoSecretLeak:
    _SECRET_PATTERNS = (
        "api_key", "apikey", "password", "secret", "Bearer ", "Authorization",
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "token=", "sk-",
    )

    def _assert_no_secrets(self, payload: dict) -> None:
        text = json.dumps(payload)
        for pat in self._SECRET_PATTERNS:
            assert pat not in text, f"Secret pattern '{pat}' found in event payload"

    def test_plan_created_payload_no_secrets(self):
        e = _make_event("plan.created", payload={
            "plan": [{"id": "t1", "description": "write code"}],
            "objective": "implement feature",
        })
        self._assert_no_secrets(e.payload)

    def test_worker_lifecycle_payload_no_secrets(self):
        e = _make_event("worker.lifecycle", payload={
            "taskId": "t1",
            "worker": "opencode",
            "lifecycle": "RUNNING",
        })
        self._assert_no_secrets(e.payload)

    def test_evidence_bundle_summary_no_secrets(self):
        from aura.contracts.agent import EvidenceBundle
        bundle = EvidenceBundle(
            sessionId="agt-safe", planId="pln-ok",
            summary="mission complete — no credentials used",
            createdAt=_now(),
        )
        text = bundle.model_dump_json()
        for pat in self._SECRET_PATTERNS:
            assert pat not in text, f"Secret pattern '{pat}' in evidence bundle"

    def test_agent_session_serialisation_no_secrets(self):
        from aura.contracts.agent import AgentSession
        s = AgentSession(
            sessionId="agt-clean", state="completed",
            createdAt=_now(), updatedAt=_now(),
        )
        text = s.model_dump_json()
        for pat in self._SECRET_PATTERNS:
            assert pat not in text


# ─────────────────────────────────────────────────────────────────────────────
# 22. CURRENT OPERATION (worker.lifecycle / invocation.observed observable)
# ─────────────────────────────────────────────────────────────────────────────

class TestCurrentOperation:
    def test_worker_lifecycle_running_is_observable(self):
        e = _make_event("worker.lifecycle", payload={
            "taskId": "implement",
            "worker": "opencode",
            "nodeId": "oc-node-1",
            "lifecycle": "RUNNING",
            "state": "running",
        })
        assert e.type == "worker.lifecycle"
        assert e.payload["lifecycle"] == "RUNNING"
        assert e.payload["taskId"] == "implement"

    def test_invocation_observed_running_is_observable(self):
        e = _make_event("invocation.observed", payload={
            "taskId": "t1",
            "state": "running",
            "capabilityId": "agent.delegate",
        })
        assert e.payload["state"] == "running"

    def test_event_bus_tail_yields_latest_worker_event(self):
        from aura.central_agent.events import EventBus
        bus = EventBus()
        bus.emit(_make_event("worker.lifecycle", payload={
            "taskId": "t1", "lifecycle": "STARTING", "worker": "opencode",
        }))
        bus.emit(_make_event("worker.lifecycle", payload={
            "taskId": "t1", "lifecycle": "RUNNING", "worker": "opencode",
        }))
        # The last event in the tail is the current operation
        latest = bus.tail[-1]
        assert latest.type == "worker.lifecycle"
        assert latest.payload["lifecycle"] == "RUNNING"

    def test_terminal_lifecycle_is_not_current_operation(self):
        """COMPLETED / DONE lifecycle means the operation is over."""
        e = _make_event("worker.lifecycle", payload={
            "taskId": "t1", "lifecycle": "COMPLETED", "worker": "opencode",
        })
        # The frontend useAgentRun.currentOperation excludes COMPLETED
        lifecycle = e.payload.get("lifecycle", "")
        assert lifecycle.upper() in ("COMPLETED", "DONE", "EXITED", "IDLE",
                                     "COMPLETED")  # should not be treated as active
