"""Windows drive-letter scope matching — the OpenCode connect fix.

On Windows a governed worker's file tools hand AURA absolute
drive-letter paths (``C:\\repo\\work\\f.txt``). The scope matchers
normalized these to ``C:/repo/work/f.txt`` and then treated them as
RELATIVE because they do not start with ``/``. The in-scope readiness
write was denied hard (``outside task scope``), the worker
self-terminated (exit 42), and OpenCode readiness reported
RESPONSE_UNCORRELATED on Windows while Linux passed — the exact
asymmetry users saw. These vectors pin both matcher surfaces
(Python core + the in-worker plugin mirror) on every machine.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import pytest

from aura.governance.actions import (
    ActionVerdict,
    TaskContract,
    WorkerActionRequest,
    decide_action,
)

_WIN_CWD = "C:/repo"
_WIN_TARGET = "C:/repo/work/aura-ready.txt"
_WIN_BACKSLASH_TARGET = "C:\\repo\\work\\aura-ready.txt"
_WIN_OUT_TARGET = "C:/other/project/secret.txt"


def _win_req(target: str, action: str = "FILE_WRITE") -> WorkerActionRequest:
    return WorkerActionRequest(
        taskId="t1", workerNodeId="opencode", invocationId="i",
        attemptId="1", sequence=1, actionType=action, tool="write",
        target=target, command="", cwd=_WIN_CWD)


def _win_contract() -> TaskContract:
    return TaskContract(taskId="t1", scopePaths=["work"], cwd=_WIN_CWD)


class TestActionsCoreWindows:
    def test_drive_letter_in_scope_write_allowed(self):
        v = decide_action(_win_req(_WIN_TARGET), _win_contract())
        assert (v.decision, v.destructive) == ("ALLOW", False)

    def test_backslash_drive_letter_in_scope_write_allowed(self):
        v = decide_action(_win_req(_WIN_BACKSLASH_TARGET), _win_contract())
        assert (v.decision, v.destructive) == ("ALLOW", False)

    def test_drive_letter_outside_cwd_denied_hard(self):
        v = decide_action(_win_req(_WIN_OUT_TARGET), _win_contract())
        assert (v.decision, v.destructive) == ("DENY", True)

    def test_drive_letter_traversal_denied(self):
        v = decide_action(
            _win_req("C:/repo/work/../governance/plugin.ts"),
            _win_contract())
        assert (v.decision, v.destructive) == ("DENY", True)

    def test_drive_letter_sensitive_denied_hard(self):
        v = decide_action(
            _win_req("C:/repo/work/../.env"), _win_contract())
        assert (v.decision, v.destructive) == ("DENY", True)

    def test_relative_in_scope_still_allowed(self):
        v = decide_action(_win_req("work/aura-ready.txt"), _win_contract())
        assert (v.decision, v.destructive) == ("ALLOW", False)

    def test_lnx_absolute_path_unchanged(self):
        # POSIX behavior is untouched: absolute POSIX paths still
        # resolve against cwd.
        req = WorkerActionRequest(
            taskId="t1", workerNodeId="opencode", invocationId="i",
            attemptId="1", sequence=1, actionType="FILE_WRITE",
            tool="write", target="/repo/work/aura-ready.txt",
            command="", cwd="/repo")
        v = decide_action(req, TaskContract(
            taskId="t1", scopePaths=["work"], cwd="/repo"))
        assert (v.decision, v.destructive) == ("ALLOW", False)

    def test_posix_drive_like_word_is_judged_by_cwd_resolution(self):
        # The drive match only widens ACCEPTANCE for paths the cwd
        # prefix genuinely resolves. A relative filename that happens to
        # contain a colon is still judged relative — refused when it
        # names nothing inside the scopes.
        v = decide_action(_win_req("c:/evil.txt"), _win_contract())
        # Relative path "c:/evil.txt" does not live under scope
        # "work" — refused as before the fix.
        assert (v.decision, v.destructive) == ("DENY", True)


PLUGIN_DRIVER = (
    "import { AuraGovernance } from '__GOV_PLUGIN__';\n"
    "const h = await AuraGovernance({});\n"
    "const b = h['tool.execute.before'];\n"
    "const allow = async (t, a) => { await b({tool: t}, {args: a}); };\n"
    "const deny = async (t, a) => { let ok = false;\n"
    "  try { await b({tool: t}, {args: a}); } catch (e) {\n"
    "    ok = String(e.message).includes('AURA denied'); }\n"
    "  if (!ok) { console.log('SOFT-FAIL ' + t); process.exit(1); } };\n"
    "await allow('write', {filePath: 'C:/repo/work/aura-ready.txt'});\n"
    "await deny('write', {filePath: 'C:/other/outside.txt'});\n"
    "console.log('WIN-VECTORS-OK');\n"
)


def _driver_with_backslashes() -> str:
    """The plain driver plus one ALLOW vector whose JS string contains
    REAL backslashes ('C:\\repo\\work\\b.txt') — assembled here so
    the escaping is visible and testable in one place."""
    bs = "\\"  # JS escape producing one literal backslash in the .mjs
    injection = (
        "await allow('write', {filePath: 'C:" + bs + "repo" + bs
        + "work" + bs + "b.txt'});\n")
    return PLUGIN_DRIVER.replace(
        "await deny('write', {filePath: 'C:/other/outside.txt'});\n",
        injection + "await deny('write', {filePath: 'C:/other/outside.txt'});\n")


def _node_available() -> bool:
    return shutil.which("node") is not None


# A destructive deny self-terminates (exit 42) BEFORE the driver's
# trailing log line — so ACCEPT runs and DENY runs must be separate
# node processes. That is also the real production shape: the worker
# dies on the spot when it is stopped.
ALLOW_DRIVER_TAIL = (
    "await allow('write', {filePath: 'C:/repo/work/aura-ready.txt'});\n"
    "console.log('WIN-VECTORS-OK');\n"
)

DENY_DRIVER_TAIL = (
    "await deny('write', {filePath: 'C:/other/outside.txt'});\n"
    "console.log('UNCHANGED');\n"          # never reached
)


def _driver(tail: str, backslash_vector: bool) -> str:
    head = (
        "import { AuraGovernance } from '__GOV_PLUGIN__';\n"
        "const h = await AuraGovernance({});\n"
        "const b = h['tool.execute.before'];\n"
        "const allow = async (t, a) => { await b({tool: t}, {args: a}); };\n"
        "const deny = async (t, a) => {\n"
        "  try { await b({tool: t}, {args: a});\n"
        "    console.log('NOT-DENIED ' + t); process.exit(1); }\n"
        "  catch (e) {\n"
        "    if (!String(e.message).includes('AURA denied'))\n"
        "      { console.log('WRONG-REASON ' + e.message); process.exit(1); }\n"
        "    console.log('DENIED-OK'); process.exit(0); } };\n")
    vectors = "await allow('write', {filePath: 'work/relative.txt'});\n"
    if backslash_vector:
        # Real backslashes in the JS string, spelled with the JS escape:
        vec = "'C:\\\\repo\\\\work\\\\b.txt'"
        vectors += "await allow('write', {filePath: " + vec + "});\n"
    return head + vectors + tail


def _compile_to(tmp: str) -> str:
    from aura.governance.opencode import compile_plugin

    src = compile_plugin({"taskId": "t1", "scopePaths": ["work"],
                          "cwd": _WIN_CWD, "nodeId": "opencode",
                          "invocationId": "i", "attempt": "1"})
    path = os.path.join(tmp, "gov.mjs")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)
    return path


def _run_driver(driver: str) -> subprocess.CompletedProcess:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        plugin = _compile_to(tmp)
        return subprocess.run(
            ["node", "-e",
             driver.replace("__GOV_PLUGIN__", plugin.replace("\\", "/"))],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "AURA_ACTION_LOG": ""})


@pytest.mark.skipif(not _node_available(), reason="node unavailable")
class TestPluginMirrorWindows:
    def test_plugin_scope_accepts_drive_letter_paths_in_node(self):
        proc = _run_driver(
            _driver(ALLOW_DRIVER_TAIL, backslash_vector=True))
        assert proc.returncode == 0, proc.stderr or proc.stdout
        assert "WIN-VECTORS-OK" in proc.stdout, proc.stderr

    def test_plugin_denies_out_of_cwd_drive_path_and_self_terminates(
            self):
        proc = _run_driver(_driver(DENY_DRIVER_TAIL, backslash_vector=False))
        # Real plugin output: exit 42 destructive deny; it never logs.
        assert proc.returncode == 42, proc.stdout or proc.stderr
        assert "UNCHANGED" not in proc.stdout

    def test_plugin_denies_relative_traversal_escape_in_node(self):
        driver = _driver(
            ("await deny('write', {filePath: 'work/../.env'});\n"), False)
        proc = _run_driver(driver)
        # work/../.env spans out of scope AND touches sensitive
        # material; either reason is refusal.
        assert proc.returncode == 42, proc.stdout or proc.stderr
