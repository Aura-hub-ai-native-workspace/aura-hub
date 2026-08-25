"""AgentNodeRunner — scripted-model-first port of workflow/agent/runner.ts.

The engine's agent-node branch calls `run(node, ctx, input, hooks)`.
Model calls go through an injected `model` callable (deterministic in
tests; a real provider adapter arrives with the providers phase — real
provider execution is NOT VERIFIED here). Every tool call goes through
the injected governor→Fabric path; there is no other effect route.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Callable

from .bounds import resolve_bounds


class AgentRunner:
    def __init__(self, *, fabric, envelope, redact: Callable[[str], str],
                 workflow_id: str, run_id: str, project_id: str,
                 project_path: str, model: Callable | None = None,
                 actor: dict | None = None) -> None:
        self.fabric = fabric
        self.envelope = envelope
        self.redact = redact
        self.workflow_id = workflow_id
        self.run_id = run_id
        self.project_id = project_id
        self.project_path = project_path
        self.actor = actor or {"kind": "agent", "id": "agent:workflow"}
        self.model = model

    def _tools(self, requested: list[str]):
        from ...fabric import describe_capability
        from .bounds import resolve_tools

        def supported(capability_id):
            return describe_capability(capability_id)

        resolved = resolve_tools(requested or [], self.envelope.get("capabilities") or [], supported)
        return set(resolved["allowed"]), resolved

    async def run(self, node: dict, ctx: dict, input: dict, hooks: dict) -> dict:
        cfg = node.get("config") or {}
        bounds = resolve_bounds(cfg)
        effective = {**bounds}
        allowed, resolution = self._tools(bounds["tools"])
        evidence: list[dict] = []
        beats: list[dict] = []
        tokens_used = 0
        consecutive_failures = 0
        parked = None
        t0 = time.time()
        deadline = t0 + bounds["timeoutMs"] / 1000

        task = (ctx.get("interpolate") or (lambda t: t))(str(cfg.get("task") or "")) \
            if ctx.get("interpolate") else str(cfg.get("task") or "")
        transcript = list((hooks.get("resumeFrom") or {}).get("resume", {}).get("transcript") or [])
        iteration = 0
        stop_reason = None
        output_text = ""

        on_beat = hooks.get("onBeat")

        def beat(kind, text, **extra):
            nonlocal tokens_used
            b = {"seq": len(beats) + 1, "iteration": iteration, "at": _iso(),
                 "kind": kind, "actor": extra.pop("actor", "ai"), "text": text, **extra}
            beats.append(b)
            if on_beat:
                on_beat(dict(b))
            return b

        while iteration < effective["maxIterations"]:
            iteration += 1
            if hooks.get("signal") and hooks["signal"].get("aborted"):
                stop_reason = "cancelled"
                break
            if time.time() > deadline:
                stop_reason = "timeout"
                break
            if tokens_used >= effective["maxTokens"]:
                stop_reason = "token-budget"
                break

            # one cycle = one model call (+ at most one tool call)
            model_response = None
            if self.model is not None:
                try:
                    model_response = await _maybe_await(self.model(
                        {"task": task, "input": input.get("text", ""),
                         "transcript": transcript, "iteration": iteration,
                         "allowedTools": sorted(allowed)}))
                except Exception as e:  # noqa: BLE001 — malformed model output fails closed
                    consecutive_failures += 1
                    beat("observation", f"model error: {e}", untrusted=True, actor="system")
                    if consecutive_failures >= effective["maxConsecutiveFailures"]:
                        stop_reason = "consecutive-failures"
                        break
                    continue
            else:
                stop_reason = "failed"
                break

            if not isinstance(model_response, dict):
                consecutive_failures += 1
                continue

            tokens_used += int(model_response.get("tokens") or 0)
            transcript.append({"role": "assistant",
                               "text": str(model_response.get("text") or "")[:4000]})

            tool_call = model_response.get("toolCall")
            if tool_call:
                capability_id = str(tool_call.get("capabilityId") or "")
                if capability_id not in allowed:
                    stop_reason = "denied"
                    beat("permission", f"tool outside allowlist: {capability_id}",
                         rule="tool-allowlist", decision="deny")
                    break
                beat("proposal", f"{capability_id}", capabilityId=capability_id)
                invoke_result = await self.fabric.invoke(
                    capability_id, tool_call.get("input") or {},
                    {"actor": self.actor, "projectId": self.project_id,
                     "cwd": self.project_path,
                     "workflowId": self.workflow_id, "runId": self.run_id,
                     "workflowNodeId": node["id"]})
                ev = {
                    "invocationId": invoke_result["invocationId"],
                    "capabilityId": capability_id,
                    "outcome": invoke_result["outcome"],
                    "decision": invoke_result["policy"]["decision"],
                    "decisionRule": invoke_result["policy"]["rule"],
                    "risk": invoke_result["policy"]["risk"],
                    "verified": invoke_result["verification"]["passed"],
                    **({"approvalId": invoke_result["approvalId"]}
                       if invoke_result.get("approvalId") else {}),
                    "at": invoke_result["endedAt"], "durationMs": invoke_result["durationMs"],
                }
                evidence.append(ev)
                beat("execution", invoke_result.get("detail") or "",
                     capabilityId=capability_id, evidence=ev)

                if invoke_result["outcome"] == "awaiting-approval":
                    approval = {"requestId": invoke_result["approvalId"],
                                "capabilityId": capability_id}
                    stop_reason = "awaiting-approval"
                    parked = approval
                    break
                if invoke_result["outcome"] == "denied":
                    stop_reason = "denied"
                    break
                observation = json_dump(invoke_result.get("output"))
                beat("observation", observation[:2000], untrusted=True)
                transcript.append({"role": "user", "text": observation[:2000]})

            if model_response.get("final"):
                output_text = str(model_response.get("text") or "")
                stop_reason = "completed"
                break
            if consecutive_failures >= effective["maxConsecutiveFailures"]:
                stop_reason = "consecutive-failures"
                break
            await asyncio.sleep(0)

        if stop_reason is None and iteration >= effective["maxIterations"]:
            stop_reason = "max-iterations"

        port = PORT_FOR_STOP.get(stop_reason or "failed", "failed")
        summary = {
            "completed": "agent completed",
            "awaiting-approval": "waiting on your authorization",
            "denied": "policy refused the tool call",
        }.get(stop_reason or "", f"agent stopped ({stop_reason})")

        ms = int((time.time() - t0) * 1000)
        trace = {
            "beats": beats[-500:],
            "iterations": iteration,
            "tokensUsed": tokens_used,
            "ms": ms,
            "stopReason": stop_reason or "failed",
            "port": port,
            "output": self.redact(output_text),
            "evidence": evidence,
            "refusedTools": [{"capabilityId": r["capabilityId"], "reason": r["reason"]}
                             for r in resolution["refused"]],
            "effectiveBounds": effective,
            "tokenSource": "estimated" if tokens_used else "provider",
        }
        if stop_reason == "awaiting-approval":
            trace["approval"] = parked
        return {
            "trace": trace, "parked": stop_reason == "awaiting-approval",
            "port": port, "stopReason": stop_reason or "failed",
            "text": self.redact(output_text), "summary": summary,
            "evidence": evidence,
        }


PORT_FOR_STOP = {
    "completed": "done", "awaiting-approval": "needs-human", "denied": "needs-human",
    "max-iterations": "failed", "timeout": "failed", "token-budget": "failed",
    "consecutive-failures": "failed", "cancelled": "failed", "failed": "failed",
}


async def _maybe_await(v):
    import inspect

    if inspect.isawaitable(v):
        return await v
    return v


def json_dump(v) -> str:
    import json

    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


def _iso():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_agent_runner(**deps) -> AgentRunner:
    return AgentRunner(**deps)
