"""Intent compiler — deterministic rules, scripted-model validation, fail-closed."""

from __future__ import annotations

import pytest

from aura.central_agent.intent import (
    IntentCompilationError,
    IntentCompiler,
    ScriptedModelPort,
    heuristic_interpret,
)


class TestHeuristic:
    def test_status_intent_is_read_only(self):
        intent = heuristic_interpret("list my workflows and show status")
        assert intent.complexity == "single"
        assert intent.requiredCapabilities == ["workflow.list"]
        assert any("Read-only" in c for c in intent.constraints)

    def test_authoring_intent_targets_workflow_create(self):
        intent = heuristic_interpret("create a workflow that shows git status daily")
        assert "workflow.create" in intent.requiredCapabilities
        assert intent.complexity == "workflow"

    def test_scheduling_detected(self):
        assert heuristic_interpret("create a workflow every morning").urgency == "scheduled"

    def test_empty_request_needs_clarification(self):
        intent = heuristic_interpret("   ")
        assert intent.needsClarification is True
        assert intent.clarificationQuestion

    def test_unknown_mapping_flags_clarification(self):
        intent = heuristic_interpret("flurb the bazzle")
        assert intent.needsClarification is True

    def test_fixing_intent_plans_governed_delegation(self):
        """"Fix my tests" used to be answered with a clarification
        question, because this installation had no way to act on it.
        It does now: the request becomes a delegated task under a task
        contract. What must NOT change is that it stays governed —
        agent.delegate is high risk, so it still parks for a human
        before any worker runs, and "silently" was always the operative
        word in the old name."""
        intent = heuristic_interpret("fix my tests")
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert intent.approvalLikely is True
        assert intent.needsClarification is False


class TestDelegateScope:
    """Scope extraction from user text — the words become a task
    contract, so a wrong entry is a wrong boundary the governance
    layer will then enforce literally (a real run parked exactly this
    way: the sentence's trailing period minted the scope entry
    `src/slugify.test.js.`, and every write to the real file was
    denied as out-of-scope until the correction budget ran out)."""

    def test_trailing_sentence_punctuation_is_not_scope(self):
        from aura.central_agent.intent import _delegate_scope
        scope = _delegate_scope(
            "Implement slugify in src/slugify.js. Then add a test in "
            "src/slugify.test.js. Delegate the coding to a worker.")
        assert "src/slugify.test.js" in scope
        for entry in scope:
            assert not entry.endswith("."), entry

    def test_version_numbers_keep_their_dots(self):
        from aura.central_agent.intent import _delegate_scope
        scope = _delegate_scope(
            "update the dependency pinned in src/config/file.v2.json "
            "inside src/config")
        assert "src/config/file.v2.json" in scope

    def test_unmentioned_files_stay_out_of_scope(self):
        from aura.central_agent.intent import _delegate_scope
        assert _delegate_scope("refactor the parser module") == []

    def test_multi_task_plan_classifies_as_delegation_not_file_write(self):
        """A parallel-execution objective names work and files, not a
        single write. Its first sentence once matched the file-write
        pattern and captured the whole plan as a "path", planning one
        filesystem.write of prose instead of delegating to workers."""
        intent = heuristic_interpret(
            "Create two independent utilities in the working project. "
            "Task one: implement a slugify function with its tests in "
            "src/slugify.py. Task two: independently implement a "
            "normalize_whitespace function with its tests in "
            "src/normalize.py. Delegate both coding tasks to two "
            "different connected workers running in parallel.")
        assert intent.requiredCapabilities == ["agent.delegate"]
        assert getattr(intent, "delegateTask", None)
        assert "src/slugify.py" in (getattr(intent, "delegateScope", None) or [])

    def test_real_file_write_still_classifies_as_write(self):
        intent = heuristic_interpret(
            "write a file called notes.txt with hello world")
        assert intent.requiredCapabilities == ["filesystem.write"]
        assert getattr(intent, "writePath", None) == "notes.txt"


class TestModelMode:
    def test_scripted_model_output_validated(self):
        port = ScriptedModelPort([("deploy", {
            "goal": "prepare release", "expectedOutcome": "release prepared",
            "complexity": "multi-step", "urgency": "immediate",
            "requiredCapabilities": ["terminal.execute"],
        })])
        compiler = IntentCompiler(mode="model", model_port=port)
        intent = compiler.compile("please deploy")
        assert intent.goal == "prepare release"

    def test_fenced_json_tolerated(self):
        port = ScriptedModelPort([("x", 'Sure! ```json\n{"goal": "g", '
                                        '"expectedOutcome": "e"}\n```')])
        compiler = IntentCompiler(mode="model", model_port=port)
        assert compiler.compile("x").goal == "g"

    def test_invalid_schema_fails_closed(self):
        port = ScriptedModelPort([("x", {"wrong": "shape"})])
        compiler = IntentCompiler(mode="model", model_port=port)
        with pytest.raises(IntentCompilationError):
            compiler.compile("x")

    def test_no_reply_fails_closed_unless_fallback_allowed(self):
        compiler = IntentCompiler(mode="model", model_port=ScriptedModelPort([]))
        with pytest.raises(IntentCompilationError):
            compiler.compile("anything")
        lenient = IntentCompiler(mode="model", model_port=ScriptedModelPort([]),
                                 allow_heuristic_fallback=True)
        assert lenient.compile("list workflows").requiredCapabilities == ["workflow.list"]

    def test_injected_capability_names_stripped(self):
        port = ScriptedModelPort([("x", {"goal": "g", "expectedOutcome": "e",
                                         "requiredCapabilities": [
                                             "system.install", "BAD NAME", "",
                                             "workflow.list"]})])
        compiler = IntentCompiler(mode="model", model_port=port)
        intent = compiler.compile("x")
        # only well-formed ids survive; nothing the model invents becomes authority
        assert intent.requiredCapabilities == ["system.install", "workflow.list"]


class TestModeGuards:
    def test_model_mode_requires_port(self):
        with pytest.raises(ValueError):
            IntentCompiler(mode="model")

    def test_unknown_mode_rejected(self):
        with pytest.raises(ValueError):
            IntentCompiler(mode="psychic")
