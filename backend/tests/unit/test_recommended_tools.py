"""The Recommended list names real catalogue entries and offers only what the install route would run."""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from aura.api.server import create_app
from aura.environment import catalog_entry
from aura.environment.install import INSTALLER_BINARIES, is_plan, plan_install
from aura.environment.recommended import RECOMMENDED


def test_every_recommended_entry_is_a_real_catalogue_entry():
    ids = [catalog_id for catalog_id, _, _ in RECOMMENDED]
    assert len(ids) == len(set(ids))
    assert [i for i in ids if catalog_entry(i) is None] == []


def test_groups_are_only_agent_or_dev_and_both_exist():
    groups = {group for _, group, _ in RECOMMENDED}
    assert groups == {"agent", "dev"}


@pytest.mark.parametrize("catalog_id", [i for i, _, _ in RECOMMENDED])
def test_an_offered_install_uses_an_allow_listed_installer_or_asks_for_root(catalog_id):
    plan = plan_install(catalog_entry(catalog_id))
    if not is_plan(plan):
        assert plan.reason  # not installable here, and says why: never an invented command
        return
    if plan.privilege == "root":
        assert plan.executable is False  # AURA shows the command; it never runs it
    else:
        assert plan.bin in INSTALLER_BINARIES


def test_claude_code_and_codex_are_installable_through_npm():
    for catalog_id, package in (("claude-code", "@anthropic-ai/claude-code"), ("codex-cli", "@openai/codex")):
        plan = plan_install(catalog_entry(catalog_id))
        assert is_plan(plan) and plan.bin == "npm" and package in plan.command


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    return TestClient(create_app())


def test_the_recommended_route_joins_install_state(client):
    r = client.post("/environment/recommended", json={})
    assert r.status_code == 200
    items = r.json()["items"]
    assert items and all({"id", "name", "group", "installed", "installable"} <= set(i) for i in items)
    assert all(("command" in i) == i["installable"] for i in items)


def test_preview_returns_the_command_and_runs_nothing(client, monkeypatch):
    from aura.environment import executor

    async def boom(*a, **k):  # an install must never start from a preview
        raise AssertionError("preview ran an installer")

    monkeypatch.setattr(executor, "run_install_plan", boom)
    r = client.post("/environment/install", json={"id": "pnpm", "preview": True})
    body = r.json()
    assert body["installOutcome"] in ("preview", "unavailable", "guided", "failed")
    if body["installOutcome"] == "preview":
        assert body["command"].startswith("npm ")


def test_install_still_rejects_unknown_ids_and_never_takes_a_command(client):
    assert client.post("/environment/install", json={"id": "not-a-tool"}).status_code == 400
    r = client.post("/environment/install", json={"id": "rm -rf /", "preview": True})
    assert r.status_code == 400
