"""Complex Workspace tasks reach authorized coding agents.

The model sometimes proposes artifact.generate (or another non-delegate
capability) for a task that names files. The planner must deterministically
correct that to agent.delegate so the work reaches a coding worker, instead
of failing later with "spec is required".
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from aura.central_agent.planner import TaskPlanner, PlanningError


def _planner():
    return TaskPlanner(known_capabilities=lambda: {
        "project.list", "project.create", "project.inspect", "mission.create",
        "mission.approve", "mission.start", "mission.inspect", "knowledge.graph",
        "memory.search", "diagnosis.run", "governance.audit", "workflow.run",
        "provider.connect", "filesystem.list", "filesystem.read",
        "filesystem.write", "terminal.execute", "agent.delegate",
        "system.install", "tool.provision", "system.uninstall", "git.status",
        "git.diff", "git.branch", "git.commit", "git.push", "http.request",
        "github.create_repository", "github.create_pr", "browser.navigate",
        "browser.read", "browser.click", "browser.type", "browser.screenshot",
        "workflow.create", "workflow.list", "knowledge.search",
        "document.ingest", "artifact.generate", "sandbox.execute",
        "web.research"})


def _intent():
    from aura.contracts.agent import AgentIntent
    return AgentIntent(goal="build a calculator", expectedOutcome="works",
                       complexity="multi-step", webResearch=False)


def test_artifact_generate_with_target_file_is_corrected_to_agent_delegate():
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "create calc.py", "capabilityId": "artifact.generate",
         "scopePaths": ["calc.py"], "input": {"task": "create calc.py with add/subtract"},
         "verification": "file exists"}]}
    plan = planner.plan_from_model(_intent(), "sid", "now", proposal)
    assert plan.tasks[0].capabilityId == "agent.delegate"
    assert plan.tasks[0].input["task"] == "create calc.py with add/subtract"


def test_artifact_generate_with_files_is_corrected():
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "create files", "capabilityId": "artifact.generate",
         "scopePaths": ["a.py", "b.py"], "input": {"task": "create files"}, "verification": "files exist"}]}
    plan = planner.plan_from_model(_intent(), "sid", "now", proposal)
    assert plan.tasks[0].capabilityId == "agent.delegate"
    assert plan.tasks[0].input["task"] == "create files"


def test_artifact_generate_without_files_is_not_corrected():
    """A capability with no file target is left alone — it may be a
    legitimate non-coding step (and will fail later if truly unsuitable)."""
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "generate doc", "capabilityId": "artifact.generate",
         "input": {"spec": {"title": "doc"}}, "verification": "doc exists"}]}
    # artifact.generate is a known capability, so it passes validation.
    # It's not corrected because there's no targetFile/files.
    plan = planner.plan_from_model(_intent(), "sid", "now", proposal)
    assert plan.tasks[0].capabilityId == "artifact.generate"


def test_unknown_capability_still_rejected():
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "do something", "capabilityId": "nonexistent.cap",
         "targetFile": "x.py", "input": {"task": "do it"}, "verification": "done"}]}
    with pytest.raises(PlanningError):
        planner.plan_from_model(_intent(), "sid", "now", proposal)


def test_agent_delegate_without_task_text_gets_task_from_description():
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "create file", "capabilityId": "artifact.generate",
         "scopePaths": ["x.py"], "input": {}, "verification": "done"}]}
    # Corrected to agent.delegate: task text is taken from the description
    # so the coding agent has a brief to work from.
    plan = planner.plan_from_model(_intent(), "sid", "now", proposal)
    assert plan.tasks[0].capabilityId == "agent.delegate"
    assert plan.tasks[0].input["task"] == "create file"


def test_multi_file_task_produces_valid_delegation():
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "create calc.py", "capabilityId": "artifact.generate",
         "scopePaths": ["calc.py"], "input": {"task": "create calc.py with add/subtract"},
         "verification": "file exists"},
        {"id": "t2", "description": "create test_calc.py", "capabilityId": "artifact.generate",
         "scopePaths": ["test_calc.py"], "input": {"task": "create tests for calc.py"},
         "verification": "tests pass"}]}
    plan = planner.plan_from_model(_intent(), "sid", "now", proposal)
    assert all(t.capabilityId == "agent.delegate" for t in plan.tasks)
    assert plan.tasks[0].input["task"] == "create calc.py with add/subtract"
    assert plan.tasks[1].input["task"] == "create tests for calc.py"


def test_filesystem_write_with_target_file_is_left_alone():
    """filesystem.write carries its own executable input (content), so
    it is a legitimate direct write and is not converted."""
    planner = _planner()
    proposal = {"tasks": [
        {"id": "t1", "description": "write file", "capabilityId": "filesystem.write",
         "scopePaths": ["out.txt"], "input": {"path": "out.txt", "content": "hello"}, "verification": "file exists"}]}
    plan = planner.plan_from_model(_intent(), "sid", "now", proposal)
    assert plan.tasks[0].capabilityId == "filesystem.write"
