"""AutomationScheduler — port of automation/src/scheduler.ts semantics.

CLOCK → SCHEDULER → AutomationEvent → AutomationEngine → WorkflowRunner.
The scheduler never executes workflows and can NEVER grant approvals.
Cron: 5-field, comma lists, ranges a-b, steps /n, * — matching schedule.ts
parseField. Missed fires are COUNTED, never executed.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Callable
import json

RANGES = {"minute": (0, 59), "hour": (0, 23), "dayOfMonth": (1, 31),
          "month": (1, 12), "dayOfWeek": (0, 7)}
FIELD_ORDER = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"]


def _named(token: str, kind: str):
    if kind == "month" and token.isalpha():
        names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        try:
            return names.index(token[:3].lower()) + 1
        except ValueError:
            return token
    if kind == "dayOfWeek" and token.isalpha():
        names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        try:
            return names.index(token[:3].lower())
        except ValueError:
            return token
    return token


def parse_cron(expr: str):
    """→ {'ok':True,'cron':{field:set}} | {'ok':False,'error':str}."""
    parts = (expr or "").split()
    if len(parts) != 5:
        return {"ok": False, "error": "a cron expression needs exactly 5 fields"}
    out: dict[str, set] = {}
    for raw, kind in zip(parts, FIELD_ORDER):
        mn, mx = RANGES[kind]
        values: set = set()
        for part in raw.split(","):
            token = part.strip()
            if not token:
                return {"ok": False, "error": f'"{raw}" has an empty entry'}
            range_part, _, step_part = token.partition("/")
            step = 1
            if step_part:
                if not step_part.isdigit() or int(step_part) < 1:
                    return {"ok": False, "error": f'"{token}" has an invalid step'}
                step = int(step_part)
            if range_part == "*":
                lo, hi = mn, mx
            elif "-" in range_part:
                bits = range_part.split("-")
                if len(bits) != 2:
                    return {"ok": False, "error": f'"{token}" is not a valid range'}
                a, b = _named(bits[0].strip(), kind), _named(bits[1].strip(), kind)
                if not str(a).lstrip("-").isdigit() or not str(b).lstrip("-").isdigit():
                    return {"ok": False, "error": f'"{token}" is not a valid range'}
                lo, hi = int(a), int(b)
            else:
                v = _named(range_part.strip(), kind)
                if not str(v).lstrip("-").isdigit():
                    return {"ok": False, "error": f'"{token}" is not a number'}
                lo = hi = int(v)
            if lo < mn or hi > mx or lo > hi:
                return {"ok": False, "error": f'"{token}" is outside {mn}-{mx} for {kind}'}
            v2 = lo
            while v2 <= hi:
                values.add(0 if (kind == "dayOfWeek" and v2 == 7) else v2)
                v2 += step
        out[kind] = values
    return {"ok": True, "cron": out}


def next_after(cron: dict, after: datetime):
    """Smallest instant > `after` (local time) matching the fields."""
    m_set, h_set = cron["minute"], cron["hour"]
    dom_set, mon_set, dow_set = cron["dayOfMonth"], cron["month"], cron["dayOfWeek"]
    # DOM/DOW restriction: TS/POSIX — if both restricted, OR applies.
    dom_restricted = cron["dayOfMonth"] != set(range(1, 32))
    dow_restricted = cron["dayOfWeek"] != set(range(8))

    cur = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(366 * 24 * 60):  # bounded: one year of minutes
        if cur.month not in mon_set:
            cur = (cur.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
            continue
        ok_dom = cur.day in dom_set
        ok_dow = cur.weekday() % 7 in dow_set or (cur.weekday() + 1) % 7 in dow_set
        if dom_restricted and dow_restricted:
            day_ok = ok_dom or ((cur.weekday() + 1) % 7) in dow_set
        elif dom_restricted:
            day_ok = ok_dom
        elif dow_restricted:
            day_ok = (cur.weekday() + 1) % 7 in dow_set or cur.weekday() in dow_set
        else:
            day_ok = True
        if not day_ok:
            cur = (cur + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if cur.minute in m_set and cur.hour in h_set:
            return cur
        cur += timedelta(minutes=1)
    return None


class AutomationScheduler:
    """Reconcile-then-arm; tick fires due schedules as AutomationEvents."""

    TICK_MS = 30_000

    def __init__(self, store, persistence, project_path, engine,
                 now: Callable[[], datetime] | None = None) -> None:
        self.store = store
        if isinstance(persistence, dict):
            self.persistence = persistence
        else:
            self.persistence = {"load": persistence.load, "save": persistence.save}          # load()/save() of state dict
        self.project_path = project_path        # callable projectId → path
        self.engine = engine
        self.now = now or datetime.now
        self.state: dict = dict(self.persistence["load"]())

    def status(self):
        return json.loads(json.dumps(self.state))

    def scheduled_rules(self):
        out = []
        for s in self.store.list_rules():
            r = self.store.get_rule(s["id"])
            if r and r["trigger"]["type"] == "schedule":
                out.append(r)
        return out

    def reconcile(self):
        now = self.now()
        scheduled = missed = 0
        nxt: dict[str, dict] = {}
        for rule in self.scheduled_rules():
            prior = self.state.get(rule["id"], {"missedCount": 0})
            parsed = parse_cron(rule["trigger"].get("cron") or "")
            if not parsed["ok"]:
                nxt[rule["id"]] = {**prior, "nextFireAt": None, "error": parsed["error"]}
                continue
            missed_for = 0
            if rule["enabled"] and prior.get("lastFiredAt"):
                cursor = next_after(parsed["cron"], datetime.fromisoformat(prior["lastFiredAt"]))
                guard = 0
                while cursor and cursor <= now and missed_for < 1000 and guard < 2000:
                    missed_for += 1; guard += 1
                    cursor = next_after(parsed["cron"], cursor)
            upcoming = next_after(parsed["cron"], now)
            nxt[rule["id"]] = {
                "lastFiredAt": prior.get("lastFiredAt"),
                "nextFireAt": upcoming.isoformat() if upcoming else None,
                "missedCount": prior.get("missedCount", 0) + missed_for,
                "lastMissedAt": now.isoformat() if missed_for else prior.get("lastMissedAt"),
                "error": None,
            }
            missed += missed_for
            if rule["enabled"] and upcoming:
                scheduled += 1
        self.state = nxt
        self.persistence["save"](self.state)
        return {"scheduled": scheduled, "missed": missed}

    async def tick(self):
        now = self.now()
        fired: list[str] = []
        for rule in self.scheduled_rules():
            if not rule["enabled"]:
                continue
            st = self.state.get(rule["id"]) or {}
            nf = st.get("nextFireAt")
            if not nf or st.get("error"):
                continue
            if datetime.fromisoformat(nf) > now:
                continue
            project_id = rule["trigger"].get("projectId")
            if not project_id:
                self.state[rule["id"]] = {**st, "error": "This schedule has no project. Set one on the rule.", "nextFireAt": None}
                continue
            try:
                ppath = self.project_path(project_id)
            except Exception:
                self.state[rule["id"]] = {**st, "error": f"The project this schedule targets ({project_id}) no longer exists.", "nextFireAt": None}
                continue
            event = {"type": "schedule", "projectId": project_id, "projectPath": ppath,
                     "at": now.isoformat(),
                     "payload": {"cron": rule["trigger"].get("cron"), "ruleId": rule["id"],
                                 "firedAt": now.isoformat()}}
            self.engine.handle_event(event)
            fired.append(rule["id"])
            parsed = parse_cron(rule["trigger"].get("cron") or "")
            upcoming = next_after(parsed["cron"], now) if parsed["ok"] else None
            self.state[rule["id"]] = {
                "lastFiredAt": now.isoformat(),
                "nextFireAt": upcoming.isoformat() if upcoming else None,
                "missedCount": st.get("missedCount", 0),
                "lastMissedAt": st.get("lastMissedAt"),
            }
        if fired:
            self.persistence["save"](self.state)
        return fired
