"""Differential verification of the Capability Fabric.

Runs identical scripted scenarios through the TypeScript fabric and the
Python port, and reports every difference.

The fabric is pure domain with injected host ports, which is what makes
this a genuine comparison rather than a simulation: the host and the
executors are described in JSON, so both implementations see exactly the
same inputs and the same executor behaviour.

Usage (from backend/):
    uv run python -m parity.fabric_parity --repo /mnt/storage/aura-hub
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from aura_backend.fabric import (
    CAPABILITY_MANIFEST,
    CapabilityFabric,
    ExecutorResult,
    InvocationActor,
    InvocationContext,
    NodeRef,
    resolve_node_for,
)
from aura_backend.policy import Grants, sanitize_policy


class ScriptedExecutor:
    """An executor whose behaviour is entirely described by the scenario."""

    def __init__(self, spec: dict[str, Any]) -> None:
        self.capability_id = spec["capabilityId"]
        self._spec = spec
        self._calls = 0
        if spec.get("supportsNodes") is not None:
            allowed = set(spec["supportsNodes"])
            self.supports_node = lambda node: node.id in allowed  # type: ignore[assignment]
        if spec.get("verify"):
            self.verify = self._verify  # type: ignore[assignment]

    async def run(self, _invocation) -> ExecutorResult:
        self._calls += 1
        spec = self._spec
        behavior = spec.get("behavior")
        if behavior == "ok":
            return ExecutorResult(True, spec.get("detail", "done"), spec.get("output"))
        if behavior == "fail":
            return ExecutorResult(False, spec.get("detail", "it did not work"))
        if behavior == "throw":
            raise RuntimeError(spec.get("detail", "executor exploded"))
        if behavior == "throw-empty":
            raise RuntimeError("")
        if behavior == "transient":
            return ExecutorResult(False, spec.get("detail", "ETIMEDOUT while connecting"))
        if behavior == "transient-then-ok":
            if self._calls >= spec.get("succeedOnAttempt", 2):
                return ExecutorResult(True, "recovered", spec.get("output"))
            return ExecutorResult(False, "ECONNRESET")
        return ExecutorResult(False, f"unknown behavior {behavior}")

    async def _verify(self, _invocation, _result):
        from aura_backend.fabric import VerificationReport

        mode = self._spec["verify"]
        if mode == "throw":
            raise RuntimeError("the check blew up")
        return VerificationReport(
            passed=mode == "pass",
            kind="read-back",
            detail="confirmed" if mode == "pass" else "not confirmed",
        )


class ScriptedHost:
    def __init__(self, scenario: dict[str, Any], nodes: list[NodeRef]) -> None:
        self._scenario = scenario
        self._nodes = nodes
        self.resolve_node = None if scenario.get("routing") is False else self._resolve

    def permissions_for(self, _capability, context) -> Grants:
        by_run = self._scenario.get("grantsByRun") or {}
        raw = by_run.get(context.run_id or "") or self._scenario.get("grants")
        if raw is None:
            return Grants(read=True, write=True, execute=True, autonomous=False)
        return Grants(
            read=raw.get("read", False), write=raw.get("write", False),
            execute=raw.get("execute", False), autonomous=raw.get("autonomous", False),
        )

    def node_available(self, capability) -> bool | None:
        needed = capability.requires_node_capability
        if not needed:
            return None
        if capability.surface == "aura-internal":
            return True
        return any(needed in n.capabilities for n in self._nodes)

    def _resolve(self, capability, context, can_use=None):
        return resolve_node_for(capability, context, self._nodes, can_use)

    async def request_approval(self, request, context) -> bool:
        approved = set(context.approved_capabilities or ())
        return all(i.capability_id in approved for i in request.items)


def _context(raw: dict[str, Any] | None) -> InvocationContext:
    raw = raw or {"actor": {"kind": "agent", "id": "a"}, "projectId": None}
    actor = raw.get("actor") or {"kind": "agent", "id": "a"}
    return InvocationContext(
        actor=InvocationActor(kind=actor.get("kind", "agent"), id=actor.get("id", "a")),
        project_id=raw.get("projectId"),
        cwd=raw.get("cwd"),
        mission_id=raw.get("missionId"),
        task_id=raw.get("taskId"),
        workflow_id=raw.get("workflowId"),
        run_id=raw.get("runId"),
        workflow_node_id=raw.get("workflowNodeId"),
        approved_capabilities=tuple(raw.get("approvedCapabilities") or ()),
        node_id=raw.get("nodeId"),
    )


def _enum(value: Any) -> Any:
    return value.value if hasattr(value, "value") else value


async def run_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    events: list[str] = []
    nodes = [
        NodeRef(
            id=n["id"], name=n["name"],
            capabilities=tuple(n.get("capabilities") or ()), binary=n.get("binary"),
        )
        for n in (scenario.get("nodes") or [])
    ]
    host = ScriptedHost(scenario, nodes)
    fabric = CapabilityFabric(host)
    fabric.on(lambda e: events.append(e.type))
    if scenario.get("policy"):
        fabric.set_policy(sanitize_policy(scenario["policy"]))
    for spec in scenario.get("executors") or []:
        fabric.register(ScriptedExecutor(spec))

    steps: list[dict[str, Any]] = []
    for step in scenario.get("steps") or []:
        op = step["op"]
        try:
            if op == "invoke":
                r = await fabric.invoke(
                    step["capabilityId"], step.get("input") or {}, _context(step.get("context"))
                )
                steps.append({
                    "op": "invoke",
                    "outcome": r.outcome,
                    "detail": r.detail,
                    "rule": r.policy.rule,
                    "decision": _enum(r.policy.decision),
                    "risk": _enum(r.policy.risk),
                    "reason": r.policy.reason,
                    "attempts": r.attempts,
                    "verification": r.verification.to_json(),
                    "output": r.output if r.output is not None else None,
                    "hasApprovalId": bool(r.approval_id),
                })
            elif op == "evaluate":
                e = fabric.evaluate(step["capabilityId"], _context(step.get("context")))
                steps.append({
                    "op": "evaluate",
                    "value": None if e is None else {
                        "decision": _enum(e.decision), "rule": e.rule,
                        "risk": _enum(e.risk), "reason": e.reason,
                    },
                })
            elif op == "pending":
                steps.append({
                    "op": "pending",
                    "value": [
                        {
                            "state": r.state, "summary": r.summary, "rule": r.rule,
                            "target": r.target, "onAccept": r.on_accept,
                            "onDecline": r.on_decline,
                            "items": [
                                {
                                    "capabilityId": i.capability_id, "title": i.title,
                                    "detail": i.detail, "risk": _enum(i.risk),
                                    "irreversible": i.irreversible,
                                }
                                for i in r.items
                            ],
                            "missionId": r.mission_id, "taskId": r.task_id,
                            "runId": r.run_id, "workflowNodeId": r.workflow_node_id,
                        }
                        for r in fabric.pending_approvals()
                    ],
                })
            elif op == "decide":
                pending = fabric.pending_approvals()
                index = step.get("index", 0)
                target = pending[index] if index < len(pending) else None
                decided = (
                    fabric.decide_approval(
                        target.id, step["granted"], step.get("decidedBy", "user"),
                        step.get("reason"),
                    )
                    if target
                    else None
                )
                steps.append({
                    "op": "decide",
                    "value": None if decided is None else {
                        "state": decided.state, "decidedBy": decided.decided_by,
                    },
                })
            elif op == "decideById":
                decided = fabric.decide_approval(
                    step["id"], step["granted"], step.get("decidedBy", "user"),
                    step.get("reason"),
                )
                steps.append({
                    "op": "decideById",
                    "value": None if decided is None else {"state": decided.state},
                })
            elif op == "decideAndDoubleSpend":
                pending = fabric.pending_approvals()
                target = pending[0] if pending else None
                decided = (
                    fabric.decide_approval(target.id, True, "user") if target else None
                )
                first = fabric.consume_approval(decided.id) if decided else None
                second = fabric.consume_approval(decided.id) if decided else None
                steps.append({
                    "op": "decideAndDoubleSpend",
                    "firstSpend": bool(first),
                    "secondSpend": bool(second),
                })
            elif op == "consumeFirst":
                pending = fabric.pending_approvals()
                any_id = step.get("id") or (pending[0].id if pending else "nope")
                c = fabric.consume_approval(any_id)
                steps.append({
                    "op": "consumeFirst",
                    "value": None if c is None else {"consumed": bool(c.consumed_at)},
                })
            elif op == "supported":
                steps.append({"op": "supported", "value": fabric.supported()})
            elif op == "manifest":
                steps.append({
                    "op": "manifest",
                    "value": [
                        {
                            "id": c.id, "name": c.name, "category": c.category,
                            "surface": c.surface, "risk": _enum(c.risk),
                            "permissions": [_enum(p) for p in c.permissions],
                            "output": c.output, "verify": c.verify,
                            "requiresNodeCapability": c.requires_node_capability,
                            "irreversible": bool(c.irreversible),
                            "description": c.description,
                            "input": [
                                {
                                    "name": f.name, "type": f.type,
                                    "required": f.required, "description": f.description,
                                }
                                for f in c.input
                            ],
                        }
                        for c in CAPABILITY_MANIFEST
                    ],
                })
        except Exception as exc:  # noqa: BLE001 - the oracle also reports any throw
            steps.append({"op": op, "error": str(exc)})

    return {
        "name": scenario["name"],
        "steps": steps,
        "events": events,
        "audit": [
            {
                "capabilityId": r.capability_id,
                "actor": r.actor.to_json(),
                "projectId": r.project_id,
                "missionId": r.mission_id,
                "taskId": r.task_id,
                "runId": r.run_id,
                "workflowNodeId": r.workflow_node_id,
                "risk": _enum(r.risk),
                "decision": _enum(r.decision),
                "decisionRule": r.decision_rule,
                "outcome": r.outcome,
                "verified": r.verified,
                "inputSummary": r.input_summary,
                "nodeId": r.node_id,
                "requestedNodeId": r.requested_node_id,
                "executedNodeId": r.executed_node_id,
                "approvalDecision": r.approval_decision,
                "decidedBy": r.decided_by,
                "hasApprovalId": bool(r.approval_id),
            }
            for r in fabric.audit()
        ],
    }


async def run_python(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [await run_scenario(s) for s in scenarios]


def run_typescript(
    scenarios: list[dict[str, Any]], repo: Path, workdir: Path
) -> list[dict[str, Any]]:
    entry = workdir / "entry.ts"
    entry.write_text(
        f"export * from {json.dumps(str(repo / 'packages/capability-fabric/src/index.ts'))};\n",
        encoding="utf-8",
    )
    bundle = workdir / "fabric-bundle.mjs"
    build = subprocess.run(
        ["npx", "esbuild", str(entry), "--bundle", "--platform=node", "--format=esm",
         f"--outfile={bundle}"],
        cwd=repo, capture_output=True, text=True,
    )
    if build.returncode != 0:
        print(build.stderr, file=sys.stderr)
        raise SystemExit("could not bundle the TypeScript fabric; cannot claim parity")

    path = workdir / "fabric-scenarios.json"
    path.write_text(json.dumps(scenarios), encoding="utf-8")
    oracle = Path(__file__).parent / "fabric_oracle.mjs"
    proc = subprocess.run(
        ["node", str(oracle), str(bundle), str(path)],
        cwd=repo, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit("the TypeScript fabric oracle failed; cannot claim parity")
    return json.loads(proc.stdout)


def compare(ts: list[dict], py: list[dict]) -> list[str]:
    differences: list[str] = []
    for t, p in zip(ts, py):
        name = t["name"]
        if t["events"] != p["events"]:
            differences.append(
                f"{name}/events\n    TypeScript: {t['events']}\n    Python:     {p['events']}"
            )
        for i, (ts_step, py_step) in enumerate(zip(t["steps"], p["steps"])):
            if ts_step != py_step:
                differences.append(
                    f"{name}/step[{i}]\n"
                    f"    TypeScript: {json.dumps(ts_step, sort_keys=True)}\n"
                    f"    Python:     {json.dumps(py_step, sort_keys=True)}"
                )
        if len(t["steps"]) != len(p["steps"]):
            differences.append(f"{name}/steps: {len(t['steps'])} vs {len(p['steps'])}")
        for i, (ts_rec, py_rec) in enumerate(zip(t["audit"], p["audit"])):
            if ts_rec != py_rec:
                differences.append(
                    f"{name}/audit[{i}]\n"
                    f"    TypeScript: {json.dumps(ts_rec, sort_keys=True)}\n"
                    f"    Python:     {json.dumps(py_rec, sort_keys=True)}"
                )
        if len(t["audit"]) != len(p["audit"]):
            differences.append(f"{name}/audit: {len(t['audit'])} vs {len(p['audit'])} records")
    return differences


def main() -> int:
    import asyncio

    from parity.fabric_scenarios import build_scenarios

    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()

    scenarios = build_scenarios()
    with tempfile.TemporaryDirectory(prefix="fabric-parity-") as tmp:
        ts = run_typescript(scenarios, Path(args.repo), Path(tmp))
    py = asyncio.run(run_python(scenarios))

    differences = compare(ts, py)
    for d in differences:
        print(f"DIFF {d}")
    checked = sum(1 + len(s["steps"]) + len(s["audit"]) for s in ts)
    print(
        f"\n{len(scenarios) - len({d.split('/')[0] for d in differences})}"
        f"/{len(scenarios)} fabric scenarios match "
        f"({checked} compared values, {len(differences)} differences)"
    )
    return 1 if differences else 0


if __name__ == "__main__":
    raise SystemExit(main())
