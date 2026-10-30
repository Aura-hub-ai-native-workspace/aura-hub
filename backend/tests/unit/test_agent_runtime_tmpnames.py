"""Agent-runtime config writers must not share a temporary file name.

Regression for fixed temp names (``config.tmp``, ``file.<pid>.tmp``) shared by
threads in one process. Two concurrent writers then raced on one temp file.
"""
from __future__ import annotations

import threading
from pathlib import Path

from aura.agent_runtime import transaction
from aura.agent_runtime.adapters import opencode
from aura.agent_runtime.tmpname import unique_sibling


def test_temp_names_are_unique_siblings():
    target = Path("/some/dir/opencode.jsonc")
    names = {unique_sibling(target) for _ in range(1000)}
    assert len(names) == 1000
    assert all(n.parent == target.parent and n.name.endswith(".tmp") for n in names)


def _two_threads(fn, per_thread=200):
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def run(tag):
        barrier.wait()
        for i in range(per_thread):
            try:
                fn(tag, i)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

    threads = [threading.Thread(target=run, args=(t,)) for t in ("a", "b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return errors


def test_transaction_atomic_write_survives_two_writers(tmp_path):
    target = tmp_path / "agent.conf"
    errors = _two_threads(lambda tag, i: transaction._write_atomic(
        target, f"{tag}:{i}:{'x' * 4096}".encode()))
    assert errors == []
    text = target.read_text()
    assert text.split(":")[0] in {"a", "b"}
    assert list(tmp_path.glob("*.tmp")) == []


def test_adapter_json_writer_survives_two_writers(tmp_path):
    target = tmp_path / "opencode.json"
    errors = _two_threads(lambda tag, i: opencode._write_json(
        target, {"writer": tag, "i": i, "pad": "x" * 4096}))
    assert errors == []
    import json
    assert json.loads(target.read_text())["writer"] in {"a", "b"}
    assert list(tmp_path.glob("*.tmp")) == []
