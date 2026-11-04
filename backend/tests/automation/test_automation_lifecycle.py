"""Automation run lifecycle: the first terminal state wins (F-29).

Found while checking the cancel route: `cancel_run` treated only `completed` and
`cancelled` as finished, so a run that had FAILED was rewritten as
"cancelled". The same engine also overwrote the run's status on every retry
attempt (a Stop during a retry wait was silently undone and the run carried
on), let a failure that arrived after a Stop replace "cancelled" with "failed"
and emit a second, contradictory `done` event, and made its check-then-write
across the API thread and the event loop without any lock. The TypeScript
engine (the one the desktop app talks to) has the same flaws and the same fix;
`packages/ai-service/src/automationLifecycle.test.ts` covers it.

Lifecycle contract these tests pin:
  - completed, failed and cancelled are terminal; the FIRST one reached wins and
    the run never changes again;
  - a Stop on a finished run does nothing (nothing is cancelled, nothing is
    rewritten, no event);
  - a Stop on an active run cancels it, and the action that was in flight keeps
    its own outcome on its own state; that outcome cannot change the run;
  - exactly one `done` event per run, and it names the run's final status;
  - the persisted record always agrees with the last event.
"""
from __future__ import annotations

import asyncio
import threading
from datetime import UTC, datetime

import pytest

from aura.automation import AutomationEngine
from aura.persistence.automation import AutomationStore


def _rule(rid="rule-1", *, chain=None, retry=None):
    return {"id": rid, "name": "R", "description": "", "category": "c", "enabled": True,
            "trigger": {"type": "mission-completed", "projectId": "p"}, "conditions": [],
            "chain": chain or [{"id": "a1", "action": "run-workflow", "label": "Run",
                                "config": {"workflowId": "wf-1"}, "continueOnError": False}],
            "retry": retry or {"maxAttempts": 1, "delayMs": 100, "backoffFactor": 2},
            "createdAt": "2026-08-24T09:00:00.000Z", "updatedAt": "2026-08-24T09:00:00.000Z"}


def _ev(**payload):
    return {"type": "mission-completed", "projectId": "p", "projectPath": "/p",
            "at": "2026-08-24T10:00:00.000Z", "payload": payload}


class Harness:
    def __init__(self, tmp_path, monkeypatch, handler, *, retry=None, chain=None, sleep=None):
        monkeypatch.setenv("AURA_HOME", str(tmp_path))
        self.events: list[dict] = []
        self.store = AutomationStore()

        async def default_sleep(ms):
            return None

        self.engine = AutomationEngine(
            self.store, actions={"run-workflow": handler}, emit=self.events.append,
            sleep=sleep or default_sleep,
            clock_iso=lambda: datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        self.rule = self.store.create_rule(_rule(retry=retry, chain=chain))

    def fire(self):
        return self.engine.handle_event(_ev())

    def persisted(self, run):
        return self.store.get_run(self.rule["id"], run["id"])

    def cancel(self, run):
        return self.engine.cancel_run(self.rule["id"], run["id"])

    def dones(self, run):
        return [e for e in self.events if e["type"] == "done" and e["runId"] == run["id"]]

    def last_run_event_status(self, run):
        statuses = [e["run"]["status"] for e in self.events if e["type"] == "run" and e["run"]["id"] == run["id"]]
        return statuses[-1] if statuses else None


async def _in_flight(handler_entered):
    await asyncio.wait_for(handler_entered.wait(), timeout=5)


def _gated(result):
    """A handler that stays in flight until released, then returns `result`."""
    entered, release = asyncio.Event(), asyncio.Event()
    calls: list[int] = []

    async def handler(ctx, cfg):
        calls.append(1)
        entered.set()
        await release.wait()
        return result

    return handler, entered, release, calls


def _settle_task():
    async def settle(engine):
        await asyncio.sleep(0.05)
    return settle


# ── cancellation that is real ──────────────────────────────────────────────

def test_cancelling_an_active_run_cancels_it_once_and_the_late_result_changes_nothing(tmp_path, monkeypatch):
    async def scenario():
        handler, entered, release, _ = _gated({"ok": True, "summary": "late success"})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        cancelled = h.cancel(run)
        assert cancelled is not None and cancelled["status"] == "cancelled"
        release.set()                                  # the action now finishes successfully
        await asyncio.sleep(0.1)
        assert h.persisted(run)["status"] == "cancelled"                 # not "completed"
        assert [d["status"] for d in h.dones(run)] == ["cancelled"]      # one done, and it is the truth
        assert h.last_run_event_status(run) == "cancelled"
        assert h.persisted(run)["actions"][0]["status"] == "completed"   # the action kept its own outcome
        timeline = [t["type"] for t in h.persisted(run)["timeline"]]
        assert timeline.count("cancelled") == 1 and "completed" not in timeline
    asyncio.run(scenario())


# ── a failure is never rewritten as a cancellation ─────────────────────────

def test_a_failed_run_cannot_be_cancelled_afterwards(tmp_path, monkeypatch):
    async def scenario():
        async def boom(ctx, cfg):
            return {"ok": False, "error": "ETIMEDOUT"}
        h = Harness(tmp_path, monkeypatch, boom)
        run = h.fire()
        await asyncio.sleep(0.1)
        assert h.persisted(run)["status"] == "failed"
        before = h.persisted(run)
        assert h.cancel(run) is None                                      # F-29: used to flip it
        after = h.persisted(run)
        assert after == before and after["status"] == "failed" and after["error"] == "ETIMEDOUT"
        assert [d["status"] for d in h.dones(run)] == ["failed"]
        assert "cancelled" not in [t["type"] for t in after["timeline"]]
    asyncio.run(scenario())


def test_a_completed_run_cannot_be_cancelled_afterwards(tmp_path, monkeypatch):
    async def scenario():
        async def fine(ctx, cfg):
            return {"ok": True, "summary": "done"}
        h = Harness(tmp_path, monkeypatch, fine)
        run = h.fire()
        await asyncio.sleep(0.1)
        assert h.persisted(run)["status"] == "completed"
        assert h.cancel(run) is None
        assert h.persisted(run)["status"] == "completed"
        assert [d["status"] for d in h.dones(run)] == ["completed"]
    asyncio.run(scenario())


def test_a_stop_then_a_failure_stays_cancelled_with_one_done_event(tmp_path, monkeypatch):
    """Cancellation racing with failure, Stop first: the cancellation stands."""
    async def scenario():
        handler, entered, release, _ = _gated({"ok": False, "error": "worker crashed"})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        assert h.cancel(run)["status"] == "cancelled"
        release.set()                                                     # the action fails afterwards
        await asyncio.sleep(0.1)
        stored = h.persisted(run)
        assert stored["status"] == "cancelled" and "error" not in stored  # not "failed"
        assert stored["actions"][0]["status"] == "failed"                 # the action's own failure is kept
        assert stored["actions"][0]["error"] == "worker crashed"
        assert [d["status"] for d in h.dones(run)] == ["cancelled"]       # no second, contradictory done
    asyncio.run(scenario())


def test_a_failure_then_a_stop_stays_failed_with_one_done_event(tmp_path, monkeypatch):
    """Cancellation racing with failure, failure first: the failure stands."""
    async def scenario():
        async def boom(ctx, cfg):
            return {"ok": False, "error": "disk full"}
        h = Harness(tmp_path, monkeypatch, boom)
        run = h.fire()
        await asyncio.sleep(0.1)
        assert h.cancel(run) is None
        assert h.persisted(run)["status"] == "failed"
        assert [d["status"] for d in h.dones(run)] == ["failed"]
    asyncio.run(scenario())


def test_a_stop_then_a_completion_stays_cancelled_and_a_completion_then_a_stop_stays_completed(tmp_path, monkeypatch):
    async def scenario():
        handler, entered, release, _ = _gated({"ok": True})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        assert h.cancel(run)["status"] == "cancelled"
        release.set()
        await asyncio.sleep(0.1)
        assert h.persisted(run)["status"] == "cancelled" and [d["status"] for d in h.dones(run)] == ["cancelled"]

        async def fine(ctx, cfg):
            return {"ok": True}
        h2 = Harness(tmp_path / "second", monkeypatch, fine)
        run2 = h2.fire()
        await asyncio.sleep(0.1)
        assert h2.cancel(run2) is None
        assert h2.persisted(run2)["status"] == "completed" and [d["status"] for d in h2.dones(run2)] == ["completed"]
    (tmp_path / "second").mkdir()
    asyncio.run(scenario())


def test_repeated_stops_cancel_once(tmp_path, monkeypatch):
    async def scenario():
        handler, entered, release, _ = _gated({"ok": True})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        first, second, third = h.cancel(run), h.cancel(run), h.cancel(run)
        assert first is not None and second is None and third is None
        release.set()
        await asyncio.sleep(0.1)
        assert len(h.dones(run)) == 1
        assert [t["type"] for t in h.persisted(run)["timeline"]].count("cancelled") == 1
    asyncio.run(scenario())


def test_stopping_an_unknown_run_is_nothing(tmp_path, monkeypatch):
    async def fine(ctx, cfg):
        return {"ok": True}
    h = Harness(tmp_path, monkeypatch, fine)
    assert h.engine.cancel_run(h.rule["id"], "run-nope") is None


# ── retries ────────────────────────────────────────────────────────────────

def test_a_stop_during_a_retry_wait_is_not_undone(tmp_path, monkeypatch):
    """Each retry attempt used to set the run back to "retrying": a Stop during
    the wait was silently undone and the run carried on."""
    async def scenario():
        waiting, wake = asyncio.Event(), asyncio.Event()
        attempts: list[int] = []

        async def failing(ctx, cfg):
            attempts.append(1)
            return {"ok": False, "error": "flaky"}

        async def slow_sleep(ms):
            waiting.set()
            await wake.wait()

        h = Harness(tmp_path, monkeypatch, failing, retry={"maxAttempts": 3, "delayMs": 100, "backoffFactor": 2}, sleep=slow_sleep)
        run = h.fire()
        await asyncio.wait_for(waiting.wait(), timeout=5)               # first attempt failed, retry pending
        assert h.persisted(run)["status"] == "running"                  # active; "retrying" starts with the next attempt
        assert h.cancel(run)["status"] == "cancelled"
        wake.set()
        await asyncio.sleep(0.1)
        assert len(attempts) == 1                                         # no second attempt after the Stop
        assert h.persisted(run)["status"] == "cancelled"                  # not "retrying", not "failed"
        assert [d["status"] for d in h.dones(run)] == ["cancelled"]
    asyncio.run(scenario())


def test_a_retry_does_not_overwrite_a_paused_run(tmp_path, monkeypatch):
    async def scenario():
        seen: list[str] = []
        engine_box: dict = {}
        attempts: list[int] = []

        async def failing(ctx, cfg):
            attempts.append(1)
            seen.append(engine_box["h"].persisted(engine_box["run"])["status"])
            if len(attempts) == 1:
                engine_box["h"].engine.pause_rule(engine_box["h"].rule["id"])
            return {"ok": False, "error": "flaky"}

        h = Harness(tmp_path, monkeypatch, failing, retry={"maxAttempts": 2, "delayMs": 1, "backoffFactor": 1})
        engine_box["h"] = h
        engine_box["run"] = h.fire()
        await asyncio.sleep(0.15)
        # The second attempt ran while the run was paused: its status is still "paused".
        assert seen[0] == "running" and seen[1] == "paused"
    asyncio.run(scenario())


# ── persistence and events agree ───────────────────────────────────────────

@pytest.mark.parametrize("outcome", ["cancel-first", "complete-first", "fail-first"])
def test_the_persisted_record_the_events_and_the_done_event_agree(tmp_path, monkeypatch, outcome):
    async def scenario():
        result = {"ok": False, "error": "x"} if outcome == "fail-first" else {"ok": True}
        handler, entered, release, _ = _gated(result)
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        if outcome == "cancel-first":
            h.cancel(run)
            release.set()
        else:
            release.set()
            await asyncio.sleep(0.1)
            h.cancel(run)
        await asyncio.sleep(0.1)
        final = h.persisted(run)["status"]
        assert final == {"cancel-first": "cancelled", "complete-first": "completed", "fail-first": "failed"}[outcome]
        assert [d["status"] for d in h.dones(run)] == [final]
        assert h.last_run_event_status(run) == final
        terminal_entries = [t["type"] for t in h.persisted(run)["timeline"] if t["type"] in ("completed", "failed", "cancelled")]
        assert terminal_entries == [final]                               # one terminal timeline entry, the true one
    asyncio.run(scenario())


# ── a real cross-thread race ───────────────────────────────────────────────

def test_a_stop_from_another_thread_racing_completion_never_produces_two_outcomes(tmp_path, monkeypatch):
    """cancel_run runs on an API thread while the run executes on the event
    loop. Whatever the interleaving, the run ends in exactly one terminal
    state, emits exactly one done event, and the stored state is that one."""
    async def scenario():
        outcomes = {"cancelled": 0, "completed": 0}
        for i in range(60):
            handler, entered, release, _ = _gated({"ok": True})
            h = Harness(tmp_path / f"r{i}", monkeypatch, handler)
            run = h.fire()
            await _in_flight(entered)
            barrier = threading.Barrier(2)
            result: dict = {}

            def stop():
                barrier.wait()
                result["cancelled"] = h.cancel(run)

            thread = threading.Thread(target=stop)
            thread.start()
            barrier.wait()
            release.set()                                              # completion races the Stop
            await asyncio.get_running_loop().run_in_executor(None, thread.join)
            await asyncio.sleep(0.02)
            final = h.persisted(run)["status"]
            assert final in ("cancelled", "completed"), final
            assert [d["status"] for d in h.dones(run)] == [final], (i, final, h.dones(run))
            assert (result["cancelled"] is not None) == (final == "cancelled")
            outcomes[final] += 1
        assert sum(outcomes.values()) == 60
    for i in range(60):
        (tmp_path / f"r{i}").mkdir()
    asyncio.run(scenario())


# ── what a Stop achieved: the cancellation phase ───────────────────────────
# The run is "cancelled" at once (nothing further starts), but an action that was
# mid-flight keeps running unless it watches the abort signal, and what it did is
# not rolled back. `cancellation.phase` says which: "winding-down" until that action
# returns, then "complete". Mirrors the TypeScript engine's tests.

def test_a_mid_flight_action_means_winding_down_then_complete(tmp_path, monkeypatch):
    async def scenario():
        handler, entered, release, _ = _gated({"ok": True, "summary": "late"})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        r = h.cancel(run)
        assert r["status"] == "cancelled"
        assert r["cancellation"] == {"phase": "winding-down", "actionId": "a1", "label": "Run"}
        assert h.persisted(run)["cancellation"]["phase"] == "winding-down"   # the stored record says residual work exists
        release.set()
        await asyncio.sleep(0.1)
        assert h.persisted(run)["cancellation"] == {"phase": "complete", "actionId": "a1", "label": "Run"}
        assert h.persisted(run)["status"] == "cancelled"
        last = [e for e in h.events if e["type"] == "run" and e["run"]["id"] == run["id"]][-1]
        assert last["run"]["cancellation"]["phase"] == "complete"            # the UI is told when it finished
        assert any("winding down" in t["message"] for t in h.persisted(run)["timeline"])
    asyncio.run(scenario())


def test_a_failing_mid_flight_action_ends_the_phase_and_does_not_fail_the_run(tmp_path, monkeypatch):
    async def scenario():
        handler, entered, release, _ = _gated({"ok": False, "error": "boom"})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        h.cancel(run)
        release.set()
        await asyncio.sleep(0.1)
        assert h.persisted(run)["status"] == "cancelled"
        assert h.persisted(run)["cancellation"]["phase"] == "complete"
    asyncio.run(scenario())


def test_nothing_mid_flight_in_a_retry_wait_is_complete_immediately(tmp_path, monkeypatch):
    async def scenario():
        waiting, wake = asyncio.Event(), asyncio.Event()

        async def failing(ctx, cfg):
            return {"ok": False, "error": "flaky"}

        async def slow_sleep(ms):
            waiting.set()
            await wake.wait()

        h = Harness(tmp_path, monkeypatch, failing, retry={"maxAttempts": 3, "delayMs": 100, "backoffFactor": 2}, sleep=slow_sleep)
        run = h.fire()
        await asyncio.wait_for(waiting.wait(), timeout=5)
        assert h.cancel(run)["cancellation"] == {"phase": "complete"}
        wake.set()
        await asyncio.sleep(0.1)
        assert h.persisted(run)["cancellation"] == {"phase": "complete"}
    asyncio.run(scenario())


def test_repeated_stops_keep_the_phase_and_a_finished_run_never_gains_one(tmp_path, monkeypatch):
    async def scenario():
        handler, entered, release, _ = _gated({"ok": True})
        h = Harness(tmp_path, monkeypatch, handler)
        run = h.fire()
        await _in_flight(entered)
        assert h.cancel(run) is not None and h.cancel(run) is None
        assert h.persisted(run)["cancellation"]["phase"] == "winding-down"
        release.set()
        await asyncio.sleep(0.1)
        assert h.cancel(run) is None
        assert h.persisted(run)["cancellation"]["phase"] == "complete"

        async def ok(ctx, cfg):
            return {"ok": True}
        done = Harness(tmp_path / "second", monkeypatch, ok)
        r2 = done.fire()
        await asyncio.sleep(0.1)
        assert done.cancel(r2) is None
        assert "cancellation" not in done.persisted(r2)
    asyncio.run(scenario())


def test_the_abort_signal_reaches_the_handler_and_a_cooperative_one_stops_early(tmp_path, monkeypatch):
    async def scenario():
        seen: list[bool] = []
        entered = asyncio.Event()

        async def cooperative(ctx, cfg):
            entered.set()
            for _ in range(200):
                if ctx["signal"].get("aborted"):
                    seen.append(True)
                    return {"ok": False, "error": "aborted"}
                await asyncio.sleep(0.01)
            return {"ok": True}

        h = Harness(tmp_path, monkeypatch, cooperative)
        run = h.fire()
        await _in_flight(entered)
        h.cancel(run)
        await asyncio.sleep(0.2)
        assert seen == [True]
        assert h.persisted(run)["cancellation"]["phase"] == "complete"
    asyncio.run(scenario())
