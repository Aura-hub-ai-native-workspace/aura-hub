"""A worker's output reaches the live sink line by line, and the result is unchanged."""
from __future__ import annotations

import asyncio
import sys

from aura.exec_ import live_output, run_file


def _argv(code: str) -> list[str]:
    return [sys.executable, "-c", code]


def test_each_line_is_streamed_and_the_result_is_the_same(tmp_path):
    code = "import sys,time\nprint('one');sys.stdout.flush();print('two',file=sys.stderr);print('three')"
    plain = asyncio.run(run_file(_argv(code), str(tmp_path), 20_000))
    seen: list[tuple[str, str]] = []
    with live_output(lambda stream, line: seen.append((stream, line))):
        live = asyncio.run(run_file(_argv(code), str(tmp_path), 20_000))
    assert ("stdout", "one") in seen and ("stderr", "two") in seen and ("stdout", "three") in seen
    assert live.out == plain.out
    assert live.code == plain.code == 0


def test_a_failing_sink_never_changes_the_run(tmp_path):
    def boom(stream, line):
        raise RuntimeError("observer broke")
    with live_output(boom):
        res = asyncio.run(run_file(_argv("print('still fine')"), str(tmp_path), 20_000))
    assert "still fine" in res.out and res.code == 0


def test_no_sink_means_no_change(tmp_path):
    res = asyncio.run(run_file(_argv("print('plain')"), str(tmp_path), 20_000))
    assert "plain" in res.out


def test_the_sink_reaches_a_worker_run_through_the_fabric_private_loop(tmp_path):
    """Executors are run on a private loop in another thread when the caller is inside a loop."""
    from aura.fabric import _run_sync

    seen: list[tuple[str, str]] = []

    async def caller():
        with live_output(lambda stream, line: seen.append((stream, line))):
            return _run_sync(run_file(_argv("print('from the worker')"), str(tmp_path), 20_000))

    res = asyncio.run(caller())
    assert ("stdout", "from the worker") in seen
    assert res.code == 0
