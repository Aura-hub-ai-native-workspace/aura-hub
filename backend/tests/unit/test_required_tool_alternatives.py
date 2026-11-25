"""Required tools fail closed when the catalogue cannot prove equivalence."""

from __future__ import annotations

from types import SimpleNamespace

from aura.central_agent.provisioner import Provisioner
from aura.contracts.agent import AgentIntent, TaskPlan, TaskSpecification
from aura.environment.catalog import catalog_entry


def test_requires_tools_is_an_explicit_backward_compatible_contract_field():
    task = TaskSpecification(id="publish", description="open a pull request",
                             capabilityId="git.diff", requiresTools=["github-cli"])
    restored = TaskSpecification.model_validate(task.model_dump())

    assert restored.requiresTools == ["github-cli"]


def test_catalogue_only_shared_labels_do_not_prove_tool_equivalence():
    github = catalog_entry("github-cli")
    gitlab = catalog_entry("glab")

    assert github is not None and gitlab is not None
    assert set(github.capabilities) & set(gitlab.capabilities)
    # The metadata has no exact equivalence declaration; shared broad labels
    # cannot make GitLab CLI satisfy a GitHub CLI requirement.
    assert not hasattr(github, "equivalent_tools")
    assert not hasattr(gitlab, "equivalent_tools")


def test_missing_required_tool_is_blocked_without_substituting_a_catalogue_peer():
    calls = []
    probes = []
    plan = TaskPlan(
        planId="tool-plan", sessionId="agt-aaaaaaaaaaaa",
        intent=AgentIntent(goal="publish a pull request", expectedOutcome="opened"),
        tasks=[TaskSpecification(id="publish", description="open a pull request",
                                  capabilityId="git.diff", requiresTools=["github-cli"])],
        createdAt="2026-11-15T00:00:00Z")

    provisioner = Provisioner(
        invoke=lambda *args: calls.append(args) or {"ok": True},
        probe=lambda node_id: probes.append(node_id) or SimpleNamespace(
            present=False, version="", detail="not installed"),
        emit=lambda *args, **kwargs: None,
        decide_fn=lambda node_id: SimpleNamespace(
            allowed=False, code="not-allowlisted", reason="installation is not allowed"),
    )
    result = provisioner.ensure(
        provisioner.needs_for(plan), session_id=plan.sessionId,
        request_id=None, project_id="p")

    assert probes == ["github-cli"]
    assert calls == []
    assert result["blocked"].keys() == {"publish"}
    assert "not available" in result["blocked"]["publish"]


def test_connected_unrelated_tool_does_not_satisfy_a_different_exact_requirement():
    calls = []
    probes = []
    provisioner = Provisioner(
        invoke=lambda *args: calls.append(args) or {"ok": True},
        probe=lambda node_id: probes.append(node_id) or SimpleNamespace(
            present=False, version="", detail="not installed"),
        emit=lambda *args, **kwargs: None,
        decide_fn=lambda node_id: SimpleNamespace(
            allowed=False, code="not-allowlisted", reason="installation is not allowed"),
    )
    plan = SimpleNamespace(tasks=[SimpleNamespace(
        id="publish", description="open a GitHub pull request",
        requiresTools=["github-cli"])])

    outcome = provisioner.ensure(
        provisioner.needs_for(plan), session_id="s", request_id=None,
        project_id="p")

    assert catalog_entry("glab") is not None  # exists in the catalogue only
    assert probes == ["github-cli"]
    assert calls == []
    assert outcome["blocked"].keys() == {"publish"}
