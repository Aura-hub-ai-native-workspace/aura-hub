"""The installer executor stops the whole process tree on Windows.

`aura.environment.executor._terminate_tree` is what runs when an install times
out or errors. On POSIX it signals the process group. On Windows it called only
`proc.kill()`, which ends one process: `npm.cmd` -> `node` -> postinstall
scripts kept running against the same prefix after the timeout reported
"timeout". The two sibling helpers (`exec_._signal_tree`,
`environment.procexec._terminate_tree`) already use `taskkill /F /T`.

This is a Linux simulation of the Windows branch (it patches the platform and
the subprocess call); it does not replace a native Windows run.
"""
from __future__ import annotations

import subprocess

from aura.environment import executor as installer
from aura.environment.hostplatform import Platform, simulate


class _Proc:
    pid = 4242
    returncode = None

    def __init__(self) -> None:
        self.killed = False

    def kill(self) -> None:
        self.killed = True


def _windows() -> Platform:
    return Platform.WINDOWS


def test_windows_timeout_kills_the_whole_tree(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(
        subprocess, "run",
        lambda argv, **kw: calls.append(list(argv)) or type("R", (), {"returncode": 0})())
    proc = _Proc()
    with simulate(_windows()):
        installer._terminate_tree(proc)
    assert ["taskkill", "/F", "/T", "/PID", "4242"] in calls
    assert proc.killed                      # the direct child is still ended if taskkill is absent


def test_windows_survives_taskkill_failing(monkeypatch):
    def boom(*a, **k):
        raise OSError("taskkill not found")
    monkeypatch.setattr(subprocess, "run", boom)
    proc = _Proc()
    with simulate(_windows()):
        installer._terminate_tree(proc)     # must not raise
    assert proc.killed


def test_finished_process_is_left_alone(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no taskkill for a finished process")))
    proc = _Proc()
    proc.returncode = 0
    with simulate(_windows()):
        installer._terminate_tree(proc)
    assert not proc.killed
