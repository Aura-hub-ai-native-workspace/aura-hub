"""OpenCode workers run on a private free model and move on when one is out."""
from __future__ import annotations

import asyncio

import pytest

from aura.workers import free_models as fm

LISTED = ["opencode/pulse-alpha-free", "opencode/beam-free", "opencode/glm-5.3-flash-free",
          "opencode/deepseek-v4.1-flash-free", "opencode/big-pickle"]


@pytest.fixture(autouse=True)
def _on(monkeypatch):
    monkeypatch.setenv("AURA_FREE_MODELS", "on")
    fm._listed.clear()  # noqa: SLF001
    monkeypatch.setattr(fm, "_list_models", lambda binary: list(LISTED))
    yield
    fm._listed.clear()  # noqa: SLF001


def test_picks_the_most_private_listed_model():
    assert fm.pick() == "opencode/glm-5.3-flash-free"


def test_never_picks_a_model_that_may_train_on_the_code(monkeypatch):
    fm._listed.clear()  # noqa: SLF001
    monkeypatch.setattr(fm, "_list_models", lambda b: ["opencode/pulse-alpha-free",
                                                        "opencode/big-pickle"])
    assert fm.pick() is None


def test_a_rested_model_is_skipped_by_later_tasks_too():
    fm.cool_down("opencode/glm-5.3-flash-free")
    assert fm.pick() == "opencode/deepseek-v4.1-flash-free"
    assert fm.pick(exclude=("opencode/deepseek-v4.1-flash-free",)) == "opencode/beam-free"


def test_rest_expires():
    fm.cool_down("opencode/glm-5.3-flash-free", seconds=-1)
    assert fm.pick() == "opencode/glm-5.3-flash-free"


def test_off_leaves_the_model_to_opencode(monkeypatch):
    monkeypatch.setenv("AURA_FREE_MODELS", "off")
    assert fm.pick() is None


def test_an_empty_list_is_not_remembered(monkeypatch):
    fm._listed.clear()  # noqa: SLF001
    answers = [[], list(LISTED)]
    monkeypatch.setattr(fm, "_list_models", lambda b: answers.pop(0))
    assert fm.pick() is None
    assert fm.pick() == "opencode/glm-5.3-flash-free"


def test_no_list_means_no_choice(monkeypatch):
    fm._listed.clear()  # noqa: SLF001
    monkeypatch.setattr(fm, "_list_models", lambda b: (_ for _ in ()).throw(OSError("no opencode")))
    assert fm.pick() is None


@pytest.mark.parametrize("out,capacity", [
    ("Error: Rate limit exceeded for this model", True),
    ("Error: 429 Too Many Requests", True),
    ("Error: model not found: opencode/beam-free", True),
    ("Error: Permission denied: edit", False),
    ("Added handling for HTTP 429 responses in client.py.", False),
    ("Done. Rate limit middleware added and tested.", False),
])
def test_only_an_error_line_counts_as_out_of_capacity(out, capacity):
    assert fm.is_capacity_failure(out) is capacity


def test_with_model_sets_or_replaces_the_flag():
    assert fm.with_model(["run", "--auto", "task"], "m") == ["run", "--auto", "--model", "m", "task"]
    assert fm.with_model(["run", "--model", "a", "task"], "b") == ["run", "--model", "b", "task"]


class _Out:
    def __init__(self, out, code=0):
        self.out, self.code, self.timedOut, self.signal = out, code, False, None


def _inv(cwd, extra=None):
    return {"id": "inv-1", "input": {"task": "fix the login bug", **(extra or {})},
            "context": {"cwd": cwd, "taskId": "t1", "actor": {"kind": "agent", "id": "t"}},
            "node": {"id": "opencode", "name": "OpenCode", "binary": "opencode"}}


def _run(tmp_path, monkeypatch, outputs, extra=None):
    import aura.executors as ex

    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    seen: list[list[str]] = []

    async def fake_run(bin_name, args, cwd, timeout_ms=None, env=None):
        seen.append(list(args))
        return _Out(outputs[len(seen) - 1])

    monkeypatch.setattr(ex, "run_agent", fake_run)
    out = asyncio.run(ex.agent_delegate_run(_inv(str(tmp_path), extra)))
    models = [a[a.index("--model") + 1] if "--model" in a else None for a in seen]
    return out, models


def test_the_worker_moves_to_the_next_model_when_one_is_out(tmp_path, monkeypatch):
    out, models = _run(tmp_path, monkeypatch,
                       ["Error: Rate limit exceeded", "Error: 429 Too Many Requests", "done"])
    assert models == ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free",
                      "opencode/beam-free"]
    assert out["ok"] is True, out
    assert out["output"]["model"] == "opencode/beam-free"
    assert out["output"]["modelsOutOfCapacity"] == models[:2]


def test_a_model_the_task_names_is_never_switched(tmp_path, monkeypatch):
    out, models = _run(tmp_path, monkeypatch, ["Error: Rate limit exceeded"],
                       extra={"model": "opencode/my-paid-model"})
    assert models == ["opencode/my-paid-model"]
    assert "modelsOutOfCapacity" not in out["output"]


def test_an_ordinary_failure_is_not_retried_on_another_model(tmp_path, monkeypatch):
    _, models = _run(tmp_path, monkeypatch, ["Error: Permission denied: edit"])
    assert models == ["opencode/glm-5.3-flash-free"]
