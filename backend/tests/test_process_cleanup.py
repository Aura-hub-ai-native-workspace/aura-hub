"""Process cleanup: no orphans, no leaked descriptors, no wedged reads.

The reference primitive kills only the direct child, exactly as Node's
`execFile` does. That is preserved deliberately — changing it would alter
what happens to a process tree, which is a product decision, not a
migration one. What the port must NOT do is leak the child itself, leak
file descriptors, or block forever when a grandchild holds a pipe open.
"""

from __future__ import annotations

import os
import subprocess
import time

from aura_backend.execution import SpawnOptions, safe_shell_with_code
from aura_backend.execution.process import TIMEOUT_EXIT_CODE


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def test_a_timed_out_child_is_reaped_not_left_as_a_zombie(tmp_path):
    script = tmp_path / "slow.js"
    script.write_text("setTimeout(function(){}, 60000)\n", encoding="utf-8")
    before = subprocess.run(
        ["ps", "-o", "pid=", "--ppid", str(os.getpid())], capture_output=True, text=True
    ).stdout.split()

    result = safe_shell_with_code(
        "node slow.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=600)
    )
    assert result.timed_out is True

    # Give the OS a moment to finish reaping.
    time.sleep(0.3)
    after = subprocess.run(
        ["ps", "-o", "pid=,stat=", "--ppid", str(os.getpid())], capture_output=True, text=True
    ).stdout.splitlines()
    zombies = [line for line in after if line.split()[1:2] == ["Z"]]
    assert not zombies, f"left a zombie child: {zombies}"
    assert len(after) <= len(before) + 1


def test_repeated_timeouts_do_not_leak_file_descriptors(tmp_path):
    """Each spawn opens three pipes. If they were not closed, this would
    exhaust the descriptor limit long before the loop finished."""
    script = tmp_path / "slow.js"
    script.write_text("setTimeout(function(){}, 60000)\n", encoding="utf-8")

    def open_fds() -> int:
        return len(os.listdir("/proc/self/fd"))

    baseline = open_fds()
    for _ in range(6):
        safe_shell_with_code("node slow.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=300))
    time.sleep(0.3)
    assert open_fds() <= baseline + 4, "file descriptors leaked across timed-out spawns"


def test_a_grandchild_holding_the_pipe_does_not_wedge_the_caller(tmp_path):
    """The reader threads are joined with a bound for exactly this case: a
    child that spawns a long-lived grandchild and exits leaves the pipe
    open, and an unbounded read would hang the backend forever."""
    script = tmp_path / "spawner.js"
    script.write_text(
        "const {spawn} = require('node:child_process');\n"
        "spawn(process.execPath, ['-e', 'setTimeout(function(){}, 30000)'], "
        "{stdio: 'inherit', detached: true}).unref();\n"
        "console.log('parent-done');\n",
        encoding="utf-8",
    )
    started = time.monotonic()
    result = safe_shell_with_code(
        "node spawner.js", SpawnOptions(cwd=str(tmp_path), timeout_ms=4000)
    )
    elapsed = time.monotonic() - started
    assert elapsed < 12, f"the caller was wedged for {elapsed:.1f}s by a grandchild"
    # The process itself exited cleanly; only the inherited pipe stayed
    # open. The honest answer is the status it actually exited with, not a
    # timeout it never hit.
    assert "parent-done" in result.out
    assert result.code == 0
    assert result.timed_out is False


def test_a_child_ignoring_sigterm_is_escalated_and_does_not_survive(tmp_path):
    """A DELIBERATE difference from the reference, recorded in the
    migration map: Node sends its kill signal once and waits forever. The
    port escalates to SIGKILL after a grace period."""
    marker = tmp_path / "pid.txt"
    script = tmp_path / "stubborn.js"
    script.write_text(
        'require("node:fs").writeFileSync(process.argv[2], String(process.pid));\n'
        'process.on("SIGTERM", function(){});\n'
        "setTimeout(function(){}, 60000)\n",
        encoding="utf-8",
    )
    result = safe_shell_with_code(
        f"node stubborn.js {marker}", SpawnOptions(cwd=str(tmp_path), timeout_ms=700)
    )
    assert result.code == TIMEOUT_EXIT_CODE
    pid = int(marker.read_text().strip())
    time.sleep(0.3)
    assert not _alive(pid), "a child that ignored SIGTERM survived the timeout"
