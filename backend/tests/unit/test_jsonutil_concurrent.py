"""write_json_atomic under concurrent writers in one process.

Regression for the shared temp name `${file}.${pid}.tmp`: threads in the
same process used the same temp path, so one writer's rename moved the
other's file and raised FileNotFoundError (152 of 600 writes in the
assessment repro). The contract now: zero exceptions, valid final JSON,
no temp file left behind.
"""
from __future__ import annotations

import json
import threading

import pytest

from aura import jsonutil
from aura.jsonutil import read_json_file, write_json_atomic


def test_two_threads_600_writes_no_exceptions_and_valid_final_json(tmp_path):
    target = tmp_path / "session.json"
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def writer(tag: str) -> None:
        barrier.wait()
        for i in range(300):
            try:
                write_json_atomic(target, {"who": tag, "i": i, "pad": "x" * 20000})
            except BaseException as exc:  # noqa: BLE001 — the test counts them
                errors.append(exc)

    threads = [threading.Thread(target=writer, args=(t,)) for t in ("http", "orch")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], errors[:3]
    final = json.loads(target.read_text(encoding="utf-8"))
    assert final["who"] in {"http", "orch"} and 0 <= final["i"] < 300
    assert list(tmp_path.glob("*.tmp")) == [], "no temp file may survive"


def test_failed_rename_removes_temp_and_keeps_previous_content(tmp_path, monkeypatch):
    target = tmp_path / "store.json"
    write_json_atomic(target, {"v": 1})

    def boom(src, dst):
        raise OSError("simulated rename failure")

    monkeypatch.setattr(jsonutil.os, "replace", boom)
    with pytest.raises(OSError, match="simulated"):
        write_json_atomic(target, {"v": 2})
    monkeypatch.undo()

    assert list(tmp_path.glob("*.tmp")) == [], "failed write must clean up its temp file"
    assert read_json_file(target, None) == {"v": 1}, "previous content must survive"


def test_permissions_follow_the_umask_like_open_w(tmp_path):
    import os
    import stat

    target = tmp_path / "perm.json"
    write_json_atomic(target, {"a": 1})
    expected = 0o666 & ~_current_umask()
    assert stat.S_IMODE(os.stat(target).st_mode) == expected


def _current_umask() -> int:
    import os

    mask = os.umask(0)
    os.umask(mask)
    return mask
