"""WorkflowRunner — port of runner.ts. THE single canonical entry point.

Manual/API, scheduler, automation and (later) Central Agent ALL call
`WorkflowRunner.start` / `.resume`. There is no other execution path.
"""
from __future__ import annotations

import asyncio
from typing import Any

from ..persistence.runs import WorkflowRunStore
from ..persistence.versions import WorkflowVersionStore
from .engine import run_workflow
from .governor import create_governor


def compute_envelope(nodes: list[dict]) -> dict:
    """Minimal envelope: scopes actually required by the executing graph.

    Full TS envelope fields (hosts/notRequested/cannot) are presentation
    surface frozen for Phase 10 wire compat; governance depends on the
    scope list, which must be exact.
    """
    from .nodes_core import GOVERNED_TYPES

    scopes: dict[str, dict] = {}
    for n in nodes:
        if n["type"] not in GOVERNED_TYPES:
            continue
        binding_cap = {
            "shell-command": "terminal.execute", "export-file": "filesystem.write",
            "git-status": "git.status", "changed-files": "git.status",
            "git-diff": "git.diff", "git-commit": "git.commit",
            "git-branch": "git.branch",
            "http-request": "http.request",
        }.get(n["type"])
        cap = next((c for c in _manifest_caps() if c["id"] == binding_cap), None)
        if not cap:
            continue
        entry = scopes.setdefault(cap["id"], {"scope-set": set(), "capabilityIds": [], "risk": cap["risk"]})
        if n["id"] not in [x for x in entry["capabilityIds"]]:
            entry["capabilityIds"].append(n["id"])
        for p in cap.get("permissions") or []:
            entry["scope-set"].add(p)
    return {"capabilities": sorted(
        [{"capabilityId": cid, "scopes": sorted(v["scope-set"]),
          "risk": v["risk"], "nodeIds": v["capabilityIds"]}
         for cid, v in scopes.items()], key=lambda x: x["capabilityId"])}


_MANIFEST_CACHE = None


def _manifest_caps():
    global _MANIFEST_CACHE
    if _MANIFEST_CACHE is None:
        import json
        from pathlib import Path

        f = Path(__file__).parent.parent / "fabric" / "manifest.json"
        _MANIFEST_CACHE = json.loads(f.read_text())["capabilities"]
    return _MANIFEST_CACHE


class WorkflowRunner:
    """THE canonical execution path."""

    def __init__(self, *, fabric, run_scopes, versions: WorkflowVersionStore,
                 runs: WorkflowRunStore, secrets=None, pipeline=None,
                 projects=None) -> None:
        self.fabric = fabric
        self.run_scopes = run_scopes
        self.versions = versions
        self.runs = runs
        self.secrets = secrets
        self.pipeline = pipeline
        self.projects = projects
        self.live_runs: dict[str, asyncio.Event] = {}

    # ── convergence seam ────────────────────────────────────────────────
    # manual/API, scheduler, automation and Central Agent all funnel here.
    async def start_workflow_run(self, workflow: dict, *, project_id: str,
                                 project_path: str, project_name: str = "",
                                 trigger: dict, inputs: dict | None = None,
                                 approved_capabilities: list[str] | None = None,
                                 actor: dict | None = None,
                                 emit: Any = lambda e: None,
                                 on_run_created=None,
                                 max_node_executions: int | None = None) -> dict:
        return await self.start({"workflow": workflow, "projectId": project_id,
                                 "projectPath": project_path,
                                 "projectName": project_name or workflow.get("name", ""),
                                 "trigger": trigger, "inputs": inputs,
                                 "approvedCapabilities": approved_capabilities,
                                 "actor": actor,
                                 "maxNodeExecutions": max_node_executions}, emit)

    workflows = None  # optional store seam; automation resolves ids via it

    def _agent_runner(self, *, run: dict, envelope: dict, redact, signal):
        if self.fabric is None:
            return None
        from .agent.runner import AgentRunner

        return AgentRunner(
            fabric=self.fabric, envelope=envelope, redact=redact,
            workflow_id=run["workflowId"], run_id=run["id"],
            project_id=run["projectId"], project_path=run["projectPath"],
            model=getattr(self, "model", None),
            actor={"kind": "agent", "id": "agent:workflow"})

    def cancel_workflow_run(self, run_id: str) -> bool:
        ev = self.live_runs.get(run_id)
        if not ev:
            return False
        ev.set()          # AbortSignal parity
        return True

    async def start(self, input: dict, emit) -> dict:
        workflow = input["workflow"]
        actor = input.get("actor") or {"kind": "human", "id": "user"}
        version = self.versions.ensure_version_for_run(workflow, f"run:{actor['id']}")
        envelope = compute_envelope(version["nodes"])

        run = self.runs.create({
            "workflowId": workflow["id"], "versionId": version["id"],
            "workflowName": version["name"], "projectId": input["projectId"],
            "projectPath": input["projectPath"], "trigger": input["trigger"],
            "inputs": input.get("inputs"),
        })
        cancel_event = asyncio.Event()
        self.live_runs[run["id"]] = cancel_event
        if input.get("onRunCreated"):
            input["onRunCreated"](run)

        result = await self._execute(input, version, envelope, run, actor, cancel_event, emit)
        self.live_runs.pop(run["id"], None)
        fresh = self.runs.get(workflow["id"], run["id"])
        return {"run": fresh or run, "version": version, "envelope": envelope,
                "result": result}

    async def resume(self, workflow: dict, run_id: str, emit, opts: dict | None = None):
        opts = opts or {}
        previous = self.runs.get(workflow["id"], run_id)
        if not previous:
            return {"error": "no such run"}
        if previous["state"] == "succeeded":
            return {"error": "that run already succeeded — there is nothing to resume"}
        if previous.get("supersededBy"):
            return {"error": f"that run was already continued as run {previous['supersededBy']}"}
        if not previous.get("resumable"):
            return {"error": previous.get("notResumableReason") or "that run cannot be resumed"}

        version = self.versions.get(workflow["id"], previous["versionId"])
        if not version:
            return {"error": f"the version this run executed ({previous['versionId']}) no longer exists, so it cannot be resumed"}

        replay: dict[str, dict] = {}
        agent_resume: dict[str, dict] = {}
        for node in previous["nodes"].values():
            if node["state"] == "succeeded" and node.get("output"):
                replay[node["nodeId"]] = {"text": node["output"].get("text"),
                                          "data": node["output"].get("data"),
                                          "files": node["output"].get("files"),
                                          "port": node["output"].get("port")}
            elif node["state"] == "awaiting-approval" and node.get("agentTrace"):
                agent_resume[node["nodeId"]] = node["agentTrace"]
        if not replay and not agent_resume and previous["state"] != "awaiting-approval":
            return {"error": "no node completed in that run, so there is no checkpoint to resume from"}

        envelope = compute_envelope(version["nodes"])
        run = self.runs.create({
            "workflowId": workflow["id"], "versionId": version["id"],
            "workflowName": version["name"], "projectId": previous["projectId"],
            "projectPath": previous["projectPath"],
            "trigger": {"kind": "resume", "of": previous["id"]},
            "inputs": previous.get("inputs"),
        })
        run["vars"] = dict(previous.get("vars") or {})
        cancel_event = asyncio.Event()
        self.live_runs[run["id"]] = cancel_event
        self.runs.mark_superseded(workflow["id"], previous["id"], run["id"])
        if opts.get("onRunCreated"):
            opts["onRunCreated"](run)

        result = await self._execute(
            {"workflow": {**workflow, "nodes": version["nodes"], "edges": version["edges"]},
             "projectId": previous["projectId"], "projectPath": previous["projectPath"],
             "projectName": workflow.get("name", ""), "trigger": run["trigger"],
             "inputs": previous.get("inputs"),
             "approvedCapabilities": opts.get("approvedCapabilities"),
             "actor": opts.get("actor") or {"kind": "human", "id": "user"},
             "replay": replay, "agentResume": agent_resume},
            version, envelope, run, opts.get("actor") or {"kind": "human", "id": "user"},
            cancel_event, emit)
        self.live_runs.pop(run["id"], None)
        fresh = self.runs.get(workflow["id"], run["id"])
        return {"run": fresh or run, "version": version, "envelope": envelope,
                "result": result}

    async def _execute(self, input: dict, version: dict, envelope: dict,
                       run: dict, actor: dict, cancel_event: asyncio.Event,
                       emit) -> dict:
        scopes: list[str] = []
        for c in envelope.get("capabilities") or []:
            scopes.extend(c.get("scopes") or [])
        self.run_scopes.register(run["id"], set(scopes))
        governor = None
        if self.fabric is not None:
            governor = create_governor(
                fabric=self.fabric,
                secrets=self.secrets or type("S", (), {"known_values": staticmethod(list)})(),
                workflow_id=run["workflowId"], run_id=run["id"],
                project_id=run["projectId"], project_path=run["projectPath"],
                actor=actor,
                approved_capabilities=input.get("approvedCapabilities"),
            )
        signal = {"aborted": False, "event": cancel_event}
        watcher = asyncio.ensure_future(_watch(cancel_event, signal))

        wf_exec = {"id": input["workflow"]["id"], "name": input["workflow"].get("name", ""),
                   "nodes": version["nodes"], "edges": version["edges"]}
        try:
            return await run_workflow(wf_exec, {
                "projectId": run["projectId"], "projectPath": run["projectPath"],
                "projectName": input.get("projectName"), "inputs": run.get("inputs"),
                "signal": signal, "run": run, "runs": self.runs,
                "governor": governor,
                "model": getattr(self, "model", None),
                "agents": self._agent_runner(run=run, envelope=envelope,
                                             redact=governor.redact if governor else (lambda t: t),
                                             signal=signal),
                "timeoutMs": input.get("timeoutMs"),
                "replay": input.get("replay"),
                "agentResume": input.get("agentResume"),
                "maxNodeExecutions": input.get("maxNodeExecutions"),
            }, emit)
        finally:
            watcher.cancel()
            self.run_scopes.remove(run["id"])


async def _watch(cancel_event: asyncio.Event, signal: dict) -> None:
    await cancel_event.wait()
    signal["aborted"] = True
