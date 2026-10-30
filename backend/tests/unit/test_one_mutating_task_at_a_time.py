"""One coding worker edits a project at a time.

Two layers, both pinned here: the scheduler never puts a project-mutating
task (a coding worker, an AURA file write, a commit, a command) in the same
wave as another one, and a per-project lease serializes workers across
SEPARATE sessions. Read-only work still runs side by side, and different
projects never wait for each other.
"""

from __future__ import annotations

import sys
import threading
import time
from types import SimpleNamespace

import pytest

from aura.central_agent.execution import ExecutionController, mutates_project
from aura.central_agent.worker_lease import LEASES, LeaseCancelled, ProjectWorkerLeases
from aura.contracts.agent import AgentIntent, TaskOutcome, TaskPlan, TaskSpecification

WORK = 0.25


def task(tid, cap, depends=()):
    return TaskSpecification(id=tid, description=tid, capabilityId=cap, dependsOn=list(depends))


def plan(tasks):
    return TaskPlan(planId="plan-x", sessionId="agt-aaaaaaaaaaaa",
                    intent=AgentIntent(goal="g", expectedOutcome="e"),
                    tasks=tasks, createdAt="2026-10-20T00:00:00Z")


@pytest.fixture()
def spans(monkeypatch):
    seen: dict[str, tuple[float, float]] = {}
    lock = threading.Lock()

    def fake(self, task, project_id, compiled_workflow, result, approval_id=None,
             project_cwd=None, cancel_token=None, correlation=None):
        start = time.monotonic()
        time.sleep(WORK)
        with lock:
            seen[task.id] = (start, time.monotonic())
        result.outcomes.append(TaskOutcome(taskId=task.id, state="done", performed=True,
                                           verified=True, detail="ok"))

    monkeypatch.setattr(ExecutionController, "_invoke_single", fake)
    return seen


def run(tasks):
    ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace()).execute(
        plan(tasks), project_id=None)


def overlap(spans, a, b):
    return min(spans[a][1], spans[b][1]) - max(spans[a][0], spans[b][0])


@pytest.mark.parametrize("a, b", [
    ("agent.delegate", "agent.delegate"),
    ("agent.delegate", "filesystem.write"),
    ("filesystem.write", "filesystem.write"),
    ("agent.delegate", "terminal.execute"),
    ("git.commit", "agent.delegate"),
])
def test_mutating_tasks_never_overlap(spans, a, b):
    run([task("t1", a), task("t2", b)])
    assert set(spans) == {"t1", "t2"}
    assert overlap(spans, "t1", "t2") <= 0


def test_a_worker_and_read_only_work_still_share_a_wave(spans):
    run([task("w", "agent.delegate"), task("r", "git.status")])
    assert overlap(spans, "w", "r") > WORK / 2


def test_read_only_tasks_still_run_in_parallel(spans):
    run([task("r1", "git.status"), task("r2", "knowledge.search"), task("r3", "filesystem.read")])
    assert overlap(spans, "r1", "r2") > WORK / 2 and overlap(spans, "r2", "r3") > WORK / 2


def test_a_dependency_plan_with_two_workers_is_still_one_at_a_time(spans):
    run([task("a", "agent.delegate"), task("b", "agent.delegate"),
         task("c", "agent.delegate", depends=["a", "b"])])
    ordered = sorted(spans.values())
    assert all(later[0] >= earlier[1] for earlier, later in zip(ordered, ordered[1:]))


def test_which_capabilities_mutate():
    assert mutates_project(task("x", "agent.delegate")) and mutates_project(task("x", "filesystem.write"))
    assert not mutates_project(task("x", "git.status")) and not mutates_project(task("x", "web.research"))


# ── the lease: separate sessions on the same project ─────────────────────

def test_a_second_session_waits_for_the_first_workers_lease():
    leases = ProjectWorkerLeases()
    first = leases.acquire("/p", session_id="s1", task_id="t1", worker="claude-code")
    waited: list[dict] = []
    got: list[float] = []

    def second():
        t0 = time.monotonic()
        lease = leases.acquire("/p", session_id="s2", task_id="t9", worker="kilo-code",
                               on_wait=lambda h: waited.append(h.as_dict()))
        got.append(time.monotonic() - t0)
        leases.release(lease)

    th = threading.Thread(target=second)
    th.start()
    time.sleep(0.4)
    assert th.is_alive() and not got  # still waiting: the first worker holds the project
    assert waited and waited[0]["taskId"] == "t1" and waited[0]["sessionId"] == "s1"
    leases.release(first)
    th.join(2)
    assert got and got[0] >= 0.35 and leases.holder("/p") is None


def test_different_projects_never_wait_for_each_other():
    leases = ProjectWorkerLeases()
    a = leases.acquire("/a", session_id="s1", task_id="t1")
    t0 = time.monotonic()
    b = leases.acquire("/b", session_id="s2", task_id="t2")
    assert time.monotonic() - t0 < 0.1
    leases.release(a), leases.release(b)


def test_stopping_a_queued_worker_ends_its_wait_without_starting_it():
    leases = ProjectWorkerLeases()
    holder = leases.acquire("/p", session_id="s1", task_id="t1")
    stop = threading.Event()
    result: list[object] = []

    def waiter():
        try:
            leases.acquire("/p", session_id="s2", task_id="t2", cancelled=stop.is_set)
            result.append("acquired")
        except LeaseCancelled as exc:
            result.append(exc)

    th = threading.Thread(target=waiter)
    th.start()
    time.sleep(0.3)
    stop.set()
    th.join(2)
    assert len(result) == 1 and isinstance(result[0], LeaseCancelled)
    assert leases.holder("/p")["taskId"] == "t1"  # the holder was never disturbed
    leases.release(holder)


def test_a_lease_is_released_even_if_the_worker_blows_up(monkeypatch, tmp_path):
    """The invoke site releases in a finally: a crashing worker cannot leave a
    project stuck waiting for a lease nobody holds."""
    from aura.central_agent import execution as ex

    def boom(*_a, **_k):
        raise RuntimeError("worker process exploded")

    monkeypatch.setattr(ex, "invoke_fabric", boom)
    ctrl = ExecutionController(fabric_cfg=SimpleNamespace(), engine=SimpleNamespace())
    ctrl._match_role = lambda *a, **k: None  # no registry in this unit test
    result = ex.ExecutionOutcome()
    t = task("w", "agent.delegate")
    t.input = {"task": "x"}
    with pytest.raises(Exception):
        ctrl._invoke_single(t, "p", None, result, project_cwd="/lease-crash-proj",
                            correlation={"session_id": "agt-aaaaaaaaaaaa"})
    assert LEASES.holder("/lease-crash-proj") is None
