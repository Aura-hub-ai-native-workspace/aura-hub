"""The conversational turn — AURA answering in words, with no work done.

A greeting used to be interrogated: "Hi" is three characters, so the
intent compiler's length rule returned "Could you say what you want
accomplished?". Everything a person says was compiled into a goal, a
plan and an execution, because that was the only path there was.

These tests pin the second path and, more importantly, pin what it
CANNOT do. A conversational turn never reaches the planner, the
authority checker, the Fabric or an executor, so it can report no
performed tasks, no verified tasks and no evidence. That is structural,
not a promise: this suite asserts the audit trail stays empty and the
result carries nothing, because a turn that ran nothing has nothing to
show.

Run: `uv run pytest tests/unit/test_conversational_turn.py -q`
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from aura.approvals import ApprovalLedger
from aura.audit import AuditStore
from aura.central_agent import AgentSessionStore, CentralAgent, IntentCompiler
from aura.central_agent.intent import (
    ScriptedModelPort,
    heuristic_interpret,
    is_conversational,
    normalize_smalltalk,
    smalltalk_reply,
)
from aura.fabric import FabricConfig


def _agent(home: Path, intent_compiler=None) -> tuple[CentralAgent, AuditStore]:
    """A real agent over the real governance spine, as the slice suite builds it."""
    from aura.fabric import CapabilityFabric, FabricHost

    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True,
                    "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True

        async def request_approval(self, _req, _ctx):
            return False

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    fabric = CapabilityFabric(_H())
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    from aura.executors import all_executors

    execs = {e.capabilityId: e for e in all_executors(home)}
    for exe in execs.values():
        try:
            fabric.register(exe)
        except Exception:  # noqa: BLE001 — unregistered stays unsupported
            pass
    cfg = FabricConfig(fabric=fabric, policy_config={},
                       permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit, ledger=ledger)
    return CentralAgent(fabric_cfg=cfg, session_store=AgentSessionStore(home),
                        intent_compiler=intent_compiler), audit


@pytest.fixture()
def home(monkeypatch):
    path = Path(tempfile.mkdtemp(prefix="agent-conv-"))
    monkeypatch.setenv("AURA_HOME", str(path))
    return path


# ── classification ───────────────────────────────────────────────────


class TestClassification:
    @pytest.mark.parametrize("message", [
        "Hi", "hi", "  hey  ", "Hello!", "howdy",
        "good morning", "How are you?", "thanks", "Thank you so much",
        "bye", "good night", "what can you do?", "who are you",
    ])
    def test_smalltalk_is_conversational(self, message):
        assert is_conversational(message) is True
        intent = heuristic_interpret(message)
        assert intent.conversational is True
        assert intent.needsClarification is False
        assert intent.requiredCapabilities == []

    @pytest.mark.parametrize("message", [
        "hey fix the login bug",
        "hi, create a file called demo.txt containing hello",
        "thanks, now run the tests",
        "list my workflows and show status",
        "create a workflow that shows git status daily",
        "flurb the bazzle",
    ])
    def test_work_is_never_swallowed_by_a_greeting_prefix(self, message):
        """The whole message must be smalltalk, never merely start with it."""
        assert is_conversational(message) is False
        assert heuristic_interpret(message).conversational is False

    def test_empty_and_punctuation_keep_the_existing_clarification(self):
        for message in ["   ", "?!", ""]:
            assert is_conversational(message) is False
            assert heuristic_interpret(message).needsClarification is True

    def test_normalisation_is_bounded(self):
        assert normalize_smalltalk("  HI!!!  ") == "hi"
        assert normalize_smalltalk("How's it going?") == "hows it going"
        # A long message can never normalise into a smalltalk phrase.
        assert is_conversational("hi " + "x" * 400) is False


class TestOfflineReply:
    def test_greeting_answers_without_a_model(self):
        assert smalltalk_reply("Hi") == "Hey! \U0001f44b How can I help you today?"

    def test_each_kind_of_smalltalk_has_its_own_reply(self):
        assert "next" in (smalltalk_reply("thanks") or "")
        assert "here" in (smalltalk_reply("bye") or "")
        assert "AURA" in (smalltalk_reply("what can you do") or "")

    def test_a_knowledge_question_gets_no_invented_answer(self):
        """None means "this needs a model" — never a fabricated reply."""
        assert smalltalk_reply("Explain quantum computing") is None
        assert smalltalk_reply("what is the capital of France") is None


# ── the turn, end to end over the real spine ─────────────────────────


class TestConversationalTurnRunsNothing:
    def test_greeting_completes_naturally_with_no_model(self, home):
        agent, audit = _agent(home)
        result = agent.submit("Hi")

        assert result.outcome == "completed"
        assert result.status == "completed"
        assert result.summary == "Hey! \U0001f44b How can I help you today?"

    def test_the_result_can_claim_no_work(self, home):
        agent, audit = _agent(home)
        result = agent.submit("Hi")

        assert result.performed == []
        assert result.verified == []
        assert result.evidence is None
        assert result.runId is None
        assert result.failureReason is None

    def test_nothing_reaches_the_audit_trail(self, home):
        """No invocation happened, so there is no record to write."""
        agent, audit = _agent(home)
        agent.submit("Hi")
        assert audit.load() == []

    def test_no_plan_is_created(self, home):
        agent, audit = _agent(home)
        agent.submit("hello")
        session = agent.sessions.load(agent.sessions.last_session_id)
        assert not session.activePlan
        assert session.activePlanId is None

    def test_the_planner_and_authority_checker_are_never_reached(self, home):
        """Structural: the turn leaves `_run` before either exists."""
        agent, audit = _agent(home)
        called: list[str] = []
        agent.planner.plan = lambda *a, **k: called.append("plan")  # type: ignore[assignment]
        agent.authority.check_plan = lambda *a, **k: called.append("authority")  # type: ignore[assignment]

        result = agent.submit("Hi")

        assert result.outcome == "completed"
        assert called == []

    def test_events_say_conversation_and_never_announce_a_plan(self, home):
        agent, audit = _agent(home)
        agent.submit("Hi")
        types = [e.type for e in agent.bus.tail]

        assert "session.started" in types
        assert "intent.compiled" in types
        assert "plan.created" not in types
        assert "execution.started" not in types
        assert "approval.required" not in types
        assert "intent.clarification-needed" not in types

    def test_the_answer_joins_the_conversation_for_the_next_turn(self, home):
        agent, audit = _agent(home)
        agent.submit("Hi")
        session = agent.sessions.load(agent.sessions.last_session_id)
        roles = [m.role for m in session.messages]

        assert roles == ["user", "agent"]
        assert "How can I help you" in session.messages[1].content

    def test_a_follow_up_continues_the_same_session(self, home):
        agent, audit = _agent(home)
        first = agent.submit("Hi")
        sid = agent.sessions.last_session_id

        second = agent.message(sid, "thanks")

        assert first.outcome == "completed"
        assert second.outcome == "completed"
        assert "next" in second.summary
        session = agent.sessions.load(sid)
        assert [m.role for m in session.messages] == [
            "user", "agent", "user", "agent"]

    def test_the_execution_controller_is_never_invoked(self, home):
        """Nothing reaches the Fabric, because nothing dispatches."""
        agent, audit = _agent(home)
        called: list[str] = []
        agent.controller.execute = lambda *a, **k: called.append("execute")  # type: ignore[assignment]
        agent.discovery.available_for = lambda *a, **k: called.append("discovery")  # type: ignore[assignment]

        result = agent.submit("Hi")

        assert result.outcome == "completed"
        assert called == []

    def test_no_session_run_metadata_is_written(self, home):
        agent, audit = _agent(home)
        agent.submit("Hi")
        session = agent.sessions.load(agent.sessions.last_session_id)

        assert session.parkedTaskId is None
        assert not session.verifiedEvidence
        assert session.lastResult is not None
        assert session.lastResult.evidence is None
        assert session.lastResult.runId is None

    def test_only_existing_event_types_are_emitted(self, home):
        """The conversation reuses the answer.* vocabulary; it adds none."""
        from typing import get_args

        from aura.contracts.agent import AgentEventType

        known = set(get_args(AgentEventType))
        agent, audit = _agent(home, self._model_compiler("Hello there."))
        agent.submit("Hi")

        emitted = {e.type for e in agent.bus.tail}
        assert emitted <= known
        assert "answer.started" in emitted
        assert "answer.token" in emitted
        assert "answer.completed" in emitted

    def _model_compiler(self, reply: str):
        port = ScriptedModelPort([("", reply)])
        return IntentCompiler(mode="model", model_port=port,
                              allow_heuristic_fallback=True)

    def test_work_still_takes_the_orchestration_path(self, home):
        """The guard that matters: conversation did not swallow real work."""
        agent, audit = _agent(home)
        result = agent.submit("list my workflows")

        assert result.outcome == "completed"
        assert result.performed == ["t1"]
        assert result.verified == ["t1"]
        assert result.evidence is not None
        assert len(audit.load()) == 1


# ── model-backed conversation ────────────────────────────────────────


class TestModelBackedConversation:
    def _compiler(self, reply: str) -> IntentCompiler:
        port = ScriptedModelPort([("", reply)])
        return IntentCompiler(mode="model", model_port=port,
                              allow_heuristic_fallback=True)

    def test_a_greeting_streams_the_model_reply_as_answer_tokens(self, home):
        agent, audit = _agent(home, self._compiler("Hey! How can I help?"))
        result = agent.submit("Hi")

        assert result.outcome == "completed"
        assert result.summary == "Hey! How can I help?"
        types = [e.type for e in agent.bus.tail]
        assert "answer.started" in types
        assert "answer.completed" in types
        streamed = "".join(
            str(e.payload.get("text", "")) for e in agent.bus.tail
            if e.type == "answer.token")
        assert streamed == "Hey! How can I help?"
        assert audit.load() == []

    def test_the_model_cannot_mark_a_capability_request_as_conversation(self):
        """A turn naming capabilities is work, whatever the model claims."""
        port = ScriptedModelPort([("", {
            "goal": "delete everything",
            "expectedOutcome": "gone",
            "conversational": True,
            "requiredCapabilities": ["filesystem.write"],
        })])
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=False)
        intent = compiler.compile("delete everything")

        assert intent.conversational is False
        assert intent.requiredCapabilities == ["filesystem.write"]

    def test_a_greeting_stays_conversation_even_if_the_model_disagrees(self):
        """The deterministic floor wins, so "Hi" works on every install."""
        port = ScriptedModelPort([("", {
            "goal": "Hi",
            "expectedOutcome": "a plan",
            "conversational": False,
            "requiredCapabilities": ["agent.delegate"],
        })])
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=False)
        intent = compiler.compile("Hi")

        assert intent.conversational is True
        assert intent.requiredCapabilities == []
        assert intent.needsClarification is False

    def test_a_model_may_mark_a_knowledge_question_conversational(self):
        port = ScriptedModelPort([("", {
            "goal": "Explain quantum computing",
            "expectedOutcome": "an explanation",
            "conversational": True,
            "requiredCapabilities": [],
        })])
        compiler = IntentCompiler(mode="model", model_port=port,
                                  allow_heuristic_fallback=False)
        intent = compiler.compile("Explain quantum computing")

        assert intent.conversational is True
        assert intent.needsClarification is False


# ── nothing new was built ────────────────────────────────────────────


class TestNoParallelArchitecture:
    """The conversational path is a branch, not a system.

    It reuses the session store, the event bus, the model port and the
    existing routes. These guards fail loudly if a future change grows
    it into a second engine with its own surface.
    """

    def test_no_conversation_route_was_added(self, home):
        from aura.api.server import create_api_server

        app = create_api_server()
        paths = {getattr(r, "path", "") for r in app.routes}

        assert not [p for p in paths if "chat" in p or "conversation" in p]
        # The agent surface is exactly the routes that already existed.
        assert {p for p in paths if p.startswith("/agent/")} == {
            "/agent/bounds", "/agent/tools", "/agent/model",
            "/agent/sessions", "/agent/sessions/{sid}",
            "/agent/sessions/{sid}/message", "/agent/sessions/{sid}/approve",
            "/agent/sessions/{sid}/resume", "/agent/sessions/{sid}/cancel",
            "/agent/sessions/{sid}/resume-cancelled",
            "/agent/sessions/{sid}/plan", "/agent/sessions/{sid}/evidence",
            "/agent/sessions/{sid}/events",
        }

    def test_no_new_module_backs_the_conversation(self):
        """The branch lives in the files that already owned this logic."""
        import aura.central_agent as ca

        names = set(dir(ca))
        for invented in ("conversation", "chat", "ConversationEngine",
                         "ChatService", "ConversationStore"):
            assert invented not in names

    def test_the_reply_path_reuses_the_one_model_port(self):
        """No second provider client: same port the intent compiler uses."""
        import inspect

        from aura.central_agent.service import CentralAgent

        source = inspect.getsource(CentralAgent._stream_conversation)
        assert 'getattr(intents, "model_port", None)' in source
        assert "urllib" not in source and "httpx" not in source
        assert "requests" not in source
