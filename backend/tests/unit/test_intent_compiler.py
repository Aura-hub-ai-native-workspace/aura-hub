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

    def test_fixing_intent_does_not_silently_plan_execution(self):
        intent = heuristic_interpret("fix my tests")
        assert intent.approvalLikely is True
        assert intent.requiredCapabilities == []


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
