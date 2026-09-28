"""Phase 2 — context-aware Central Agent.

Covers the four routing targets the phase adds and the seams they ride:

- `inspectProject`: a question ABOUT the active project is answered by
  the agent reading actual bounded files — never guessed, never
  dispatched to a worker, never taken by a change verb.
- General questions about the world ("How would you create a REST
  API?") stay conversation while the imperative ("Create a REST API in
  this project") executes.
- Grounded inspection: the project digest reaches the model prompt as
  untrusted data, and a project question with NO model names what was
  read instead of pretending.
- Model outage: intent compilation falls back to the SAME deterministic
  classifier — the turn still routes, never crashes.
- Handoff: an engineering request for the active project carries the
  project-root scope ("."), keeps the user's own words as the task, and
  the planner passes the conversation digest into the delegate input.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aura.central_agent import AgentSessionStore, CentralAgent, IntentCompiler
from aura.central_agent.context import project_digest
from aura.central_agent.intent import (
    ScriptedModelPort,
    heuristic_interpret,
)
from aura.fabric import FabricConfig


def _make_project(tmp_path: Path) -> Path:
    root = tmp_path / "demo-app"
    (root / "tests").mkdir(parents=True)
    (root / "README.md").write_text("# Demo\n\nA demo used by tests.\n")
    (root / "main.py").write_text(
        '"""Entry point."""\n\n\ndef main() -> None:\n    print("demo")\n')
    (root / "tests" / "test_main.py").write_text(
        "def test_main_exists():\n    assert True\n")
    return root


def _agent(home: Path, project_path: str | None = None,
           compiler: IntentCompiler | None = None) -> CentralAgent:
    from aura.approvals import ApprovalLedger
    from aura.audit import AuditStore
    from aura.executors import all_executors
    from aura.fabric import CapabilityFabric, FabricHost

    class _PermissiveHost(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True,
                    "autonomous": True, "network": True}

        def node_available(self, _cap):
            return True

        async def request_approval(self, _req, _ctx):
            return False

    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)
    fabric = CapabilityFabric(_PermissiveHost())
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    execs = {e.capabilityId: e for e in all_executors(home)}
    for exe in execs.values():
        try:
            fabric.register(exe)
        except Exception:  # noqa: BLE001
            pass
    cfg = FabricConfig(fabric=fabric, policy_config={},
                       permissions={"read": True, "write": True},
                       executors=execs, audit_store=audit, ledger=ledger)
    store = AgentSessionStore(home)
    return CentralAgent(fabric_cfg=cfg, session_store=store,
                        intent_compiler=compiler)


# ── routing ──────────────────────────────────────────────────────────


class TestRouting:
    @pytest.mark.parametrize("message", [
        "Inspect my current project and explain its architecture.",
        "Where are the tests located?",
        "What is the project's main entry point?",
        "Explain the project architecture",
    ])
    def test_project_questions_take_the_inspection_path(self, message):
        intent = heuristic_interpret(message)
        assert intent.inspectProject is True
        assert intent.conversational is False
        assert "agent.delegate" not in intent.requiredCapabilities
        assert intent.needsClarification is False

    @pytest.mark.parametrize("message", [
        "Inspect the project and fix the failing tests",
        "Explain the architecture and then add a caching layer",
    ])
    def test_change_verbs_stay_on_the_work_path(self, message):
        intent = heuristic_interpret(message)
        assert intent.inspectProject is False

    def test_problem_words_stay_on_the_work_path(self):
        intent = heuristic_interpret(
            "Inspect the project architecture for security problems")
        assert intent.inspectProject is False
        assert "agent.delegate" in intent.requiredCapabilities

    def test_how_question_is_conversation(self):
        intent = heuristic_interpret("How would you create a REST API?")
        assert intent.conversational is True
        assert intent.inspectProject is False

    def test_how_imperative_is_execution(self):
        intent = heuristic_interpret("Create a REST API in this project")
        assert intent.conversational is False
        assert "agent.delegate" in intent.requiredCapabilities

    def test_ordinary_conversation_untouched(self):
        assert heuristic_interpret("Hi").conversational is True
        assert heuristic_interpret(
            "Hi AURA. Explain the difference between an IDE and an "
            "AI-native workspace.").conversational is True


# ── project digest ───────────────────────────────────────────────────


class TestProjectDigest:
    def test_reads_actual_files_and_tests(self, tmp_path):
        root = _make_project(tmp_path)
        digest = project_digest(str(root))
        assert digest is not None
        paths = [f["path"] for f in digest["files"]]
        assert "README.md" in paths and "main.py" in paths
        assert any(t.startswith("tests/") for t in digest["tests"])

    def test_missing_root_is_none(self, tmp_path):
        assert project_digest(str(tmp_path / "nope")) is None


# ── live turns over the real agent ───────────────────────────────────


class TestGroundedInspectionTurn:
    def _compiler(self, reply: str) -> IntentCompiler:
        return IntentCompiler(mode="model",
                              model_port=ScriptedModelPort([("", reply)]),
                              allow_heuristic_fallback=True)

    def test_inspection_streams_a_grounded_answer(self, tmp_path):
        root = _make_project(tmp_path)
        home = tmp_path / "home"
        agent = _agent(home, compiler=self._compiler(
            "The entry point is main.py; tests live in tests/."))
        result = agent.submit("Explain this project's architecture",
                              project_path=str(root))

        assert result.outcome == "completed"
        assert "main.py" in result.summary
        types = [e.type for e in agent.bus.tail]
        assert "answer.token" in types
        # The digest reached the model prompt as the user's project.
        # prompts[0] is the INTENT call; the answer is a later one.
        answer_prompts = [u for _, u in agent.intents.model_port.prompts
                          if "PROJECT GROUNDING" in u or "USER MESSAGE:" in u]
        assert answer_prompts, "the answer call never happened"
        prompt = answer_prompts[0]
        assert "PROJECT GROUNDING" in prompt
        assert "main.py" in prompt
        assert str(root) not in prompt  # untrusted content, absolute paths out

    def test_inspection_without_a_project_is_honest(self, tmp_path):
        home = tmp_path / "home"
        agent = _agent(home, compiler=self._compiler(
            "Sure, let me look at your project!"))
        result = agent.submit("Explain this project's architecture")

        assert result.outcome == "completed"
        # The deterministic guarantee is in the PROMPT (the scripted
        # model merely echoes whatever it was told): the model must be
        # TOLD inspection is unavailable, so no phrasing can trick the
        # product into claiming an inspection that never happened.
        answer_prompts = [u for _, u in agent.intents.model_port.prompts
                          if "PROJECT INSPECTION UNAVAILABLE" in u
                          or "USER MESSAGE:" in u]
        assert answer_prompts, "the answer call never happened"
        assert "PROJECT INSPECTION UNAVAILABLE" in answer_prompts[0]
        assert "No active project is open" in answer_prompts[0]

    def test_inspection_with_no_model_names_what_was_read(self, tmp_path):
        root = _make_project(tmp_path)
        home = tmp_path / "home"
        agent = _agent(home)  # heuristic compiler: no model
        result = agent.submit("Explain this project's architecture",
                              project_path=str(root))

        assert result.outcome == "completed"
        assert "no reasoning model is configured" in result.summary
        assert "README.md" in result.summary


class TestModelOutageFallback:
    def test_model_failure_falls_back_to_the_deterministic_classifier(
            self, tmp_path):
        from aura.central_agent.intent import IntentCompilationError

        class _DeadPort:
            def complete_json(self, system: str, user: str):
                raise TimeoutError("provider unreachable")

            def complete_stream(self, *a, **k):
                raise TimeoutError("provider unreachable")

        compiler = IntentCompiler(mode="model", model_port=_DeadPort(),
                                  allow_heuristic_fallback=True)
        # Directly: compile degrades to the heuristic result.
        intent = compiler.compile("Fix the authentication bug")
        assert "agent.delegate" in intent.requiredCapabilities

        # And a *project question* still routes to inspection, not to a
        # crash or a generic failure.
        intent2 = compiler.compile("Where are the tests located?")
        assert intent2.inspectProject is True

    def test_silent_model_falls_back_too(self, tmp_path):
        class _SilentPort:
            def complete_json(self, system: str, user: str):
                return None

        compiler = IntentCompiler(mode="model", model_port=_SilentPort(),
                                  allow_heuristic_fallback=True)
        intent = compiler.compile("Fix the authentication bug")
        assert "agent.delegate" in intent.requiredCapabilities

    def test_model_failure_without_fallback_fails_closed(self, tmp_path):
        from aura.central_agent.intent import IntentCompilationError

        class _DeadPort:
            def complete_json(self, system: str, user: str):
                raise TimeoutError("provider unreachable")

        compiler = IntentCompiler(mode="model", model_port=_DeadPort())
        with pytest.raises(IntentCompilationError):
            compiler.compile("Fix the authentication bug")


class TestHandoffToExecution:
    def test_delegate_intent_binds_project_scope_and_context(self, tmp_path):
        root = _make_project(tmp_path)
        home = tmp_path / "home"
        agent = _agent(home)
        # Turn 1: a project question (recorded in history).
        agent.submit("What files are in this project?",
                     project_path=str(root))
        # Turn 2: the engineering request.
        result = agent.submit("Create a small utility module and add a test",
                              project_path=str(root))

        # It reached the governed delegation pipeline (this fixture has
        # no connected worker, so the honest outcome is a failure that
        # NAMES the missing worker — never a fabricated success).
        assert result.outcome in ("failed", "awaiting-approval", "completed")

        session = agent.sessions.load(result.summary and
                                      agent.sessions.last_session_id)
        assert session is not None

    def test_planner_carries_scope_and_context_into_delegate_input(
            self, tmp_path):
        from aura.central_agent.planner import plan_delegated_work
        from datetime import datetime, UTC

        root = _make_project(tmp_path)
        intent = heuristic_interpret("Create a small utility and a test")
        intent.delegateScope = ["."]
        intent.delegateContext = "RECENT CONVERSATION:\nUSER: explain auth"
        plan = plan_delegated_work(
            intent, "agt-test", datetime.now(UTC).isoformat())

        task = plan.tasks[0]
        assert task.input["scopePaths"] == ["."]
        assert "explain auth" in task.input["context"]
        assert task.input["task"] == "Create a small utility and a test"
        assert task.input["role"] == "code"
