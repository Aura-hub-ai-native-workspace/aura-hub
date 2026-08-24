"""Workflow engine — graph interpretation over governed invocations.

Node classes supported this milestone:
  pure      current-project, variables, output
  control   condition (true/false ports), loop (bounded; each/out ports)
  governed  git-status → git.status, export-file → fs.write_file
Anything else fails the node honestly ('failed' with the reason) — never a
silent skip.

Bounds are engine-owned and cannot be widened by a workflow definition:
MAX_NODE_EXECUTIONS total node runs, MAX_LOOP_ITERATIONS per loop,
RUN_TIMEOUT_MS wall clock. Every stop maps to its own run state
(awaiting-approval / cancelled / timed-out / failed / succeeded).
"""

from __future__ import annotations

import time
import uuid
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..config import aura_home

from ..audit import AuditStore
from ..approvals import ApprovalLedger
from ..fabric import FabricConfig, invoke_fabric
from ..jsonutil import read_json_file
from ..persistence.runs import (
    WorkflowRunStore,
    append_log,
    attach_evidence,
    empty_node_record,
    is_terminal,
    transition_node,
)
from ..persistence.versions import WorkflowVersionStore
from ..persistence.workflows import WorkflowStore

MAX_NODE_EXECUTIONS = 200
MAX_LOOP_ITERATIONS = 50
RUN_TIMEOUT_MS = 120_000

GOVERNED_BINDINGS: dict[str, tuple[str, Callable[[dict, dict], dict]]] = {
    # node type → (capability id, config+vars → invocation input)
    "git-status": lambda cfg, vars_: {"detail": bool(cfg.get("detail", True))},
    "export-file": lambda cfg, vars_: {
        "path": _template(str(cfg.get("path", "")), vars_),
        "content": _template(str(cfg.get("content", "")), vars_),
    },
}


def _template(text: str, vars_: dict[str, str]) -> str:
    """Substitute {{var}} placeholders. Unknown names stay literal text."""
    import re

    def sub(match: re.Match[str]) -> str:
        return str(vars_.get(match.group(1).strip(), match.group(0)))

    return re.sub(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}", sub, text)


def _evaluate_condition(expr: str, vars_: dict[str, str]) -> bool:
    """Bounded predicate language: '<var> <op> <value>' with op in
    == != contains exists. No eval, no attribute access — parsing only."""
    parts = expr.strip().split(None, 2)
    if not parts:
        return False
    if parts[0] == "exists":
        return parts[1].strip() in vars_ if len(parts) > 1 else False
    if len(parts) < 3:
        return False
    name, op, rest = parts[0], parts[1], parts[2]
    left = str(vars_.get(name, ""))
    right = rest
    match op:
        case "==":
            return left == right
        case "!=":
            return left != right
        case "contains":
            return right in left
        case _:
            raise ValueError(f"unsupported condition operator: {op}")


@dataclass
class EngineConfig:
    max_node_executions: int = MAX_NODE_EXECUTIONS
    max_loop_iterations: int = MAX_LOOP_ITERATIONS
    run_timeout_ms: int = RUN_TIMEOUT_MS
    emit: Callable[[dict], None] | None = None


@dataclass
class NodeOutcome:
    state: str
    ports: list[str]  # outbound ports to follow, in order


class WorkflowEngine:
    def __init__(
        self,
        fabric_cfg: FabricConfig,
        workflows: WorkflowStore,
        versions: WorkflowVersionStore,
        runs: WorkflowRunStore,
        config: EngineConfig | None = None,
    ) -> None:
        self.fabric_cfg = fabric_cfg
        self.workflows = workflows
        self.versions = versions
        self.runs = runs
        self.config = config or EngineConfig()
        self._cancelled: set[str] = set()

    # ── events ───────────────────────────────────────────────────────────
    def _emit(self, kind: str, **payload: Any) -> None:
        if self.config.emit:
            try:
                self.config.emit({"type": kind, "at": self.runs._clock(), **payload})
            except Exception:
                pass  # observers never break execution

    # ── entry points ─────────────────────────────────────────────────────
    def start_run(
        self,
        wf_id: str,
        inputs: dict[str, str] | None = None,
        project_id: str | None = None,
        project_path: str | None = None,
        trigger: dict | None = None,
        actor_by: str = "user",
    ) -> dict:
        wf = self.workflows.get(wf_id)
        if wf is None:
            raise ValueError(f"no such workflow: {wf_id}")
        version = self.versions.ensure_version_for_run(wf, "central-agent")
        project_path = project_path or "."
        run = self.runs.create({
            "workflowId": wf_id,
            "versionId": version["id"],
            "workflowName": wf.get("name") or wf_id,
            "projectId": project_id or "-",
            "projectPath": project_path,
            "trigger": trigger or {"kind": "manual", "by": actor_by},
            "inputs": inputs or {},
        })
        run["state"] = "running"
        run["startedAt"] = self.runs._clock()
        self.runs.save(run)
        self._emit("run.started", runId=run["id"], workflowId=wf_id)
        return self._drive(run, version)

    def resume_run(self, rid: str, actor_by: str = "user") -> dict:
        old = self.runs.find(rid)
        if old is None:
            raise ValueError(f"no such run: {rid}")
        if old["state"] != "awaiting-approval" or not old.get("resumable"):
            raise ValueError(
                f"run {rid} is not resumable (state={old['state']})")
        if old.get("supersededBy"):
            raise ValueError(f"run {rid} was already superseded")
        parked = [
            n for n in old["nodes"].values()
            if n["state"] == "awaiting-approval"
        ]
        if not parked:
            raise ValueError("no parked node found on this run")

        # Validate authority BEFORE creating the leg: every parked node must
        # hold a GRANTED, unspent approval. The grant itself is spent by the
        # Fabric at invoke time (named-approval path), not here.
        ledger: ApprovalLedger | None = self.fabric_cfg.ledger
        for node in parked:
            request_id = (node.get("approval") or {}).get("requestId")
            request = ledger.by_id(request_id) if (ledger and request_id) else None
            if not request or request.get("state") != "granted" \
                    or request.get("consumedAt"):
                raise PermissionError(
                    f"approval for node {node['nodeId']} is not spendable")

        new = self.runs.create({
            "workflowId": old["workflowId"],
            "versionId": old["versionId"],
            "workflowName": old["workflowName"],
            "projectId": old["projectId"],
            "projectPath": old["projectPath"],
            "trigger": {"kind": "resume", "of": old["id"]},
            "inputs": dict(old.get("inputs") or {}),
        })
        new["state"] = "running"
        new["startedAt"] = self.runs._clock()
        new["vars"] = dict(old.get("vars") or {})
        # Completed work carries forward so evidence is never duplicated.
        # Deep-copied on purpose: mutating a shared record would rewrite the
        # parked leg's history.
        for nid, rec in old["nodes"].items():
            if rec["state"] not in ("awaiting-approval",):
                new["nodes"][nid] = deepcopy(rec)
        self.runs.save(new)
        self.runs.mark_superseded(old["workflowId"], old["id"], new["id"])
        self._emit("run.resumed", runId=new["id"], of=old["id"])
        version = self.versions.get(old["workflowId"], old["versionId"]) \
            or {"nodes": [], "edges": []}
        return self._drive(new, version, resume_grants={
            n["nodeId"]: (n.get("approval") or {}).get("requestId")
            for n in parked
        })

    def cancel(self, rid: str) -> bool:
        run = self.runs.find(rid)
        if run is None or is_terminal(run["state"]):
            return False
        self._cancelled.add(rid)
        return True

    # ── the interpreter ──────────────────────────────────────────────────
    def _drive(
        self,
        run: dict,
        version: dict,
        resume_grants: dict[str, str] | None = None,
    ) -> dict:
        nodes = {n["id"]: n for n in version["nodes"]}
        edges = [e for e in version["edges"]]
        out_ports: dict[str, list[tuple[str, str]]] = {}
        for e in edges:
            out_ports.setdefault(e["from"], []).append((e["to"], e.get("fromPort", "out")))

        started = time.monotonic()
        executions = 0
        visit_counts: dict[str, int] = {}
        vars_: dict[str, str] = run.setdefault("vars", {})
        project_cwd = run.get("projectPath") or "."

        frontier: list[tuple[str, str | None]] = [(self._entry(nodes, edges), None)] \
            if nodes else []
        stop_state: str | None = None
        stop_reason: str | None = None

        while frontier:
            if run["id"] in self._cancelled:
                stop_state, stop_reason = "cancelled", "cancelled by operator"
                break
            elapsed_ms = (time.monotonic() - started) * 1000
            if elapsed_ms > self.config.run_timeout_ms:
                stop_state, stop_reason = "timed-out", "run exceeded time budget"
                break
            if executions >= self.config.max_node_executions:
                stop_state, stop_reason = "failed", "node-execution bound reached"
                break

            nid, arrive_port = frontier.pop(0)
            node_def = nodes.get(nid)
            if node_def is None:
                continue
            record = run["nodes"].get(nid) or empty_node_record(
                nid, node_def["type"], iteration=visit_counts.get(nid, 0))
            record["attempts"] += 1
            transition_node(record, "running", clock=self.runs._clock)
            record["startedAt"] = self.runs._clock()
            run["nodes"][nid] = record
            executions += 1
            visit_counts[nid] = visit_counts.get(nid, 0) + 1
            self._emit("node.started", runId=run["id"], nodeId=nid, type=node_def["type"])

            try:
                outcome = self._execute_node(node_def, record, run, vars_, project_cwd,
                                             resume_grants or {})
                transition_node(record, outcome.state, clock=self.runs._clock)
            except Exception as exc:  # noqa: BLE001 — faults become honest failures
                record["error"] = str(exc)[:500]
                transition_node(record, "failed", clock=self.runs._clock)
                append_log(run, nid, "error", f"node failed: {exc}",
                           clock=self.runs._clock)
                self._emit("node.failed", runId=run["id"], nodeId=nid, error=str(exc)[:200])
                stop_state, stop_reason = "failed", f"node {nid} failed: {exc}"
                break

            record["finishedAt"] = self.runs._clock()
            record["ms"] = record.get("ms", 0.0)
            self.runs.save(run)
            self._emit("node.finished", runId=run["id"], nodeId=nid, state=outcome.state)

            if outcome.state == "awaiting-approval":
                stop_state, stop_reason = "awaiting-approval", \
                    f"node {nid} is waiting on human approval"
                break
            if outcome.state in ("denied", "failed"):
                stop_state, stop_reason = "failed", \
                    f"node {nid} {outcome.state}: {record.get('summary', '')}"
                break

            followed = set(outcome.ports) or {"out"}
            for target, port in out_ports.get(nid, []):
                if port in followed:
                    frontier.append((target, port))

        run["ms"] = round((time.monotonic() - started) * 1000, 1)
        if stop_state is None:
            stop_state = "succeeded"
            stop_reason = None
        run["state"] = stop_state  # type: ignore[assignment]
        run["finishedAt"] = self.runs._clock()
        run["resumable"] = stop_state == "awaiting-approval"
        if stop_reason and stop_state != "succeeded":
            run["error"] = stop_reason
        append_log(run, None, "info", f"run {stop_state}", clock=self.runs._clock)
        self.runs.save(run)
        self.runs.reconcile_interrupted.__self__  # noqa: B018 — keep store warm
        self._emit("run.finished", runId=run["id"], state=stop_state)
        return run

    @staticmethod
    def _entry(nodes: dict[str, dict], edges: list[dict]) -> str:
        targets = {e["to"] for e in edges}
        for nid in nodes:
            if nid not in targets:
                return nid
        return next(iter(nodes))

    def _execute_node(
        self,
        node_def: dict,
        record: dict,
        run: dict,
        vars_: dict[str, str],
        project_cwd: str,
        resume_grants: dict[str, str],
    ) -> NodeOutcome:
        ntype = node_def["type"]
        cfg = node_def.get("config") or {}

        # pure ─ current-project
        if ntype == "current-project":
            vars_.setdefault("projectPath", project_cwd)
            record["summary"] = f"Project context bound ({project_cwd})."
            return NodeOutcome("succeeded", ["out"])

        # pure ─ variables
        if ntype == "variables":
            sets = cfg.get("set") if isinstance(cfg.get("set"), dict) else {}
            for k, v in sets.items():
                vars_[str(k)] = _template(str(v), vars_)
            record["summary"] = f"{len(sets)} variable(s) set."
            return NodeOutcome("succeeded", ["out"])

        # pure ─ output
        if ntype == "output":
            text = _template(str(cfg.get("text", "")), vars_)
            run["outputs"].append({"nodeId": node_def["id"],
                                   "title": str(cfg.get("title") or "Output"),
                                   "text": text[:4000]})
            record["summary"] = "Output captured."
            return NodeOutcome("succeeded", ["out"])

        # control ─ condition
        if ntype == "condition":
            expr = str(cfg.get("when", ""))
            try:
                taken = _evaluate_condition(expr, vars_)
            except ValueError as exc:
                record["error"] = str(exc)
                return NodeOutcome("failed", [])
            branch = "true" if taken else "false"
            record["summary"] = f"Condition '{expr}' → {branch}."
            return NodeOutcome("succeeded", [branch])

        # control ─ loop (bounded)
        if ntype == "loop":
            count = min(int(cfg.get("count", 0) or 0), self.config.max_loop_iterations)
            items = cfg.get("over")
            if isinstance(items, list):
                count = min(len(items), self.config.max_loop_iterations)
            done = int(record.get("iteration") or 0)
            if done >= max(count, 0):
                record["summary"] = f"Loop complete after {done} iteration(s)."
                return NodeOutcome("succeeded", ["out"])
            record["iteration"] = done + 1
            vars_["loopIndex"] = str(done)
            record["summary"] = f"Iteration {done + 1}/{count}."
            return NodeOutcome("succeeded", ["each"])

        # governed ─ fixed bindings through the Fabric
        if ntype in GOVERNED_BINDINGS:
            capability_id = {
                "git-status": "git.status",
                "export-file": "fs.write_file",
            }[ntype]
            input_payload = GOVERNED_BINDINGS[ntype](cfg, vars_)
            return self._invoke_for_node(capability_id, input_payload, node_def,
                                         record, run, project_cwd, resume_grants)

        # intelligence/generate families: NOT implemented in Python yet.
        record["error"] = f"node type '{ntype}' has no Python executor yet"
        return NodeOutcome("failed", [])

    def _invoke_for_node(
        self,
        capability_id: str,
        payload: dict,
        node_def: dict,
        record: dict,
        run: dict,
        project_cwd: str,
        resume_grants: dict[str, str],
    ) -> NodeOutcome:
        context = {
            "actor": {"kind": "system",
                      "id": f"workflow:{run['workflowId']}:{node_def['id']}"},
            "projectId": run.get("projectId"),
            "cwd": project_cwd,
            "taskId": node_def["id"],
            "workflowId": run["workflowId"],
            "runId": run["id"],
            "workflowNodeId": node_def["id"],
        }
        grant = resume_grants.get(node_def["id"])
        if grant:
            context["approvalId"] = grant
        record["input"] = payload
        result = invoke_fabric(capability_id, payload, context, self.fabric_cfg)

        evidence = {
            "invocationId": result["invocationId"],
            "capabilityId": result["capabilityId"],
            "outcome": result["outcome"],
            "decision": result["policy"]["decision"],
            "decisionRule": result["policy"]["rule"],
            "risk": result["policy"]["risk"],
            "verified": result["verification"]["passed"],
            "at": result["at"],
            "durationMs": 0.0,
            "nodeId": node_def["id"],
        }
        attach_evidence(run, node_def["id"], evidence)
        record["summary"] = result["detail"][:300]

        if result["outcome"] == "awaiting-approval":
            record["approval"] = {
                "requestId": result.get("approvalId"),
                "capabilityId": capability_id,
                "requestedAt": result["at"],
                "summary": result["detail"][:300],
            }
            append_log(run, node_def["id"], "warn",
                       f"parked on approval {result.get('approvalId')}",
                       clock=self.runs._clock)
            return NodeOutcome("awaiting-approval", [])

        untrusted_note = ""
        output = result.get("output")
        if isinstance(output, dict) and isinstance(output.get("text"), str):
            # Tool output is UNTRUSTED DATA. It may be stored and displayed;
            # it is never interpreted as instruction here.
            untrusted_note = " (untrusted tool output)"
            record["output"] = {"text": output["text"][:4000]}
        if result["outcome"] in ("succeeded", "unverified"):
            return NodeOutcome("succeeded", ["out"])
        record["error"] = result["detail"][:500]
        return NodeOutcome(
            "denied" if result["outcome"] == "denied" else "failed", [])


def make_stores(
    home: Path | None = None,
    clock: Callable[[], str] | None = None,
) -> tuple[WorkflowStore, WorkflowVersionStore, WorkflowRunStore]:
    """Stores wired with unique id generation.

    The persisted-formats spec requires globally unique ids per instant;
    process-pid placeholders collide across legs, so every engine consumer
    goes through here rather than constructing stores bare.
    """
    def gen(prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:12]}"

    return (
        WorkflowStore(clock=clock, id_gen=gen),
        WorkflowVersionStore(clock=clock, id_gen=gen),
        WorkflowRunStore(clock=clock, id_gen=gen),
    )
