"""NodeGovernor — port of governor.ts: the engine's ONE door to the Fabric."""
from __future__ import annotations

import re
from typing import Any, Callable

from .nodes_core import bindings

MAX_OUTPUT_TEXT = 60_000
_SECRET_REF = re.compile(r"\{\{\s*secret:([\w.-]+)\s*\}\}")


def text_of(result: dict) -> str:
    out = result.get("output")
    if isinstance(out, str):
        return out
    if isinstance(out, dict):
        if isinstance(out.get("stdout"), str):
            return out["stdout"]
        if isinstance(out.get("text"), str):
            return out["text"]
    return result.get("detail") or ""


def evidence_of(result: dict, node_id: str | None = None) -> dict:
    ev = {
        "invocationId": result["invocationId"],
        "capabilityId": result["capabilityId"],
        "outcome": result["outcome"],
        "decision": result["policy"]["decision"],
        "decisionRule": result["policy"]["rule"],
        "risk": result["policy"]["risk"],
        "verified": result["verification"]["passed"],
        "at": result["endedAt"],
        "durationMs": result["durationMs"],
    }
    if result.get("approvalId"):
        ev["approvalId"] = result["approvalId"]
    if node_id:
        ev["nodeId"] = node_id
    return ev


class NodeGovernor:
    def __init__(self, fabric, secrets, *, workflow_id, run_id, project_id,
                 project_path, actor, approved_capabilities=None, timeout_ms=None) -> None:
        self.fabric = fabric
        self.workflow_id = workflow_id
        self.run_id = run_id
        self.project_id = project_id
        self.project_path = project_path
        self.actor = actor
        self.approved_capabilities = approved_capabilities
        self.timeout_ms = timeout_ms
        self._bindings = bindings()
        known = list(getattr(secrets, "known_values", lambda: [])())
        self._known = known

    def redact(self, text: str) -> str:
        for v in self._known:
            if v:
                text = text.replace(v, "<redacted>")
        return text

    async def run(self, node: dict, ctx: dict, input: dict,
                  interpolate: Callable[[str], str]) -> dict:
        planner = self._bindings.get(node["type"])
        if not planner:
            return {"kind": "failed", "text": "", "summary": "not governed",
                    "error": f'"{node["type"]}" is classified as a governed node but has no capability binding, so nothing was run.'}
        try:
            plan = planner(ctx, input, dict(node.get("config") or {}), interpolate)
        except Exception as e:  # noqa: BLE001
            return {"kind": "failed", "text": "", "summary": "misconfigured",
                    "error": self.redact(str(e))}
        if plan is None:
            return {"kind": "no-effect", "text": input.get("text") or "", "summary": "nothing to do"}

        resolved_input: dict[str, Any] = {}
        try:
            for k, v in (plan.get("input") or {}).items():
                if isinstance(v, str):
                    resolved_input[k] = self._resolve_secret(v)
                elif isinstance(v, dict):
                    resolved_input[k] = {hk: self._resolve_secret(hv) if isinstance(hv, str) else hv
                                         for hk, hv in v.items()}
                else:
                    resolved_input[k] = v
        except Exception as e:  # noqa: BLE001
            return {"kind": "failed", "text": "", "summary": "missing secret",
                    "error": self.redact(str(e))}

        result = await self.fabric.invoke(plan["capabilityId"], resolved_input, {
            "actor": self.actor,
            "projectId": self.project_id,
            "cwd": self.project_path,
            "workflowId": self.workflow_id,
            "runId": self.run_id,
            "workflowNodeId": node["id"],
            **({"approvedCapabilities": self.approved_capabilities}
               if self.approved_capabilities else {}),
            **({"timeoutMs": self.timeout_ms} if self.timeout_ms else {}),
        })

        performed_by = result.get("output", {}).get("nodeId") if isinstance(result.get("output"), dict) else None
        evidence = evidence_of(result, performed_by if isinstance(performed_by, str) else None)
        raw = text_of(result)
        text = self.redact(raw if len(raw) <= MAX_OUTPUT_TEXT else raw[:MAX_OUTPUT_TEXT] + "\n…(truncated)")

        outcome = result["outcome"]
        if outcome == "succeeded":
            shaped = plan.get("shape")(text) if plan.get("shape") else None
            return {"kind": "succeeded",
                    "text": shaped["text"] if shaped and "text" in shaped else text,
                    "data": shaped.get("data") if shaped and "data" in shaped else result.get("output"),
                    "files": shaped.get("files") if shaped else None,
                    "summary": self.redact(shaped["summary"] if shaped and shaped.get("summary") else plan["describe"]),
                    "evidence": evidence}
        if outcome == "unverified":
            return {"kind": "failed", "text": text, "summary": "unverified",
                    "error": self.redact(result.get("detail") or ""), "evidence": evidence}
        if outcome == "denied":
            return {"kind": "denied", "text": "",
                    "summary": f"denied · {result['policy']['rule']}",
                    "error": self.redact(result.get("detail") or ""), "evidence": evidence}
        if outcome == "awaiting-approval":
            approval = None
            if result.get("approvalId"):
                approval = {"requestId": result["approvalId"],
                            "capabilityId": plan["capabilityId"],
                            "requestedAt": result["startedAt"],
                            "summary": self.redact(plan["describe"])}
            return {"kind": "awaiting-approval", "text": "", "summary": "waiting on you",
                    "evidence": evidence, "approval": approval}
        if outcome == "unsupported":
            return {"kind": "failed", "text": "", "summary": "not supported",
                    "error": self.redact(result.get("detail") or ""), "evidence": evidence}
        return {"kind": "failed", "text": text, "summary": "failed",
                "error": self.redact(result.get("detail") or ""), "evidence": evidence}

    def _resolve_secret(self, template: str) -> str:
        """Resolve {{secret:NAME}} via the injected secrets store."""
        store_resolve = getattr(self, "_resolve_one", None)

        def repl(m):
            if store_resolve:
                return store_resolve(m.group(1))
            raise RuntimeError(f'secret "{m.group(1)}" is not configured')

        return _SECRET_REF.sub(repl, template)


def create_governor(**deps) -> NodeGovernor:
    return NodeGovernor(**deps)
