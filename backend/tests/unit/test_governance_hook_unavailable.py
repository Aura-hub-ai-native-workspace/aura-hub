"""A governance failure never authorizes the operation it governs (F-23).

History. Loop 2 made the Claude PreToolUse hook *record* an UNAVAILABLE
decision when it could not read its scope, but it still exited 0, which Claude
treats as allow. The owner decided that must fail closed. Now:

  * a scope document that exists but is unreadable, empty, malformed, not an
    object, or carries wrong-typed fields -> exit 2 and a DENY record;
  * hook input that is not a JSON object, a governance core that cannot load,
    an unexpected error, and any verdict other than an explicit ALLOW -> exit 2;
  * a scope document that is genuinely absent (no argument, or no file at the
    path) keeps its documented meaning: no per-task scope was staged, runtime
    confinement is the boundary, and the call is recorded as UNSCOPED;
  * the launch command maps every exit code other than 0 and 2 to 2, so a hook
    that cannot even start (python3 missing, crash) cannot allow the write;
  * dispatch: when a scoped task's governance cannot be staged, agent.delegate
    refuses to start the worker instead of running it ungoverned.

Each deny is checked against both the exit code and the logged decision, so the
audit record and the actual enforcement agree.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]
HOOK = BACKEND / "aura" / "governance" / "claude_hook.py"

GOOD_PAYLOAD = json.dumps({"tool_name": "Write", "tool_input": {"file_path": "src/a.py"}})
OUT_PAYLOAD = json.dumps({"tool_name": "Write", "tool_input": {"file_path": "billing/p.py"}})


def _run(tmp_path, stdin, scope_arg, hook=HOOK, extra_env=None):
    log = tmp_path / "actions.jsonl"
    args = [sys.executable, str(hook)] + ([scope_arg] if scope_arg is not None else [])
    env = {"PATH": os.environ.get("PATH", ""), "AURA_ACTION_LOG": str(log), **(extra_env or {})}
    proc = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=60,
                          cwd=str(BACKEND), env=env)
    events = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return proc, events


def _assert_denied(proc, events, reason_part):
    assert proc.returncode == 2, (proc.returncode, proc.stderr)
    assert [e["decision"] for e in events] == ["DENY"]          # the record says what the exit code does
    assert "governance unavailable" in events[0]["reason"]
    assert reason_part in events[0]["reason"]
    assert "AURA denied" in proc.stderr


@pytest.fixture()
def scope(tmp_path):
    p = tmp_path / "scope.json"
    p.write_text(json.dumps({"taskId": "t1", "nodeId": "claude", "invocationId": "i", "attempt": "1",
                             "cwd": "/repo", "scopePaths": ["src"]}))
    return str(p)


# ── valid scope keeps its semantics ────────────────────────────────────────

def test_a_valid_scope_allows_inside_and_denies_outside(tmp_path, scope):
    proc, events = _run(tmp_path, GOOD_PAYLOAD, scope)
    assert proc.returncode == 0 and [e["decision"] for e in events] == ["ALLOW"]
    second = tmp_path / "second"
    second.mkdir()
    proc, events = _run(second, OUT_PAYLOAD, scope)
    assert proc.returncode == 2 and [e["decision"] for e in events] == ["DENY"]
    assert "outside" in proc.stderr


def test_an_empty_scope_list_keeps_its_documented_meaning(tmp_path):
    """No scope paths: the legacy boundary applies, the call is judged normally."""
    p = tmp_path / "scope.json"
    p.write_text(json.dumps({"taskId": "t", "nodeId": "n", "invocationId": "i", "attempt": "1", "cwd": "/repo"}))
    proc, events = _run(tmp_path, GOOD_PAYLOAD, str(p))
    assert proc.returncode == 0 and [e["decision"] for e in events] == ["ALLOW"]


# ── genuinely missing: documented behaviour preserved, recorded honestly ───

def test_no_scope_argument_is_recorded_as_unscoped_not_as_an_allow(tmp_path):
    proc, events = _run(tmp_path, GOOD_PAYLOAD, None)
    assert proc.returncode == 0
    assert [e["decision"] for e in events] == ["UNSCOPED"]


def test_no_file_at_the_staged_path_is_recorded_as_unscoped(tmp_path):
    proc, events = _run(tmp_path, GOOD_PAYLOAD, str(tmp_path / "never-staged.json"))
    assert proc.returncode == 0
    assert [e["decision"] for e in events] == ["UNSCOPED"]
    assert "ALLOW" not in [e["decision"] for e in events]


# ── exists but unusable: fail closed ───────────────────────────────────────

@pytest.mark.parametrize("content", ["", "   \n", "{truncated", '{"scopePaths": ["src"', "[]", '"text"', "12", "null"])
def test_a_malformed_scope_file_denies(tmp_path, content):
    path = tmp_path / "scope.json"
    path.write_text(content)
    proc, events = _run(tmp_path, GOOD_PAYLOAD, str(path))
    _assert_denied(proc, events, "scope document unusable")


def test_a_binary_scope_file_denies(tmp_path):
    path = tmp_path / "scope.json"
    path.write_bytes(bytes(range(256)))
    _assert_denied(*_run(tmp_path, GOOD_PAYLOAD, str(path)), "scope document unusable")


def test_a_directory_in_place_of_the_scope_file_denies(tmp_path):
    path = tmp_path / "scope.json"
    path.mkdir()
    _assert_denied(*_run(tmp_path, GOOD_PAYLOAD, str(path)), "scope document unusable")


def test_a_dangling_symlink_in_place_of_the_scope_file_denies(tmp_path):
    path = tmp_path / "scope.json"
    path.symlink_to(tmp_path / "nowhere")
    _assert_denied(*_run(tmp_path, GOOD_PAYLOAD, str(path)), "scope document unusable")


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read a mode-000 file")
def test_an_unreadable_scope_file_denies(tmp_path):
    path = tmp_path / "scope.json"
    path.write_text(json.dumps({"scopePaths": ["src"]}))
    path.chmod(0)
    try:
        _assert_denied(*_run(tmp_path, GOOD_PAYLOAD, str(path)), "scope document unusable")
    finally:
        path.chmod(0o600)


@pytest.mark.parametrize("doc, part", [
    ({"scopePaths": "src"}, "scopePaths"),
    ({"scopePaths": ["src", 7]}, "scopePaths"),
    ({"scopePaths": {"a": 1}}, "scopePaths"),
    ({"cwd": ["/repo"]}, "cwd"),
    ({"auraRoot": 5}, "auraRoot"),
    ({"seq": "x"}, "seq"),
    ({"seq": True}, "seq"),
    ({"taskId": {"a": 1}}, "taskId"),
])
def test_a_scope_document_with_invalid_fields_denies(tmp_path, doc, part):
    path = tmp_path / "scope.json"
    path.write_text(json.dumps(doc))
    proc, events = _run(tmp_path, GOOD_PAYLOAD, str(path))
    _assert_denied(proc, events, part)


@pytest.mark.parametrize("stdin", ["{not json", "[1, 2]", '"text"', "\xff\xfe"])
def test_unreadable_hook_input_denies(tmp_path, scope, stdin):
    _assert_denied(*_run(tmp_path, stdin, scope), "hook input unreadable")


def test_a_non_object_tool_input_denies(tmp_path, scope):
    payload = json.dumps({"tool_name": "Write", "tool_input": ["src/a.py"]})
    _assert_denied(*_run(tmp_path, payload, scope), "tool_input")


def test_an_empty_input_still_goes_through_the_decision_path(tmp_path, scope):
    """An empty stdin was never a parse error: it is an empty tool call, refused
    by the decision path for naming no target."""
    proc, events = _run(tmp_path, "", scope)
    assert proc.returncode == 2
    assert [e["decision"] for e in events] == ["DENY"]


def test_a_governance_core_that_cannot_load_denies(tmp_path):
    """The hook is staged as a COPY away from the package; point its auraRoot at
    an empty directory and the governance core cannot be imported."""
    staged = tmp_path / "gov" / "claude_hook.py"
    staged.parent.mkdir()
    shutil.copy(HOOK, staged)
    empty = tmp_path / "empty-root"
    empty.mkdir()
    scope_path = tmp_path / "scope.json"
    scope_path.write_text(json.dumps({"taskId": "t", "cwd": "/repo", "scopePaths": ["src"],
                                      "auraRoot": str(empty)}))
    proc, events = _run(tmp_path, GOOD_PAYLOAD, str(scope_path), hook=staged)
    _assert_denied(proc, events, "governance core could not be loaded")


# ── in-process: an unexpected error and a non-ALLOW verdict both block ─────

def _load_hook():
    import importlib.util

    spec = importlib.util.spec_from_file_location("aura_claude_hook_under_test", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_an_unexpected_error_denies(tmp_path, monkeypatch, capsys):
    hook = _load_hook()
    monkeypatch.setenv("AURA_ACTION_LOG", str(tmp_path / "log.jsonl"))

    def boom():
        raise RuntimeError("surprise")

    monkeypatch.setattr(hook, "main", boom)
    assert hook._guarded() == 2
    rows = [json.loads(line) for line in (tmp_path / "log.jsonl").read_text().splitlines()]
    assert [r["decision"] for r in rows] == ["DENY"] and "surprise" in rows[0]["reason"]
    assert "AURA denied" in capsys.readouterr().err


@pytest.mark.parametrize("verdict_attrs", [
    {"decision": "UNAVAILABLE", "reason": "governance could not decide", "destructive": False},
    {"decision": "MAYBE", "reason": "", "destructive": False},
    {"decision": "UNAVAILABLE"},                    # incomplete verdict: still must not allow
])
def test_a_verdict_other_than_allow_never_allows(tmp_path, scope, monkeypatch, verdict_attrs):
    hook = _load_hook()
    import aura.governance.actions as actions

    verdict = type("Odd", (), verdict_attrs)()
    monkeypatch.setattr(actions, "decide_action", lambda req, contract: verdict)
    monkeypatch.setattr(sys, "argv", ["claude_hook.py", scope])
    monkeypatch.setattr(sys, "stdin", io.StringIO(GOOD_PAYLOAD))
    monkeypatch.setenv("AURA_ACTION_LOG", str(tmp_path / "log.jsonl"))
    assert hook._guarded() == 2


# ── the launch command: a hook that cannot run cannot allow ────────────────

@pytest.mark.skipif(os.name == "nt", reason="POSIX shell wrapper")
class TestLaunchCommand:
    def _command(self, hook, scope_path):
        from aura.governance.claude import compile_settings

        settings = compile_settings(str(hook), str(scope_path))
        return settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]

    def _sh(self, command, stdin="", path=None):
        env = {"PATH": os.environ.get("PATH", "") if path is None else path}
        return subprocess.run(["/bin/sh", "-c", command], input=stdin, capture_output=True, text=True,
                              timeout=60, cwd=str(BACKEND), env=env)

    def test_the_real_hook_keeps_its_exit_codes_through_the_wrapper(self, tmp_path, scope):
        cmd = self._command(HOOK, scope)
        assert self._sh(cmd, GOOD_PAYLOAD).returncode == 0
        assert self._sh(cmd, OUT_PAYLOAD).returncode == 2

    def test_a_missing_interpreter_denies(self, tmp_path, scope):
        cmd = self._command(HOOK, scope)
        proc = self._sh(cmd, GOOD_PAYLOAD, path="/nonexistent")
        assert proc.returncode == 2                     # unwrapped this would be 127, a non-blocking error

    def test_a_crashing_hook_denies(self, tmp_path):
        crash = tmp_path / "crash.py"
        crash.write_text("import sys\nsys.exit(1)\n")
        assert self._sh(self._command(crash, tmp_path / "s.json")).returncode == 2

    def test_a_hook_that_was_never_staged_denies(self, tmp_path):
        assert self._sh(self._command(tmp_path / "absent.py", tmp_path / "s.json")).returncode == 2

    def test_paths_with_spaces_are_quoted(self, tmp_path):
        spaced = tmp_path / "with space"
        spaced.mkdir()
        scope_path = spaced / "scope.json"
        scope_path.write_text(json.dumps({"taskId": "t", "nodeId": "n", "invocationId": "i", "attempt": "1",
                                          "cwd": "/repo", "scopePaths": ["src"], "auraRoot": str(BACKEND)}))
        hook = spaced / "claude_hook.py"
        shutil.copy(HOOK, hook)
        cmd = self._command(hook, scope_path)
        assert self._sh(cmd, GOOD_PAYLOAD).returncode == 0
        assert self._sh(cmd, OUT_PAYLOAD).returncode == 2


# ── dispatch: a staging failure refuses the run, nothing is spawned ────────

class TestDispatch:
    def _inv(self, cwd, node):
        return {"id": "inv-f23", "input": {"task": "do it", "scopePaths": ["src/auth"]},
                "context": {"cwd": cwd, "taskId": "t23", "actor": {"kind": "agent", "id": "t"}},
                "node": node}

    @pytest.mark.parametrize("node, stager", [
        ({"id": "opencode", "name": "OpenCode", "binary": "opencode"}, "stage_opencode"),
        ({"id": "claude-code", "name": "Claude Code", "binary": "claude"}, "stage_claude"),
    ])
    def test_a_staging_failure_refuses_and_nothing_is_started(self, tmp_path, monkeypatch, node, stager):
        import aura.executors as ex
        from aura.governance import staging

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        started = []

        async def fake_run(*args, **kwargs):
            started.append(args)
            raise AssertionError("the worker must not be started")

        def broken(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(ex, "run_agent", fake_run)
        monkeypatch.setattr(staging, stager, broken)
        out = asyncio.run(ex.agent_delegate_run(self._inv(str(tmp_path), node)))
        assert out["ok"] is False and out.get("refused") is True
        assert out["output"]["blocked"] == "governance-staging-failed"
        assert "disk full" in out["detail"] and "nothing has run" in out["detail"]
        assert started == []

    def test_the_same_task_runs_when_staging_works(self, tmp_path, monkeypatch):
        """Control: without the injected failure the worker is started, so the
        refusal above is about the failure and not about the setup."""
        import aura.executors as ex

        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        started = []

        class Out:
            out, code, timedOut, signal = "done", 0, False, None

        async def fake_run(bin_name, args, cwd, timeout_ms=None, env=None):
            started.append(bin_name)
            return Out()

        monkeypatch.setattr(ex, "run_agent", fake_run)
        node = {"id": "opencode", "name": "OpenCode", "binary": "opencode"}
        asyncio.run(ex.agent_delegate_run(self._inv(str(tmp_path), node)))
        assert started == ["opencode"]
