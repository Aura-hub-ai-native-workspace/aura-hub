"""Issue #112 — ownership-based cleanup of workers left by a dead AURA.

Fast, cross-platform tests of the rules (no Docker needed; containers are a
fake listing, everything else is real: OS locks, child processes, pids).
Real-API crash/restart acceptance (A1–A5, A8 with Docker) is in
scripts/orphan-lifecycle-verify.py.

A9  lock semantics: held while the owner lives, free after it is killed.
A4/A5 another live instance's containers and workers are never touched.
A6  legacy container: removed only when its owner pid is confirmed dead.
A7  host worker: terminated only when its owner is dead AND its start
    identity still matches; a reused pid (decoy) is never signalled.
A8  Docker unavailable: nothing fails, cleanup is deferred and reported.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aura.lifecycle import instance, registry
from aura.lifecycle.instance import ABSENT, FREE, HELD, UNKNOWN, home_tag, instance_state
from aura.lifecycle.procident import ALIVE, DEAD, pid_state, start_identity
from aura.lifecycle.reaper import reap_orphans

BACKEND = Path(__file__).resolve().parents[2]
POSIX = os.name == "posix"

HOLDER = """
import sys, time
sys.path.insert(0, sys.argv[1])
from aura.lifecycle import instance
i = instance.acquire(sys.argv[2])
print(i.id, i.verified, __import__("os").getpid(), flush=True)
time.sleep(300)
"""


@pytest.fixture(autouse=True)
def _fresh_instance():
    instance._reset_for_tests()
    yield
    instance._reset_for_tests()


def _hard_kill(pid: int) -> None:
    os.kill(pid, signal.SIGKILL if POSIX else signal.SIGTERM)  # SIGTERM is TerminateProcess on Windows


def _holder(home: Path) -> tuple[subprocess.Popen, str, int]:
    """A separate process that holds an instance lock for `home`."""
    p = subprocess.Popen([sys.executable, "-c", HOLDER, str(BACKEND), str(home)],
                         stdout=subprocess.PIPE, text=True)
    line = p.stdout.readline().split()
    assert len(line) == 3 and line[1] == "True", f"holder did not verify its lock: {line}"
    return p, line[0], int(line[2])


def _stop(p: subprocess.Popen, pid: int) -> None:
    if p.poll() is None:
        try:
            _hard_kill(pid)
        except OSError:
            pass
        p.wait(30)


def _sleeper(new_session: bool = True) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"],
                            **({"start_new_session": True} if POSIX and new_session else {}))


def _dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def _free_instance(home: Path) -> str:
    """An instance whose owner is dead: its lock file exists and nobody holds it."""
    p, iid, pid = _holder(home)
    _stop(p, pid)
    assert instance_state(home, iid) == FREE
    return iid


# ── A9: lock semantics ─────────────────────────────────────────────────────────

def test_a9_own_lock_is_held_and_verified(tmp_path):
    me = instance.acquire(tmp_path)
    assert me.verified is True
    assert instance_state(tmp_path, me.id) == HELD, "a second handle must be refused"
    assert instance.acquire(tmp_path) is me, "one instance per process"


def test_a9_lock_is_held_while_owner_lives_and_free_after_a_hard_kill(tmp_path):
    p, iid, pid = _holder(tmp_path)
    try:
        assert instance_state(tmp_path, iid) == HELD
    finally:
        _stop(p, pid)
    assert instance_state(tmp_path, iid) == FREE


def test_a9_liveness_is_never_inferred_from_file_existence(tmp_path):
    assert instance_state(tmp_path, "0" * 32) == ABSENT
    assert instance_state(tmp_path, "not-hex!") == UNKNOWN
    p, iid, pid = _holder(tmp_path)
    try:
        lock = instance.instances_dir(tmp_path) / f"{iid}.lock"
        assert lock.exists() and instance_state(tmp_path, iid) == HELD
    finally:
        _stop(p, pid)
    assert lock.exists() and instance_state(tmp_path, iid) == FREE, "exists, but nobody holds it"


# ── process identity ──────────────────────────────────────────────────────────

def test_start_identity_names_one_process():
    a, b = _sleeper(), _sleeper()
    try:
        ia, ib = start_identity(a.pid), start_identity(b.pid)
        if ia is None:
            pytest.skip(f"start identity unsupported on {sys.platform}")
        assert ia == start_identity(a.pid), "stable for the same process"
        assert ia != ib or a.pid == b.pid
        assert pid_state(a.pid) == ALIVE
    finally:
        for p in (a, b):
            p.kill()
            p.wait(30)
    assert pid_state(a.pid) == DEAD


# ── containers (fake Docker listing, real locks) ──────────────────────────────

def _row(name, inst="", home="", owner=""):
    return {"name": name, "instance": inst, "home": home, "owner": owner, "state": "running"}


def test_container_rules_a4_a6(tmp_path):
    home = tmp_path / "home"
    me = instance.acquire(home)
    tag = home_tag(home)
    dead_iid = _free_instance(home)
    live, live_iid, live_pid = _holder(home)           # another LIVE instance, same home (A4/A5)
    # A live legacy owner: a real running process on every platform (pid 1
    # is not a process on Windows, where it reads, correctly, as dead).
    legacy_owner = _sleeper()
    other_home_iid = "f" * 32
    rows = [
        _row("aura-run-mine", me.id, tag),
        _row("aura-run-dead-owner", dead_iid, tag),
        _row("aura-run-live-owner", live_iid, tag),
        _row("aura-run-other-home", other_home_iid, "0123456789abcdef"),
        _row("aura-run-no-lock-file", "a" * 32, tag),
        _row("aura-run-legacy-dead", owner=str(_dead_pid())),
        _row("aura-run-legacy-live", owner=str(legacy_owner.pid)),
        _row("aura-run-legacy-unreadable", owner="x"),
        _row("someone-elses-container", dead_iid, tag),
    ]
    removed: list[str] = []
    try:
        report = reap_orphans(home, me, workers=False, docker_list=lambda: rows,
                              docker_remove=lambda n: removed.append(n) or True)
    finally:
        _stop(live, live_pid)
        legacy_owner.kill()
        legacy_owner.wait(15)
    assert sorted(removed) == ["aura-run-dead-owner", "aura-run-legacy-dead"]
    kept = {k["name"]: k["reason"] for k in report["keptContainers"]}
    assert kept["aura-run-mine"] == "owned by this instance"
    assert kept["aura-run-live-owner"] == "owner instance is alive"
    assert kept["aura-run-other-home"] == "belongs to another AURA home"
    assert "cannot be established" in kept["aura-run-no-lock-file"]
    assert "alive" in kept["aura-run-legacy-live"]
    assert "readable owner" in kept["aura-run-legacy-unreadable"]
    assert kept["someone-elses-container"] == "not an AURA run container"


def test_a_process_without_a_verified_lock_touches_nothing(tmp_path):
    me = instance.acquire(tmp_path)
    me.verified = False
    called = []
    report = reap_orphans(tmp_path, me, docker_list=lambda: called.append(1) or [],
                          docker_remove=lambda n: called.append(n))
    assert called == [] and "nothing was touched" in report["skipped"]


def test_a8_docker_unavailable_defers_and_reports(tmp_path):
    me = instance.acquire(tmp_path)
    dead_iid = _free_instance(tmp_path)
    report = reap_orphans(tmp_path, me, docker_list=lambda: None,
                          docker_remove=lambda n: pytest.fail("nothing to remove"))
    assert report["deferred"] and "Docker could not be queried" in report["deferred"][0]
    assert dead_iid not in report["cleanedInstances"], "locks are kept while containers are unknown"


# ── A7: host workers (registry + real processes) ──────────────────────────────

def test_a7_orphan_host_worker_of_a_dead_instance_is_terminated(tmp_path):
    me = instance.acquire(tmp_path)
    dead_iid = _free_instance(tmp_path)
    worker = _sleeper()
    try:
        eid = registry.register(tmp_path, dead_iid, worker.pid, binary="claude")
        if registry.entries(tmp_path)[0]["startIdentity"] is None:
            pytest.skip(f"start identity unsupported on {sys.platform}")
        report = reap_orphans(tmp_path, me, containers=False)
        worker.wait(15)
        assert [w["entry"] for w in report["terminatedWorkers"]] == [eid]
        assert pid_state(worker.pid) == DEAD
        assert registry.entries(tmp_path) == []
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait(15)


def test_a7_a_reused_pid_decoy_is_never_signalled(tmp_path):
    me = instance.acquire(tmp_path)
    dead_iid = _free_instance(tmp_path)
    decoy = _sleeper()
    try:
        eid = registry.register(tmp_path, dead_iid, decoy.pid, binary="claude")
        if registry.entries(tmp_path)[0]["startIdentity"] is None:
            pytest.skip(f"start identity unsupported on {sys.platform}")
        # The recorded process is a different one that happened to have this pid.
        f = registry.workers_dir(tmp_path) / f"{eid}.json"
        rec = json.loads(f.read_text())
        rec["startIdentity"] = rec["startIdentity"] + "-an-earlier-process"
        f.write_text(json.dumps(rec))
        report = reap_orphans(tmp_path, me, containers=False,
                              terminate=lambda *a: pytest.fail("a decoy was signalled"))
        assert pid_state(decoy.pid) == ALIVE
        assert report["droppedEntries"][0]["reason"].startswith("pid now belongs to a different process")
        assert registry.entries(tmp_path) == []
    finally:
        decoy.kill()
        decoy.wait(15)


def test_a4_a_live_instances_host_worker_is_never_touched(tmp_path):
    me = instance.acquire(tmp_path)
    live, live_iid, live_pid = _holder(tmp_path)
    worker = _sleeper()
    try:
        registry.register(tmp_path, live_iid, worker.pid, binary="claude")
        report = reap_orphans(tmp_path, me, containers=False,
                              terminate=lambda *a: pytest.fail("another live instance's worker was signalled"))
        assert report["keptWorkers"][0]["reason"] == "owner instance is alive"
        assert pid_state(worker.pid) == ALIVE
        assert len(registry.entries(tmp_path)) == 1
    finally:
        worker.kill()
        worker.wait(15)
        _stop(live, live_pid)


def test_ambiguous_host_workers_are_kept(tmp_path):
    me = instance.acquire(tmp_path)
    dead_iid = _free_instance(tmp_path)
    worker = _sleeper()
    try:
        d = registry.workers_dir(tmp_path)
        d.mkdir(parents=True, exist_ok=True)
        (d / "noident.json").write_text(json.dumps({"id": "noident", "instance": dead_iid,
                                                     "pid": worker.pid, "startIdentity": None}))
        (d / "garbage.json").write_text("{not json")
        (d / "lockless.json").write_text(json.dumps({"id": "lockless", "instance": "b" * 32,
                                                     "pid": worker.pid, "startIdentity": "x"}))
        report = reap_orphans(tmp_path, me, containers=False,
                              terminate=lambda *a: pytest.fail("an ambiguous worker was signalled"))
        reasons = {w["entry"]: w["reason"] for w in report["keptWorkers"]}
        assert reasons["noident"] == "process state or identity unknown"
        assert reasons["garbage"] == "unreadable registry entry"
        assert "cannot be established" in reasons["lockless"]
        assert pid_state(worker.pid) == ALIVE
    finally:
        worker.kill()
        worker.wait(15)


def _age(home: Path, iid: str, seconds: float = 600) -> None:
    lock = instance.instances_dir(home) / f"{iid}.lock"
    t = time.time() - seconds
    os.utime(lock, (t, t))


def test_dead_instance_locks_are_cleaned_only_when_nothing_refers_to_them(tmp_path):
    me = instance.acquire(tmp_path)
    dead_a, dead_b = _free_instance(tmp_path), _free_instance(tmp_path)
    _age(tmp_path, dead_a)
    _age(tmp_path, dead_b)
    tag = home_tag(tmp_path)
    rows = [_row("aura-run-still-there", dead_b, tag)]
    report = reap_orphans(tmp_path, me, docker_list=lambda: rows, docker_remove=lambda n: False)
    assert report["cleanedInstances"] == [dead_a]
    assert instance_state(tmp_path, dead_a) == ABSENT
    assert instance_state(tmp_path, dead_b) == FREE
    assert instance_state(tmp_path, me.id) == HELD


def test_a_starting_instances_not_yet_locked_file_is_never_deleted(tmp_path):
    """Simultaneous start-up: an instance creates its lock file and locks it a
    moment later. In that gap the file probes "free"; a concurrent cleanup
    must not delete it (it would orphan the newcomer's ownership)."""
    me = instance.acquire(tmp_path)
    d = instance.instances_dir(tmp_path)
    newcomer = "c" * 32
    (d / f"{newcomer}.lock").write_bytes(b"\0")  # created, not yet locked: probes FREE
    assert instance_state(tmp_path, newcomer) == FREE
    report = reap_orphans(tmp_path, me, docker_list=lambda: [], docker_remove=lambda n: False)
    assert newcomer not in report["cleanedInstances"]
    assert (d / f"{newcomer}.lock").exists()


def test_simultaneous_startup_instances_each_hold_their_own_lock(tmp_path):
    """Two instances starting at the same moment get distinct ids and both hold
    their locks; each sees the other as alive and neither cleans the other."""
    holders = [_holder(tmp_path) for _ in range(2)]  # started back to back
    try:
        ids = [h[1] for h in holders]
        assert len(set(ids)) == 2
        assert all(instance_state(tmp_path, i) == HELD for i in ids)
        me = instance.acquire(tmp_path)
        report = reap_orphans(tmp_path, me, docker_list=lambda: [], docker_remove=lambda n: False)
        assert report["cleanedInstances"] == []
        assert all(instance_state(tmp_path, i) == HELD for i in ids)
    finally:
        for p, _iid, pid in holders:
            _stop(p, pid)

# ── run_agent registers host workers while they run ───────────────────────────

def test_run_agent_registers_a_host_worker_only_while_it_runs(tmp_path, monkeypatch):
    from aura import exec_

    monkeypatch.setenv("AURA_HOME", str(tmp_path))
    monkeypatch.setattr(exec_, "resolve_agent_binary",
                        lambda b: exec_.Resolved(True, sys.executable))
    probe = ("import os, sys; d = os.path.join(sys.argv[1], 'run', 'workers'); "
             "print(len([f for f in os.listdir(d) if f.endswith('.json')]))")
    out = asyncio.run(exec_.run_agent("python", ["-c", probe, str(tmp_path)], str(tmp_path), 30_000))
    assert out.out.strip().splitlines()[-1] == "1", "the running worker was registered"
    assert registry.entries(tmp_path) == [], "and unregistered when it ended"
    entries_seen = instance.current()
    assert entries_seen is not None and entries_seen.verified


# ── Linux pidfd: the final check-to-signal gap for the worker itself ──────────

linux_pidfd = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="pidfd is Linux-only")


@linux_pidfd
def test_a_pidfd_can_never_signal_a_process_after_it_is_gone():
    """The property that removes the pid-reuse gap: a pidfd names ONE process;
    once it has exited and been reaped, signalling through it fails instead of
    reaching whatever process gets that pid next."""
    from aura.lifecycle.procident import pidfd_open, pidfd_send_signal

    child = _sleeper()
    fd = pidfd_open(child.pid)
    if fd is None:
        pytest.skip("pidfd unavailable on this kernel")
    try:
        child.kill()
        child.wait(15)
        with pytest.raises(ProcessLookupError):
            pidfd_send_signal(fd, signal.SIGTERM)
    finally:
        os.close(fd)


@linux_pidfd
def test_terminate_binds_the_pidfd_before_verifying_identity(monkeypatch):
    from aura.lifecycle import reaper

    child = _sleeper()
    try:
        real = start_identity(child.pid)
        order = []
        real_open = reaper.pidfd_open
        monkeypatch.setattr(reaper, "pidfd_open", lambda pid: order.append("open") or real_open(pid))
        monkeypatch.setattr(reaper, "start_identity", lambda pid: order.append("identity") or real + "-not-it")
        assert reaper._terminate_tree(child.pid, child.pid, real) == "identity-changed"
        assert order[:2] == ["open", "identity"], "identity must be checked after the pidfd is bound"
        assert pid_state(child.pid) == ALIVE, "a mismatching process was signalled"
    finally:
        child.kill()
        child.wait(15)


@linux_pidfd
def test_terminate_stops_the_leader_and_its_group_through_the_pidfd(tmp_path):
    from aura.lifecycle import reaper

    marker = tmp_path / "grandchild.pid"
    leader = subprocess.Popen([sys.executable, "-c",
                               "import subprocess, sys, time\n"
                               "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\n"
                               f"open({str(marker)!r}, 'w').write(str(g.pid))\n"
                               "time.sleep(300)\n"], start_new_session=True)
    try:
        end = time.monotonic() + 30
        while not marker.exists() or not marker.read_text():
            assert time.monotonic() < end
            time.sleep(0.05)
        grandchild = int(marker.read_text())
        assert reaper._terminate_tree(leader.pid, leader.pid, start_identity(leader.pid)) == "terminated"
        leader.wait(15)
        end = time.monotonic() + 10
        while pid_state(grandchild) != DEAD and time.monotonic() < end:
            time.sleep(0.1)
        assert pid_state(grandchild) == DEAD, "the worker's child survived"
    finally:
        if leader.poll() is None:
            os.killpg(leader.pid, signal.SIGKILL)
            leader.wait(15)


def test_without_a_pidfd_the_fallback_still_verifies_and_terminates(monkeypatch):
    from aura.lifecycle import reaper

    monkeypatch.setattr(reaper, "pidfd_open", lambda pid: None)
    child = _sleeper()
    try:
        ident = start_identity(child.pid)
        if ident is None:
            pytest.skip(f"start identity unsupported on {sys.platform}")
        assert reaper._terminate_tree(child.pid, None, ident + "-not-it") == "identity-changed"
        assert pid_state(child.pid) == ALIVE
        assert reaper._terminate_tree(child.pid, None, ident) == "terminated"
        child.wait(15)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(15)
