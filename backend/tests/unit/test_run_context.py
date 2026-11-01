"""A run follows the common-context protocol for its workers: load, checkpoint, failure, summary."""
import json
import os
import stat

from types import SimpleNamespace as NS

from aura.central_agent import run_context
from aura.central_agent.execution import ExecutionController


def test_checkpoint_then_load_shows_what_another_agent_recorded(tmp_path):
    d = str(tmp_path)
    run_context.checkpoint(d, "task:t1", "opencode — verified: add footer", agent="opencode")
    brief = run_context.load_brief(d)
    assert "add footer" in brief and "opencode" in brief
    mode = stat.S_IMODE(os.stat(tmp_path / "common-context.json").st_mode)
    assert mode == 0o600


def test_the_file_matches_the_store_format_the_agents_and_the_service_use(tmp_path):
    run_context.checkpoint(str(tmp_path), "k", "v")
    data = json.loads((tmp_path / "common-context.json").read_text())
    assert data["version"] == 2 and set(data) >= {"contexts", "sessions", "failures", "claims", "broadcasts", "patterns"}


def test_overwriting_a_key_keeps_the_old_value_in_history(tmp_path):
    run_context.checkpoint(str(tmp_path), "k", "one")
    run_context.checkpoint(str(tmp_path), "k", "two")
    data = json.loads((tmp_path / "common-context.json").read_text())
    assert [h["value"] for h in data["contexts"]["k"]["history"]] == ["one"]


def test_failures_and_summary_are_readable_by_the_next_agent(tmp_path):
    d = str(tmp_path)
    run_context.record_failure(d, "inline script", "blocked by CSP")
    run_context.save_summary(d, "Add footer", "1 step verified", next_steps="review")
    brief = run_context.load_brief(d)
    assert "blocked by CSP" in brief and "1 step verified" in brief and "Next: review" in brief


def test_a_missing_folder_or_corrupt_file_never_raises(tmp_path):
    assert run_context.load_brief(None) == "" and run_context.load_brief(str(tmp_path / "nope")) == ""
    (tmp_path / "common-context.json").write_text("{not json")
    run_context.checkpoint(str(tmp_path), "k", "v")          # starts fresh, no exception
    assert "v" in run_context.load_brief(str(tmp_path))


def test_a_failed_task_is_checkpointed_and_recorded_as_a_failure(tmp_path):
    task = NS(id="implement", input={"task": "add a footer"}, description="add a footer")
    outcome = NS(taskId="implement", state="failed", verified=False, detail="rate limit reached", performed=True)
    ExecutionController._checkpoint_shared(str(tmp_path), task, outcome, "claude-code")
    data = json.loads((tmp_path / "common-context.json").read_text())
    assert "claude-code" in data["contexts"]["task:implement"]["value"]
    assert data["failures"][0]["why_failed"].startswith("rate limit")
