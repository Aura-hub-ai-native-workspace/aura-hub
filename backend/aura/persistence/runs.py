"""WorkflowRunStore — port of workflow/run/store.ts (427 lines), byte-parity.

Includes the record helpers the engine shares (emptyNodeRecord,
transition_node, append_log, attach_evidence, run_state_for) and
summarize_run, whose field ORDER matters because it is written into
index.json verbatim.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Any

from ..config import aura_path
from ..jsonutil import read_json_file, write_json_file
from ._alias import CamelAlias

MAX_RUNS_PER_WORKFLOW = 200
MAX_INDEX_ENTRIES = 5000
TERMINAL = ("succeeded", "failed", "cancelled", "timed-out")


def _now_default() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def is_terminal(state: str) -> bool:
    return state in TERMINAL


def summarize_run(run: dict) -> dict:
    """run/types.ts:286–308 — declaration order preserved (index bytes depend on it)."""
    states = list((run.get("nodes") or {}).values())
    out: dict[str, Any] = {
        "id": run["id"],
        "workflowId": run["workflowId"],
        "versionId": run["versionId"],
        "workflowName": run["workflowName"],
        "projectId": run["projectId"],
        "state": run["state"],
        "trigger": run["trigger"]["kind"],
        "createdAt": run["createdAt"],
    }
    if run.get("finishedAt") is not None:
        out["finishedAt"] = run["finishedAt"]
    out["ms"] = run.get("ms", 0)
    out["nodeCount"] = len(states)
    out["succeededCount"] = sum(1 for n in states if n.get("state") == "succeeded")
    out["failedCount"] = sum(1 for n in states if n.get("state") in ("failed", "timed-out"))
    out["evidenceCount"] = len(run.get("evidence") or [])
    out["approvalCount"] = sum(1 for n in states if n.get("state") == "awaiting-approval")
    out["resumable"] = run.get("resumable", False)
    if run.get("error") is not None:
        out["error"] = run["error"]
    if run.get("supersededBy") is not None:
        out["supersededBy"] = run["supersededBy"]
    return out


class WorkflowRunStore(CamelAlias):
    def __init__(self, clock: Callable[[], str] | None = None,
                 id_gen: Callable[[str], str] | None = None) -> None:
        self._clock = clock or _now_default
        self._id_gen = id_gen or (lambda p: f"{p}-{os.getpid()}")
        self._root: Path | None = None

    # paths ------------------------------------------------------------------

    def _ensure_root(self) -> Path:
        if self._root is None:
            d = aura_path("workflow-runs")
            d.mkdir(parents=True, exist_ok=True)
            self._root = d
        return self._root

    def _wdir(self, wid: str) -> Path:
        d = aura_path("workflow-runs", wid)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _rfile(self, wid: str, rid: str) -> Path:
        return self._wdir(wid) / f"{rid}.json"

    def _index_file(self) -> Path:
        return self._ensure_root() / "index.json"

    # CRUD --------------------------------------------------------------------

    def create(self, inp: dict) -> dict:
        run: dict[str, Any] = {
            "id": self._id_gen("run"),
            "workflowId": inp["workflowId"],
            "versionId": inp["versionId"],
            "workflowName": inp["workflowName"],
            "projectId": inp["projectId"],
            "projectPath": inp["projectPath"],
            "state": "queued",
            "trigger": inp["trigger"],
            "createdAt": self._clock(),
            "ms": 0,
            "nodes": {},
            "vars": {},
            "inputs": inp.get("inputs") or {},
            "outputs": [],
            "evidence": [],
            "resumable": False,
            "log": [],
        }
        self.save(run)
        self.prune(inp["workflowId"])
        return run

    def get(self, wid: str, rid: str) -> dict | None:
        return read_json_file(self._rfile(wid, rid), None)

    def find(self, rid: str) -> dict | None:
        for wid in self.workflow_ids():
            run = self.get(wid, rid)
            if run:
                return run
        return None

    def save(self, run: dict) -> None:
        log = run.get("log") or []
        if len(log) > MAX_RUN_LOG:
            run["log"] = log[-MAX_RUN_LOG:]
        write_json_file(self._rfile(run["workflowId"], run["id"]), run)
        self.index_upsert(summarize_run(run))

    # index -------------------------------------------------------------------

    def _read_index(self) -> dict | None:
        raw = read_json_file(self._index_file(), None)
        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("runs"), list):
            return None
        return raw

    def index_upsert(self, summary: dict) -> None:
        index = self._read_index() or {"version": 1, "runs": []}
        at = next((i for i, r in enumerate(index["runs"]) if r["id"] == summary["id"]), -1)
        if at >= 0:
            index["runs"][at] = summary
        else:
            index["runs"].append(summary)
        if len(index["runs"]) > MAX_INDEX_ENTRIES:
            index["runs"].sort(key=lambda r: r["createdAt"], reverse=True)
            del index["runs"][MAX_INDEX_ENTRIES:]
        write_json_file(self._index_file(), index)

    def _index_remove(self, rid: str) -> None:
        index = self._read_index()
        if not index:
            return
        nxt = [r for r in index["runs"] if r["id"] != rid]
        if len(nxt) != len(index["runs"]):
            write_json_file(self._index_file(), {"version": 1, "runs": nxt})

    def rebuild_index(self) -> int:
        runs: list[dict] = []
        for wid in self.workflow_ids():
            d = self._wdir(wid)
            for f in sorted(d.iterdir()):
                if not f.name.endswith(".json"):
                    continue
                run = read_json_file(f, None)
                if isinstance(run, dict) and run.get("id"):
                    runs.append(summarize_run(run))
        runs.sort(key=lambda r: r["createdAt"], reverse=True)
        del runs[MAX_INDEX_ENTRIES:]
        write_json_file(self._index_file(), {"version": 1, "runs": runs})
        return len(runs)

    def checkpoint(self, run: dict) -> None:
        self.save(run)

    def list(self, wid: str | None = None) -> list[dict]:
        index = self._read_index()
        if not index:
            self.rebuild_index()
            index = self._read_index()
        runs = (index or {}).get("runs") or []
        filtered = [r for r in runs if r["workflowId"] == wid] if wid else runs
        return sorted(filtered, key=lambda r: r["createdAt"], reverse=True)

    def index(self, query: dict = {}) -> dict:
        runs = self.list(query.get("workflowId"))
        if query.get("projectId"):
            runs = [r for r in runs if r["projectId"] == query["projectId"]]
        if query.get("state"):
            runs = [r for r in runs if r["state"] == query["state"]]
        if query.get("trigger"):
            runs = [r for r in runs if r["trigger"] == query["trigger"]]
        if query.get("since"):
            runs = [r for r in runs if r["createdAt"] >= query["since"]]
        if query.get("q"):
            needle = query["q"].lower()
            runs = [r for r in runs if needle in r["workflowName"].lower()]
        total = len(runs)
        offset = max(0, query.get("offset") or 0)
        limit = max(1, min(500, query.get("limit") if query.get("limit") is not None else 100))
        return {"runs": runs[offset:offset + limit], "total": total, "offset": offset, "limit": limit}

    def list_awaiting_approval(self) -> list[dict]:
        return [r for r in self.list() if r["state"] == "awaiting-approval" and not r.get("supersededBy")]

    def mark_superseded(self, wid: str, rid: str, by_rid: str) -> dict | None:
        run = self.get(wid, rid)
        if not run or run.get("supersededBy"):
            return run
        run["supersededBy"] = by_rid
        run["supersededAt"] = self._clock()
        run["resumable"] = False
        run["notResumableReason"] = f"continued as run {by_rid}"
        self.save(run)
        return run

    def resume_chain(self, wid: str, rid: str) -> list[dict]:
        head = self.get(wid, rid)
        if not head:
            return []
        guard: set[str] = set()
        while head["trigger"].get("kind") == "resume" and head["id"] not in guard:
            guard.add(head["id"])
            prior = self.get(wid, head["trigger"]["of"])
            if not prior:
                break
            head = prior
        chain = [head]
        seen = {head["id"]}
        cursor: dict | None = head
        while cursor and cursor.get("supersededBy") and cursor["supersededBy"] not in seen:
            seen.add(cursor["supersededBy"])
            cursor = self.get(wid, cursor["supersededBy"])
            if cursor:
                chain.append(cursor)
        return chain

    def stats(self, project_id: str | None = None) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in self.list():
            if project_id and r["projectId"] != project_id:
                continue
            out[r["state"]] = out.get(r["state"], 0) + 1
        return out

    def remove(self, wid: str, rid: str) -> bool:
        try:
            os.remove(self._rfile(wid, rid))
            self._index_remove(rid)
            return True
        except OSError:
            return False

    def remove_all(self, wid: str) -> None:
        import shutil

        shutil.rmtree(aura_path("workflow-runs", wid), ignore_errors=True)
        self.rebuild_index()

    def workflow_ids(self) -> list[str]:
        try:
            root = self._ensure_root()
            return sorted(d.name for d in root.iterdir() if d.is_dir() and not d.name.endswith(".json"))
        except OSError:
            return []

    def prune(self, wid: str) -> None:
        all_runs = self.list(wid)
        if len(all_runs) <= MAX_RUNS_PER_WORKFLOW:
            return
        terminal = sorted(
            (r for r in all_runs if is_terminal(r["state"])),
            key=lambda r: r["createdAt"],
        )
        excess = len(all_runs) - MAX_RUNS_PER_WORKFLOW
        for r in terminal[:excess]:
            self.remove(wid, r["id"])

    # crash recovery ------------------------------------------------------------

    def reconcile_interrupted(self) -> list[dict]:
        recovered: list[dict] = []
        for wid in self.workflow_ids():
            d = self._wdir(wid)
            for f in sorted(d.iterdir()):
                if not f.name.endswith(".json"):
                    continue
                run = read_json_file(f, None)
                if not isinstance(run, dict) or not run.get("id"):
                    continue
                if run["state"] not in ("running", "queued"):
                    continue
                completed = sum(1 for n in run.get("nodes", {}).values() if n.get("state") == "succeeded")
                run["state"] = "failed"
                run["error"] = "AURA stopped while this run was in flight."
                run["finishedAt"] = self._clock()
                run["resumable"] = completed > 0
                if not run["resumable"]:
                    run["notResumableReason"] = (
                        "No node completed before the interruption, so there is nothing to resume from."
                    )
                run.setdefault("log", []).append({
                    "at": run["finishedAt"], "nodeId": None, "level": "warn",
                    "text": f"Run interrupted — recovered at startup with {completed} completed node{'' if completed == 1 else 's'}.",
                })
                self.save(run)
                recovered.append(summarize_run(run))
        return recovered


# ── engine-shared record helpers (run/store.ts:385–427) ─────────────────────


MAX_RUN_LOG = 2000
MAX_TRANSITIONS = 60


def empty_node_record(node_id: str, type_: str, iteration: int = 0) -> dict:
    return {"nodeId": node_id, "type": type_, "state": "queued", "iteration": iteration,
            "ms": 0, "attempts": 0, "evidence": [], "transitions": []}


def transition_node(node: dict, to: str, note: str | None = None, clock: Callable[[], str] | None = None) -> None:
    from_state = node["state"]
    if from_state == to and node["transitions"]:
        return
    node["state"] = to
    entry: dict[str, Any] = {"at": (clock or _now_default)(), "from": from_state, "to": to}
    if note is not None:
        entry["note"] = note
    node["transitions"].append(entry)
    if len(node["transitions"]) > MAX_TRANSITIONS:
        excess = len(node["transitions"]) - MAX_TRANSITIONS
        del node["transitions"][:excess]


def append_log(run: dict, node_id: str | None, level: str, text: str, clock: Callable[[], str] | None = None) -> None:
    run.setdefault("log", []).append({"at": (clock or _now_default)(), "nodeId": node_id, "level": level, "text": text})
    if len(run["log"]) > MAX_RUN_LOG:
        excess = len(run["log"]) - MAX_RUN_LOG
        del run["log"][:excess]


def attach_evidence(run: dict, node_id: str, evidence: dict) -> None:
    run["evidence"].append(evidence)
    node = run["nodes"].get(node_id)
    if node:
        node["evidence"].append(evidence)


def run_state_for(node_state: str) -> str | None:
    return {
        "awaiting-approval": "awaiting-approval",
        "cancelled": "cancelled",
        "timed-out": "timed-out",
        "failed": "failed",
        "denied": "failed",
    }.get(node_state)


# silence unused import (kept for parity clarity with TS imports)
_ = timezone
