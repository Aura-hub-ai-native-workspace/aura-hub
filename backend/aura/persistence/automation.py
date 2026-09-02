"""AutomationStore — port of packages/automation/src/store.ts (322 lines),
plus the file-backed SchedulePersistence from ai-service/automation.ts:78–84.
Byte-parity including summary field order (index.json depends on it).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file
from ._alias import CamelAlias

MAX_INDEX_ENTRIES = 5000


def _now_default() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def summarize_automation_run(run: dict, rule_name: str | None = None) -> dict:
    """store.ts:76–93 — one place a run becomes a summary."""
    out: dict[str, Any] = {"id": run["id"], "ruleId": run["ruleId"]}
    if rule_name is not None:
        out["ruleName"] = rule_name
    out["trigger"] = run["event"]["type"]
    out["status"] = run["status"]
    out["projectId"] = run["event"]["projectId"]
    out["actionCount"] = len(run.get("actions") or [])
    out["startedAt"] = run["startedAt"]
    if run.get("finishedAt") is not None:
        out["finishedAt"] = run["finishedAt"]
    if run.get("ms") is not None:
        out["ms"] = run["ms"]
    if run.get("error") is not None:
        out["error"] = run["error"]
    produced = run.get("produced")
    if produced is None:
        produced = [a.get("produced") for a in run.get("actions") or []]
        produced = [p for p in produced if p]
    if True:
        out["produced"] = produced
    return out


def _default_id_gen(prefix: str) -> str:
    """TS-parity uniqueness when no injection: now36 + 6 rand chars."""
    import secrets
    now_ms = int(datetime.now(UTC).timestamp() * 1000)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    n = now_ms
    b36 = ""
    while n:
        n, r = divmod(n, 36)
        b36 = digits[r] + b36
    return f"{prefix}-{b36}-{secrets.token_hex(3)}"


class AutomationStore(CamelAlias):
    def __init__(self, clock: Callable[[], str] | None = None,
                 id_gen: Callable[[str], str] | None = None) -> None:
        self._clock = clock or _now_default
        self._id_gen = id_gen or _default_id_gen

    # paths --------------------------------------------------------------------

    def _rules_dir(self) -> Path:
        d = aura_path("automation", "rules")
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _runs_dir(self, rule_id: str) -> Path:
        d = aura_path("automation", "runs", rule_id)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _rule_file(self, rid: str) -> Path:
        return self._rules_dir() / f"{rid}.json"

    def _run_file(self, rule_id: str, rid: str) -> Path:
        return self._runs_dir(rule_id) / f"{rid}.json"

    def _index_file(self) -> Path:
        d = aura_path("automation")
        d.mkdir(parents=True, exist_ok=True)
        return d / "runs-index.json"

    # sanitize -----------------------------------------------------------------

    def _sanitize_rule(self, partial: dict, rid: str) -> dict:
        now = self._clock()
        chain_in = partial.get("chain")
        chain: list[dict] = []
        if isinstance(chain_in, list):
            for a in chain_in:
                if isinstance(a, dict) and isinstance(a.get("id"), str) and isinstance(a.get("action"), str):
                    cfg = a.get("config") if isinstance(a.get("config"), dict) else {}
                    label = a.get("label") if isinstance(a.get("label"), str) else a["action"]
                    chain.append({
                        "id": a["id"], "action": a["action"], "label": label,
                        "config": cfg, "continueOnError": a.get("continueOnError") is True,
                    })
        trig_in = partial.get("trigger") or {}
        trigger: dict[str, Any] = {
            "type": trig_in.get("type") if isinstance(trig_in.get("type"), str) else "mission-completed",
        }
        match = trig_in.get("match")
        if isinstance(match, dict):
            trigger["match"] = match
        cron = trig_in.get("cron")
        if isinstance(cron, str) and cron.strip():
            trigger["cron"] = cron.strip()
        project_id = trig_in.get("projectId")
        if isinstance(project_id, str) and project_id:
            trigger["projectId"] = project_id

        conditions_in = partial.get("conditions")
        conditions: list[dict] = []
        if isinstance(conditions_in, list):
            for c in conditions_in:
                if isinstance(c, dict) and isinstance(c.get("field"), str) and isinstance(c.get("op"), str):
                    conditions.append({"field": c["field"], "op": c["op"], "value": c.get("value")})

        retry_in = partial.get("retry") or {}

        def num(v: Any, default: float, minimum: float) -> int | float:
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                n = max(minimum, v)
                return int(n) if float(n).is_integer() else n
            return default

        retry = {
            "maxAttempts": num(retry_in.get("maxAttempts"), 1, 1),
            "delayMs": num(retry_in.get("delayMs"), 1000, 0),
            "backoffFactor": num(retry_in.get("backoffFactor"), 2, 1),
        }
        name = partial.get("name")
        category = partial.get("category")
        created = partial.get("createdAt")
        return {
            "id": rid,
            "name": name.strip() if isinstance(name, str) and name.strip() else "Untitled automation",
            "description": partial.get("description") if isinstance(partial.get("description"), str) else "",
            "category": category.strip() if isinstance(category, str) and category.strip() else "General",
            "enabled": partial.get("enabled") is not False,
            "trigger": trigger,
            "conditions": conditions,
            "chain": chain,
            "retry": retry,
            "createdAt": created if isinstance(created, str) else now,
            "updatedAt": now,
        }

    # rules ----------------------------------------------------------------------

    def list_rules(self) -> list[dict]:
        out = []
        d = self._rules_dir()
        for f in sorted(d.iterdir()):
            if not f.name.endswith(".json"):
                continue
            rule = read_json_file(f, None)
            if not isinstance(rule, dict) or not rule.get("id"):
                continue
            out.append({
                "id": rule["id"], "name": rule.get("name"),
                "description": rule.get("description"), "category": rule.get("category"),
                "enabled": rule.get("enabled"), "trigger": rule["trigger"]["type"],
                "conditionCount": len(rule.get("conditions") or []),
                "actionCount": len(rule.get("chain") or []),
                "createdAt": rule.get("createdAt"), "updatedAt": rule.get("updatedAt"),
            })
        return sorted(out, key=lambda s: s["updatedAt"], reverse=True)

    def get_rule(self, rid: str) -> dict | None:
        return read_json_file(self._rule_file(rid), None)

    def create_rule(self, partial: dict | None = None) -> dict:
        src = dict(partial or {})
        src["createdAt"] = self._clock()
        rule = self._sanitize_rule(src, self._id_gen("rule"))
        write_json_file(self._rule_file(rule["id"]), rule)
        return rule

    def save_rule(self, rid: str, partial: dict) -> dict | None:
        existing = self.get_rule(rid)
        if not existing:
            return None
        merged = {**existing, **partial, "id": rid, "createdAt": existing.get("createdAt")}
        rule = self._sanitize_rule(merged, rid)
        write_json_file(self._rule_file(rid), rule)
        return rule

    def remove_rule(self, rid: str) -> bool:
        try:
            self._rule_file(rid).unlink()
            return True
        except OSError:
            return False

    # runs -------------------------------------------------------------------------

    def _list_run_dirs(self) -> list[Path]:
        base = aura_path("automation", "runs")
        try:
            return sorted(p for p in base.iterdir() if p.is_dir())
        except OSError:
            return []

    def list_runs(self, rule_id: str | None = None) -> list[dict]:
        dirs = [self._runs_dir(rule_id)] if rule_id else self._list_run_dirs()
        out: list[dict] = []
        for d in dirs:
            for f in sorted(d.iterdir()):
                if not f.name.endswith(".json"):
                    continue
                run = read_json_file(f, None)
                if isinstance(run, dict) and run.get("id"):
                    out.append(summarize_automation_run(run))
        return sorted(out, key=lambda s: s["startedAt"], reverse=True)

    def get_run(self, rule_id: str, rid: str) -> dict | None:
        return read_json_file(self._run_file(rule_id, rid), None)

    def create_run(self, rule: dict, event: dict) -> dict:
        run: dict[str, Any] = {
            "id": self._id_gen("run"),
            "ruleId": rule["id"],
            "event": event,
            "status": "queued",
            "timeline": [{"id": self._id_gen("t"), "at": event["at"],
                          "type": "queued", "message": "Triggered", "level": "info"}],
            "actions": [
                {"actionId": a["id"], "action": a["action"], "label": a["label"],
                 "status": "pending", "attempts": 0}
                for a in rule.get("chain") or []
            ],
            "conditions": [],
            "startedAt": event["at"],
        }
        write_json_file(self._run_file(rule["id"], run["id"]), run)
        self.index_upsert(run)
        return run

    def save_run(self, run: dict) -> dict:
        write_json_file(self._run_file(run["ruleId"], run["id"]), run)
        self.index_upsert(run)
        return run

    # cross-rule index --------------------------------------------------------------

    def _read_index(self) -> dict | None:
        raw = read_json_file(self._index_file(), None)
        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("runs"), list):
            return None
        return raw

    def index_upsert(self, run: dict) -> None:
        index = self._read_index() or {"version": 1, "runs": []}
        rule = self.get_rule(run["ruleId"])
        summary = summarize_automation_run(run, rule.get("name") if rule else None)
        at = next((i for i, r in enumerate(index["runs"]) if r["id"] == summary["id"]), -1)
        if at >= 0:
            index["runs"][at] = summary
        else:
            index["runs"].append(summary)
        if len(index["runs"]) > MAX_INDEX_ENTRIES:
            index["runs"].sort(key=lambda r: r["startedAt"], reverse=True)
            del index["runs"][MAX_INDEX_ENTRIES:]
        write_json_file(self._index_file(), index)

    def rebuild_run_index(self) -> int:
        names = {r["id"]: r["name"] for r in self.list_rules()}
        runs: list[dict] = []
        for d in self._list_run_dirs():
            for f in sorted(d.iterdir()):
                if not f.name.endswith(".json"):
                    continue
                run = read_json_file(f, None)
                if isinstance(run, dict) and run.get("id"):
                    runs.append(summarize_automation_run(run, names.get(run["ruleId"])))
        runs.sort(key=lambda r: r["startedAt"], reverse=True)
        del runs[MAX_INDEX_ENTRIES:]
        write_json_file(self._index_file(), {"version": 1, "runs": runs})
        return len(runs)

    def index_runs(self, query: dict = {}) -> dict:
        index = self._read_index()
        if not index:
            self.rebuild_run_index()
            index = self._read_index()
        runs = sorted(index.get("runs") or [], key=lambda r: r["startedAt"], reverse=True)

        if query.get("ruleId"):
            runs = [r for r in runs if r["ruleId"] == query["ruleId"]]
        if query.get("projectId"):
            runs = [r for r in runs if r["projectId"] == query["projectId"]]
        if query.get("status"):
            runs = [r for r in runs if r["status"] == query["status"]]
        if query.get("trigger"):
            runs = [r for r in runs if r["trigger"] == query["trigger"]]
        if query.get("workflowId"):
            wid = query["workflowId"]
            runs = [r for r in runs
                    if any(isinstance(p, dict) and p.get("kind") == "workflow-run"
                           and p.get("workflowId") == wid for p in (r.get("produced") or []))]
        if query.get("since"):
            runs = [r for r in runs if r["startedAt"] >= query["since"]]
        if query.get("until"):
            runs = [r for r in runs if r["startedAt"] <= query["until"]]
        if query.get("q"):
            needle = query["q"].lower()
            runs = [r for r in runs if needle in (r.get("ruleName") or "").lower()
                    or needle in (r.get("error") or "").lower()]

        total = len(runs)
        offset = max(0, int(query.get("offset") or 0))
        limit = max(1, min(500, int(query.get("limit") if query.get("limit") is not None else 100)))
        return {"runs": runs[offset:offset + limit], "total": total, "offset": offset, "limit": limit}

    def run_stats(self, query: dict = {}) -> dict[str, int]:
        q = dict(query)
        q["limit"] = MAX_INDEX_ENTRIES
        out: dict[str, int] = {}
        for r in self.index_runs(q)["runs"]:
            out[r["status"]] = out.get(r["status"], 0) + 1
        return out


# ── schedule state (ai-service/automation.ts:78–90 shape) ────────────────────


def load_schedule_state() -> dict:
    return read_json_file(aura_path("automation", "schedule-state.json"), {})


def save_schedule_state(state: dict) -> None:
    write_json_file(aura_path("automation", "schedule-state.json"), state)


# silence linter
_ = timezone
