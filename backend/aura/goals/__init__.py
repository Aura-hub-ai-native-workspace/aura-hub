"""Goal loop: one goal, worked on until it is met, with no one in the loop.

A goal is a sentence and a project. Each cycle is one ordinary agent session
(plan, build, verify, correct). The loop reads how it ended, writes that down,
and starts the next cycle with the goal and what happened so far, so the next
plan is made against real results. Nothing here asks a person anything.

    achieved      the run completed and its objective was accepted
    improve mode  after that, keep finding and making the next improvement
    waiting       no model, a timeout, a crash or a restart: back off, then retry
    stuck         the same failure three times running: told to change approach
    stopped       only when someone stops it

Every goal is a JSON file under ``<AURA_HOME>/goals``, saved after every
change, so a restart picks up running goals where they were.
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..config import aura_home
from ..jsonutil import write_json_atomic

log = logging.getLogger(__name__)

#: Failures that a later attempt can get past without changing anything:
#: wait, then try again. Anything else goes straight back to planning.
TRANSIENT_FAILURES = frozenset({
    "no-model", "timeout", "orchestration-crashed", "interrupted-by-restart",
    "duplicate-orchestration", "correction-timeout", "planning-failed",
})
#: Words in a run's summary that mean an agent or model is out of capacity.
CAPACITY_WORDS = ("rate limit", "rate-limit", "quota", "429", "too many requests",
                  "overloaded", "insufficient balance", "credits")
SAME_FAILURE_LIMIT = 3
MIN_BACKOFF_S = 60.0
MAX_BACKOFF_S = 3600.0
#: Pause between ordinary cycles, so a loop that fails instantly cannot spin.
CYCLE_GAP_S = 5.0
POLL_S = 5.0
#: Only the most recent cycles go back into the prompt.
HISTORY_IN_PROMPT = 5
#: A goal can run for months. Its file keeps full detail for the latest cycles
#: and running totals for all of them; the session files of older cycles (the
#: loop's own run records) are removed so storage and startup stay bounded.
MAX_CYCLES_KEPT = 200
MAX_SESSIONS_KEPT = 100
MODES = ("until-achieved", "keep-improving")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _settled(session: Any) -> dict | None:
    """The session's final result, or None while it is still running."""
    if session is None:
        return None
    if getattr(session, "orchestrationState", None) == "running":
        return None
    result = getattr(session, "lastResult", None)
    if result is None or getattr(result, "outcome", "started") == "started":
        return None
    return result.model_dump() if hasattr(result, "model_dump") else dict(result)


def failure_kind(cycle: dict) -> str:
    """How the next cycle should treat this one: achieved, wait or replan."""
    if cycle.get("outcome") == "completed" and cycle.get("objectiveAccepted") is not False:
        return "achieved"
    reason = cycle.get("failureReason") or cycle.get("outcome") or ""
    text = f"{cycle.get('summary') or ''} {reason}".lower()
    if reason in TRANSIENT_FAILURES or any(w in text for w in CAPACITY_WORDS):
        return "wait"
    return "replan"


def compose_message(goal: dict) -> str:
    """The next cycle's instruction: the goal, plus what the last cycles did."""
    lines = [f"Goal: {goal['goal']}", "",
             "Work on this goal like a developer with no one to ask: build it, run "
             "the tests, compare the result with the goal, and fix what falls short. "
             "Make reasonable assumptions instead of asking questions."]
    cycles = goal.get("cycles") or []
    achieved_before = bool((goal.get("stats") or {}).get("achieved")) or any(
        c.get("kind") == "achieved" for c in cycles)
    if goal.get("mode") == "keep-improving" and achieved_before:
        lines += ["", "The goal has been met before. Review the project against it, "
                      "pick the next most valuable improvement, make it, and test it."]
    recent = cycles[-HISTORY_IN_PROMPT:]
    if recent:
        lines += ["", "What happened in the last cycles (newest last):"]
        for c in recent:
            why = c.get("failureReason") or ", ".join(c.get("unmetAcceptance") or []) or ""
            summary = (c.get("summary") or "").strip().replace("\n", " ")[:300]
            lines.append(f"- cycle {c['n']}: {c.get('outcome')}"
                         f"{f' ({why})' if why else ''}: {summary}")
    if repeated_failure(goal):
        lines += ["", "The same failure has happened several times in a row. Do not "
                      "repeat that approach: find the cause and try a different one."]
    return "\n".join(lines)


def _stats_from(cycles: list[dict]) -> dict:
    """Totals for a goal written before totals were kept."""
    stats = {"cycles": len(cycles), "achieved": 0, "wait": 0, "replan": 0}
    for c in cycles:
        stats[c.get("kind") or "replan"] = stats.get(c.get("kind") or "replan", 0) + 1
    return stats


def repeated_failure(goal: dict) -> bool:
    tail = (goal.get("cycles") or [])[-SAME_FAILURE_LIMIT:]
    if len(tail) < SAME_FAILURE_LIMIT or any(c.get("kind") == "achieved" for c in tail):
        return False
    keys = {(c.get("outcome"), c.get("failureReason")) for c in tail}
    return len(keys) == 1


class GoalStore:
    """One JSON file per goal. Writes are atomic, so a crash never leaves half a file."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root else aura_home() / "goals"

    def path(self, goal_id: str) -> Path:
        if not goal_id.startswith("goal-") or not goal_id[5:].isalnum():
            raise ValueError("malformed goal id")
        return self.root / f"{goal_id}.json"

    def save(self, goal: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        goal["updatedAt"] = _now()
        write_json_atomic(self.path(goal["goalId"]), goal)

    def load(self, goal_id: str) -> dict | None:
        import json

        try:
            return json.loads(self.path(goal_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def all(self) -> list[dict]:
        import json

        out = []
        for f in sorted(self.root.glob("goal-*.json")) if self.root.exists() else []:
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda g: g.get("createdAt") or "", reverse=True)


class GoalLoop:
    """Runs every active goal in its own thread until it is met or stopped.

    ``submit`` starts one background agent session and returns its id,
    ``load`` reads a session back, and ``cancel`` stops one. They are the
    CentralAgent's own methods in the service, and stand-ins in tests.
    """

    def __init__(self, *, submit: Callable[[str, str], str],
                 load: Callable[[str], Any], cancel: Callable[[str], Any],
                 store: GoalStore | None = None,
                 sleep: Callable[[float], None] = time.sleep,
                 remove_session: Callable[[str], Any] | None = None) -> None:
        self.store = store or GoalStore()
        self._remove_session = remove_session
        self._submit, self._load, self._cancel, self._sleep = submit, load, cancel, sleep
        self._lock = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}
        self._wake: dict[str, threading.Event] = {}

    # ── public API ────────────────────────────────────────────────────
    def create(self, goal: str, project_path: str, mode: str = "until-achieved",
               start: bool = True) -> dict:
        goal = (goal or "").strip()
        if not goal or len(goal) > 4000:
            raise ValueError("goal must be 1 to 4000 characters")
        if mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}")
        if not project_path or not Path(project_path).is_dir():
            raise ValueError("projectPath must be an existing folder")
        for other in self.store.all():
            if other.get("projectPath") == project_path and other.get("state") in ("running", "waiting"):
                raise ValueError(f"{other['goalId']} is already running in this project")
        record = {"goalId": f"goal-{secrets.token_hex(6)}", "goal": goal,
                  "projectPath": project_path, "mode": mode, "state": "running",
                  "createdAt": _now(), "cycles": [],
                  "stats": {"cycles": 0, "achieved": 0, "wait": 0, "replan": 0},
                  "currentSessionId": None,
                  "backoffSeconds": 0, "nextAttemptAt": None, "note": None}
        self.store.save(record)
        if start:
            self._start(record["goalId"])
        return record

    def stop(self, goal_id: str) -> dict | None:
        goal = self.store.load(goal_id)
        if goal is None:
            return None
        goal["state"], goal["note"] = "stopped", "stopped"
        self.store.save(goal)
        if goal.get("currentSessionId"):
            try:
                self._cancel(goal["currentSessionId"])
            except Exception:  # noqa: BLE001 — stopping must not fail on a gone session
                log.warning("could not cancel %s", goal["currentSessionId"])
        self._wake.get(goal_id, threading.Event()).set()
        return goal

    def resume_all(self) -> list[str]:
        """Restart every goal that was running when the service last stopped."""
        started = []
        for goal in self.store.all():
            if goal.get("state") in ("running", "waiting"):
                self._start(goal["goalId"])
                started.append(goal["goalId"])
        return started

    # ── the loop ──────────────────────────────────────────────────────
    def _start(self, goal_id: str) -> None:
        with self._lock:
            alive = self._threads.get(goal_id)
            if alive is not None and alive.is_alive():
                return
            self._wake[goal_id] = threading.Event()
            t = threading.Thread(target=self._run, args=(goal_id,), daemon=True,
                                 name=f"goal-{goal_id}")
            self._threads[goal_id] = t
            t.start()

    def _active(self, goal_id: str) -> dict | None:
        goal = self.store.load(goal_id)
        return goal if goal and goal.get("state") in ("running", "waiting") else None

    def _wait(self, goal_id: str, seconds: float) -> None:
        event = self._wake.get(goal_id)
        if event is not None and self._sleep is time.sleep:
            event.wait(seconds)
        else:
            self._sleep(seconds)

    def _run(self, goal_id: str) -> None:
        while (goal := self._active(goal_id)) is not None:
            try:
                if not self.run_cycle(goal):
                    return
            except Exception as exc:  # noqa: BLE001 — the loop outlives any one bug
                log.exception("goal %s cycle crashed", goal_id)
                goal = self.store.load(goal_id) or goal
                self._record(goal, {"outcome": "failed", "failureReason": "loop-error",
                                    "summary": f"{type(exc).__name__}: {exc}"[:300]})
                self._back_off(goal)

    def run_cycle(self, goal: dict) -> bool:
        """One cycle. Returns False when the goal is finished or stopped."""
        goal_id = goal["goalId"]
        session_id = goal.get("currentSessionId")
        if not session_id:
            session_id = self._submit(compose_message(goal), goal["projectPath"])
            fresh = self._active(goal_id)
            if fresh is None:  # stopped while the session was being started
                self._cancel(session_id)
                return False
            goal = fresh
            goal["currentSessionId"], goal["state"] = session_id, "running"
            goal["cycleStartedAt"] = _now()
            self.store.save(goal)
        result = None
        while result is None:
            if self._active(goal_id) is None:
                return False
            result = _settled(self._load(session_id))
            if result is None:
                self._wait(goal_id, POLL_S)
        goal = self.store.load(goal_id) or goal
        if goal.get("state") not in ("running", "waiting"):
            return False
        cycle = self._record(goal, {
            "sessionId": session_id,
            "outcome": result.get("outcome"),
            "objectiveAccepted": result.get("objectiveAccepted"),
            "unmetAcceptance": list(result.get("unmetAcceptance") or [])[:10],
            "failureReason": result.get("failureReason"),
            "summary": str(result.get("summary") or "")[:1000],
        })
        if cycle["kind"] == "achieved" and goal.get("mode") == "until-achieved":
            goal["state"], goal["note"] = "achieved", f"achieved in cycle {cycle['n']}"
            self.store.save(goal)
            return False
        if cycle["kind"] == "wait":
            self._back_off(goal)
        else:
            goal["backoffSeconds"], goal["nextAttemptAt"] = 0, None
            self.store.save(goal)
            self._wait(goal_id, CYCLE_GAP_S)
        return True

    def _record(self, goal: dict, fields: dict) -> dict:
        cycles = goal.setdefault("cycles", [])
        stats = goal.setdefault("stats", _stats_from(cycles))
        cycle = {"n": stats["cycles"] + 1, "startedAt": goal.get("cycleStartedAt"),
                 "endedAt": _now(), **fields}
        cycle["kind"] = failure_kind(cycle)
        cycles.append(cycle)
        stats["cycles"] += 1
        stats[cycle["kind"]] = stats.get(cycle["kind"], 0) + 1
        self._prune(goal)
        goal["currentSessionId"] = None
        goal["note"] = None
        self.store.save(goal)
        return cycle

    def _prune(self, goal: dict) -> None:
        cycles = goal["cycles"]
        if self._remove_session is not None:
            for old in cycles[:-MAX_SESSIONS_KEPT]:
                if old.get("sessionId") and not old.get("sessionRemoved"):
                    try:
                        self._remove_session(old["sessionId"])
                    except Exception:  # noqa: BLE001 — pruning never stops the goal
                        log.warning("could not remove session %s", old["sessionId"])
                    old["sessionRemoved"] = True
        if len(cycles) > MAX_CYCLES_KEPT:
            del cycles[:-MAX_CYCLES_KEPT]

    def _back_off(self, goal: dict) -> None:
        delay = min(MAX_BACKOFF_S, max(MIN_BACKOFF_S, float(goal.get("backoffSeconds") or 0) * 2))
        goal["backoffSeconds"], goal["state"] = delay, "waiting"
        goal["nextAttemptAt"] = datetime.fromtimestamp(time.time() + delay, UTC).isoformat(
            timespec="seconds").replace("+00:00", "Z")
        goal["note"] = f"waiting {int(delay)} s before the next attempt"
        self.store.save(goal)
        self._wait(goal["goalId"], delay)
        fresh = self.store.load(goal["goalId"])
        if fresh and fresh.get("state") == "waiting":
            fresh["state"] = "running"
            self.store.save(fresh)
