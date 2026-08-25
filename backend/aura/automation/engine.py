"""AutomationEngine — port of automation/src/engine.ts (492 lines).

Automation decides WHEN. It never executes workflows directly: the
`run-workflow` action handler (injected by the host) calls
WorkflowRunner.start_workflow_run — the ONE canonical path — and carries
NO approvedCapabilities, so scheduled/event runs park exactly like manual
ones when policy demands a human.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from ..persistence.automation import AutomationStore

ACTION_RUN_STATUSES = ("pending", "running", "retrying", "completed", "failed", "skipped")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _js(v: Any) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def get_path(payload: dict, path: str):
    if not path:
        return payload
    cur: Any = payload
    for part in path.split("."):
        if cur is None or not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def partial_match(actual: Any, expected: Any) -> bool:
    if expected is None or not isinstance(expected, dict) or isinstance(expected, list):
        return _js(actual) == _js(expected)
    if actual is None or not isinstance(actual, dict) or isinstance(actual, list):
        return False
    return all(partial_match(actual.get(k), v) for k, v in expected.items())


def coerce_number(v: Any):
    from aura.persistence._common import js_random_base36  # noqa: F401 (parity imports kept minimal)

    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str) and v.strip():
        try:
            return float(v) if "." in v else int(v)
        except ValueError:
            return None
    return None


def evaluate_condition(payload: dict, cond: dict) -> bool:
    got = get_path(payload, cond.get("field") or "")
    op = cond.get("op")
    val = cond.get("value")
    if op == "equals":
        return _js(got) == _js(val)
    if op == "not-equals":
        return _js(got) != _js(val)
    if op == "exists":
        return got is not None
    if op == "not-exists":
        return got is None
    if op == "contains":
        if isinstance(got, str):
            return str(val if val is not None else "") in got
        if isinstance(got, list):
            return any(_js(x) == _js(val) for x in got)
        return False
    if op == "not-contains":
        if isinstance(got, str):
            return str(val if val is not None else "") not in got
        if isinstance(got, list):
            return not any(_js(x) == _js(val) for x in got)
        return True
    if op == "in":
        return isinstance(val, list) and any(_js(x) == _js(got) for x in val)
    if op == "matches-regex":
        if not isinstance(got, str):
            return False
        try:
            return re.search(str(val or ""), got) is not None
        except re.error:
            return False
    if op in ("gt", "gte", "lt", "lte"):
        a, b = coerce_number(got), coerce_number(val)
        if a is None or b is None:
            return False
        return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[op]
    return False


def evaluate_conditions(payload: dict, conditions: list[dict]) -> list[dict]:
    out = []
    for i, c in enumerate(conditions):
        passed = evaluate_condition(payload, c)
        out.append({"index": i, "field": c.get("field"), "op": c.get("op"), "passed": passed,
                    **({} if passed else {"note": f'condition failed on "{c.get("field")}"'})})
    return out


def retry_delay(policy: dict, attempt: int) -> int:
    return round(policy["delayMs"] * (policy["backoffFactor"] ** max(0, attempt - 1)))


def merge_config(payload: dict, config: dict) -> dict:
    out = {}
    for k, v in config.items():
        if isinstance(v, str):
            out[k] = re.sub(r"\{\{\s*payload\.([\w.]+)\s*\}\}",
                            lambda m: str(get_path(payload, m.group(1)) or ""), v)
        else:
            out[k] = v
    return out


class AutomationEngine:
    def __init__(self, store: AutomationStore, actions: dict[str, Callable],
                 emit: Callable | None = None,
                 sleep: Callable[[float], Any] | None = None,
                 clock_iso: Callable[[], str] = _now_iso,
                 clock_ms: Callable[[], int] | None = None,
                 id_gen: Callable[[str], str] | None = None) -> None:
        self.store = store
        self.actions = actions
        self.emit = emit
        self._sleep = sleep or (lambda ms: asyncio_sleep(ms / 1000))
        self._iso = clock_iso
        self._ms = clock_ms or (lambda: int(datetime.now(UTC).timestamp() * 1000))
        # TS genId('t') consumes Date.now + Math.random per timeline entry;
        # the deterministic differential requires identical draw counts.
        self._id_gen = id_gen or (lambda p: f"{p}-{len(p)}")
        self.running: set[str] = set()
        self.live_runs: dict[str, dict] = {}

    # matching ---------------------------------------------------------------

    def trigger_matches(self, rule: dict, event: dict) -> bool:
        if not isinstance(rule, dict):
            return False
        trig = rule.get("trigger") or {}
        if trig.get("type") != event.get("type"):
            return False
        m = trig.get("match")
        if m:
            payload = event.get("payload") or {}
            for k, v in m.items():
                if not partial_match(get_path(payload, k), v):
                    return False
        return True

    def rule_matches(self, rule: dict, event: dict):
        if not self.trigger_matches(rule, event):
            return False, []
        conds = rule.get("conditions") or []
        if not conds:
            return True, []
        evals = evaluate_conditions(event.get("payload") or {}, conds)
        return all(c["passed"] for c in evals), evals

    # public API -------------------------------------------------------------

    def handle_event(self, event: dict):
        created = None
        summaries = self.store.list_rules()
        for s in summaries:
            rule = self.store.get_rule(s["id"])
            if not rule or not rule.get("enabled"):
                continue
            matched, conds = self.rule_matches(rule, event)
            if not matched:
                continue
            run = self.store.create_run(rule, event)
            run["conditions"] = conds
            run["timeline"].append({
                "id": self._id_gen("t"), "at": self._iso(),
                "type": "condition-check",
                "message": f"{sum(1 for c in conds if c['passed'])}/{len(conds)} conditions passed",
                "level": "info"})
            run["status"] = "queued"
            self.store.save_run(run)
            if self.emit:
                self.emit({"type": "run", "run": run})
            if created is None:
                created = run
            self._spawn_pump(rule)
        return created

    async def run_rule_now(self, rule_id: str, event: dict):
        rule = self.store.get_rule(rule_id)
        if not rule:
            return None
        matched, conds = self.rule_matches(rule, event)
        if not matched:
            return None
        run = self.store.create_run(rule, event)
        run["conditions"] = conds
        self.store.save_run(run)
        if self.emit:
            self.emit({"type": "run", "run": run})
        await self.execute(run, rule)
        return run

    def active_rules(self) -> int:
        return len(self.running)

    # execution ----------------------------------------------------------------

    def _spawn_pump(self, rule: dict):
        """Fire-and-forget inside a running loop (service path); otherwise
        defer — callers drain via `drain_deferred()` (deterministic tests,
        CLI hosts). Never blocks the caller on unbounded actions."""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            if rule["id"] not in getattr(self, "_deferred_rules", set()):
                self._deferred_rules = getattr(self, "_deferred_rules", set())
                self._deferred_rules.add(rule["id"])
                self._deferred_queue = getattr(self, "_deferred_queue", [])
                self._deferred_queue.append(rule)
            return
        loop.create_task(self.pump(rule))

    async def drain_deferred(self):
        rules = getattr(self, "_deferred_queue", [])
        self._deferred_queue = []
        for r in rules:
            self._deferred_rules.discard(r["id"])
            await self.pump(r)

    async def pump(self, rule: dict):
        if rule["id"] in self.running:
            return
        self.running.add(rule["id"])
        try:
            nxt = self._next_queued(rule["id"])
            while nxt:
                await self.execute(nxt, rule)
                nxt = self._next_queued(rule["id"])
        finally:
            self.running.discard(rule["id"])

    def _next_queued(self, rule_id: str):
        queued = [s for s in self.store.list_runs(rule_id) if s["status"] == "queued"]
        queued.sort(key=lambda s: s["startedAt"])
        return self.store.get_run(rule_id, queued[0]["id"]) if queued else None

    async def execute(self, run: dict, rule: dict):
        controller = {"aborted": False}
        self.live_runs[run["id"]] = {"run": run, "controller": controller}
        try:
            t0 = self._ms()
            run["status"] = "running"
            run["startedAt"] = self._iso()
            self._timeline(run, "started", f'Executing "{rule["name"]}"')
            self.store.save_run(run)
            if self.emit:
                self.emit({"type": "run", "run": run})

            for action in rule.get("chain") or []:
                status = run["status"]
                if status == "cancelled":
                    break
                if status == "paused":
                    self._timeline(run, "paused", f'Paused before "{action["label"]}"')
                    self.store.save_run(run)
                    if self.emit:
                        self.emit({"type": "run", "run": run})
                    break
                state = next((a for a in run["actions"] if a["actionId"] == action["id"]), None)
                if state is None:
                    continue
                ok = await self._action_with_retries(run, state, action, rule, controller)
                if not ok and not action.get("continueOnError"):
                    run["status"] = "failed"
                    run["error"] = state.get("error") or f'action "{action["label"]}" failed'
                    run["finishedAt"] = self._iso()
                    run["ms"] = self._ms() - t0
                    self._timeline(run, "failed", run["error"], "error")
                    self.store.save_run(run)
                    if self.emit:
                        self.emit({"type": "done", "runId": run["id"], "status": "failed", "ms": run["ms"]})
                    return

            after = run["status"]
            if after in ("paused", "cancelled"):
                return
            run["status"] = "completed"
            run["finishedAt"] = self._iso()
            run["ms"] = self._ms() - t0
            self._timeline(run, "completed", f"Completed in {run['ms']}ms")
            self.store.save_run(run)
            if self.emit:
                self.emit({"type": "done", "runId": run["id"], "status": "completed", "ms": run["ms"]})
        finally:
            self.live_runs.pop(run["id"], None)

    async def _action_with_retries(self, run, state, action, rule, controller):
        attempt = 0
        policy = rule["retry"]
        label = action["label"]
        while attempt < policy["maxAttempts"]:
            attempt += 1
            state["attempts"] = attempt
            state["status"] = "running" if attempt == 1 else "retrying"
            state["startedAt"] = self._iso()
            state.pop("error", None)
            run["status"] = state["status"]
            self._timeline(run, "action-retried" if attempt > 1 else "action-started",
                           f"Attempt {attempt}: {label}", "info", state["actionId"])
            self.store.save_run(run)
            if self.emit:
                self.emit({"type": "run", "run": run})

            t = self._ms()
            handler = self.actions.get(state["action"])
            try:
                if handler is None:
                    raise RuntimeError(f'no action handler registered for "{state["action"]}"')
                result = await handler(
                    {"projectId": run["event"]["projectId"],
                     "projectPath": run["event"]["projectPath"],
                     "ruleId": rule["id"], "runId": run["id"], "event": run["event"],
                     "log": lambda level, text, _a=state["actionId"]: self._timeline(run, "log", text, level, _a),
                     "signal": controller},
                    merge_config(run["event"].get("payload") or {}, action.get("config") or {}))
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": str(e)}

            state["ms"] = self._ms() - t
            produced = result.get("produced")
            if produced:
                state["produced"] = produced
                if produced.get("kind") == "workflow-run":
                    state["workflowRunId"] = produced["runId"]
                    state["workflowRunState"] = produced.get("state")
                run["produced"] = [p for p in (run.get("produced") or [])
                                   if not (p.get("kind") == "workflow-run" and p.get("runId") == produced.get("runId"))]
                run["produced"].append(produced)
            if result.get("ok"):
                state["status"] = "completed"
                state["summary"] = result.get("summary")
                state["finishedAt"] = self._iso()
                self._timeline(run, "action-completed",
                               f"{label} ok{(' — ' + result['summary']) if result.get('summary') else ''}",
                               "info", state["actionId"])
                self.store.save_run(run)
                if self.emit:
                    self.emit({"type": "run", "run": run})
                return True

            state["error"] = result.get("error") or "action failed"
            if attempt >= policy["maxAttempts"]:
                state["status"] = "failed"
                state["finishedAt"] = self._iso()
                self._timeline(run, "action-failed",
                               f"{label} failed: {state['error']}", "error", state["actionId"])
                self.store.save_run(run)
                if self.emit:
                    self.emit({"type": "run", "run": run})
                return False

            wait = retry_delay(policy, attempt)
            self._timeline(run, "action-retried",
                           f"{label} failed — retrying in {wait}ms ({attempt}/{policy['maxAttempts']})",
                           "warn", state["actionId"])
            self.store.save_run(run)
            if self.emit:
                self.emit({"type": "run", "run": run})
            await self._sleep(wait)
        return False

    # control -------------------------------------------------------------------

    def pause_rule(self, rule_id: str):
        entry = next((e for e in self.live_runs.values() if e["run"]["ruleId"] == rule_id), None)
        run = entry["run"] if entry and entry["run"]["status"] in ("running", "retrying") else None
        if not run:
            return None
        run["status"] = "paused"
        self._timeline(run, "paused", "Rule paused")
        self.store.save_run(run)
        if self.emit:
            self.emit({"type": "run", "run": run})
        return run

    def resume_rule(self, rule_id: str):
        run = next((r for r in (self.store.get_run(rule_id, s["id"])
                                for s in self.store.list_runs(rule_id))
                    if r and r["status"] == "paused"), None)
        if not run:
            return None
        run["status"] = "running"
        self._timeline(run, "resumed", "Rule resumed")
        self.store.save_run(run)
        if self.emit:
            self.emit({"type": "run", "run": run})
        rule = self.store.get_rule(rule_id)
        if rule:
            self._spawn_pump(rule)
        return run

    def cancel_run(self, rule_id: str, run_id: str):
        live = next((e for e in self.live_runs.values()
                     if e["run"]["ruleId"] == rule_id and (not run_id or e["run"]["id"] == run_id)), None)
        run = (live or {}).get("run") or self.store.get_run(rule_id, run_id)
        if not run or run["status"] in ("completed", "cancelled"):
            return None
        run["status"] = "cancelled"
        run["finishedAt"] = self._iso()
        self._timeline(run, "cancelled", "Run cancelled")
        self.store.save_run(run)
        if self.emit:
            self.emit({"type": "run", "run": run})
            self.emit({"type": "done", "runId": run["id"], "status": "cancelled", "ms": run.get("ms") or 0})
        if live:
            live["controller"]["aborted"] = True
        return run

    # helpers ----------------------------------------------------------------------

    def _timeline(self, run, type_, message, level="info", action_id=None):
        entry = {"id": self._id_gen("t"), "at": self._iso(),
                 "type": type_, "message": message, "level": level}
        if action_id:
            entry["actionId"] = action_id
        run["timeline"].append(entry)


async def asyncio_sleep(seconds: float):
    import asyncio

    await asyncio.sleep(seconds)


def _lookup(obj, path):
    cur: Any = obj
    for part in path.split("."):
        if cur is None or not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur
