"""AgentNodeRunner — faithful port of workflow/agent/{runner,loop}.ts.

Scripted-model injection replaces pipeline.generate for deterministic
verification; every tool call routes Governor→Fabric. Bounds clamp,
tool narrowing, beat ledger, honest stop reasons, approval parking and
resume-carry semantics mirror the TypeScript oracle.
"""
from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from .bounds import AGENT_CEILINGS, AGENT_DEFAULTS, resolve_bounds, resolve_tools


def _iso() -> str:

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_step(raw: str):
    cleaned = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(cleaned[start:end + 1])
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _json(v) -> str:
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


MSGS = {
    "awaiting-approval": "waiting on you",
    "denied": "policy refused a tool call",
    "max-iterations": "the agent reached its iteration bound",
    "token-budget": "the agent reached its token budget",
    "consecutive-failures": "too many tool calls failed in a row",
    "timeout": "the agent ran out of time",
    "cancelled": "the run was cancelled",
}

PORT_FOR_STOP = {
    "completed": "done", "awaiting-approval": "needs-human", "denied": "needs-human",
    "max-iterations": "failed", "timeout": "failed", "token-budget": "failed",
    "consecutive-failures": "failed", "cancelled": "failed", "failed": "failed",
}


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


class AgentRunner:
    def __init__(self, *, fabric, envelope, redact: Callable[[str], str],
                 workflow_id: str, run_id: str, project_id: str,
                 project_path: str, model: Callable | None = None,
                 actor: dict | None = None) -> None:
        self.fabric = fabric
        self.envelope = envelope or {"capabilities": []}
        self.redact = redact or (lambda t: t)
        self.workflow_id = workflow_id
        self.run_id = run_id
        self.project_id = project_id
        self.project_path = project_path
        self.actor = actor or {"kind": "agent", "id": "agent:workflow"}
        # scripted-model seam: async(prompt)->{text|final,toolCall?,tokens?,usage?}
        self.model = model

    def _supported(self, capability_id: str):
        try:
            from ...fabric import describe_capability

            return describe_capability(capability_id)
        except Exception:
            return None

    def run(self, node: dict, _ctx: dict, input: dict, opts: dict | None = None) -> dict:
        return asyncio_run(self._run(node, input, opts or {}))

    async def _run(self, node: dict, input: dict, opts: dict) -> dict:
        cfg = {**(node.get("config") or {}), "tools": (node.get("config") or {}).get("tools") or []}
        bounds = resolve_bounds(cfg)
        t0 = time.time()
        prior = ((opts.get("resumeFrom") or {}).get("resume") or {})
        deadline = t0 + max(1000, bounds["timeoutMs"] - prior.get("elapsedMs", 0))

        resolved = resolve_tools(bounds["tools"],
                                 self.envelope.get("capabilities") or [],
                                 self._supported)
        allowed_set = set(resolved["allowed"])

        beats: list[dict] = []
        evidence: list[dict] = []
        seq = [-1]

        def beat(kind, actor, text, **extra) -> int:
            seq[0] += 1
            b = {"seq": seq[0], "iteration": state["iteration"], "at": _iso(),
                 "kind": kind, "actor": actor, "text": self.redact(text), **extra}
            beats.append(b)
            hook = opts.get("onBeat")
            if hook:
                hook(dict(b))
            return b["seq"]

        # authored-task rule (runner.ts): fallback only when upstream authored
        upstream_text = (input.get("text") or "")
        provenance = input.get("provenance")
        if provenance is None or provenance == "authored":
            task = str(cfg.get("task") or "") or upstream_text
            quarantined = False
        else:
            task = str(cfg.get("task") or "") or "Summarize the material below."
            quarantined = bool(upstream_text)

        transcript = [{"role": "user", "text": b["text"]}
                      for b in (prior.get("transcript") or [])]
        tokens_used = prior.get("tokensUsed", 0)
        iteration = prior.get("iterations", 0)
        provider_calls = prior.get("providerCalls", 0)
        estimated_calls = prior.get("estimatedCalls", 0)
        consecutive_failures = 0
        output_text = ""
        stop_reason = None
        parked = None
        state = {"iteration": iteration}
        steps_state = {"count": 0}

        def finish(reason: str, message: str, **extra):
            ms = int((time.time() - t0) * 1000)
            if provider_calls and estimated_calls:
                source = "mixed"
            elif provider_calls:
                source = "provider"
            elif estimated_calls:
                source = "estimated"
            else:
                source = "estimated" if tokens_used else "provider"
            trace = {
                "beats": beats[-500:], "iterations": iteration,
                "tokensUsed": tokens_used, "ms": ms,
                "stopReason": reason, "port": PORT_FOR_STOP[reason],
                "output": extra.pop("output", ""),
                "evidence": evidence,
                "refusedTools": [{"capabilityId": r["capabilityId"], "reason": r["reason"]}
                                 for r in resolved["refused"]],
                "effectiveBounds": bounds,
                "tokenSource": source,
                "port": PORT_FOR_STOP[reason],
                "partial": False,
            }
            trace.update(extra)
            out = {"trace": trace, "parked": reason == "awaiting-approval",
                   "stopReason": reason, "text": trace["output"],
                   "summary": message, "evidence": evidence,
                   "inputProvenance": "external",
                   "taskWasQuarantined": False}
            if reason != "awaiting-approval":
                out["port"] = PORT_FOR_STOP[reason]
            if extra.get("error") is not None:
                out["error"] = extra["error"]
            if extra.get("approval") is not None:
                out["approval"] = extra["approval"]
            return out

        beat("intent", "system", task)

        if self.model is None:
            return finish("failed", '"Agent" requires a model runtime which is not attached to this run.')

        while True:
            if opts.get("signal") and opts["signal"].get("aborted"):
                return finish("cancelled", "The run was cancelled.")
            if time.time() > deadline:
                return finish("timeout", "The agent ran out of time.")
            if tokens_used >= bounds["maxTokens"]:
                return finish("token-budget", "The agent reached its token budget.")
            if consecutive_failures >= bounds["maxConsecutiveFailures"]:
                return finish("consecutive-failures",
                              f"Stopped after {consecutive_failures} tool calls in a row failed.")

            iteration += 1
            state["iteration"] = iteration
            reply = await self.model({"task": task, "input": input.get("text", ""),
                                      "transcript": transcript, "iteration": iteration})
            if isinstance(reply, str):
                reply = {"text": reply}
            reported = (reply.get("usage") or {}).get("totalTokens")
            if isinstance(reported, (int, float)):
                tokens_used += int(reported)
                provider_calls += 1
            else:
                tokens_used += (len(reply.get("text") or "")
                                + sum(len(m["text"]) for m in transcript)) // 4 + 1
                estimated_calls += 1

            step = _parse_step(reply.get("text") or json.dumps(
                {"final": reply["text"]} if reply.get("final") is not None
                else ({"tool": reply["toolCall"]} if reply.get("toolCall")
                      else {"final": reply.get("text") or ""})))
            if step is None:
                consecutive_failures += 1
                beat("observation", "system", "unparseable model step")
                if consecutive_failures >= bounds["maxConsecutiveFailures"]:
                    return finish("consecutive-failures",
                                  f"Stopped after {consecutive_failures} failed cycles.")
                continue
            if step.get("plan"):
                beat("plan", "ai", str(step["plan"]))

            if step.get("final") is not None:
                beat("decision", "ai", "Reached a final answer.")
                output = self.redact(str(step["final"]))
                beat("result", "ai", output)
                return finish("completed", f"{iteration} iterations · "
                              f"{sum(1 for e in evidence)} tool calls".replace(" 0 tool calls", "no tool calls"),
                              output=output)

            tool = step.get("tool") or {}
            capability_id = str(tool.get("name") or "")
            if not capability_id:
                consecutive_failures += 1
                continue

            call_input = tool.get("input") or {}
            beat("proposal", "ai",
                 f'{capability_id} {_json(call_input)[:400]}', capabilityId=capability_id)

            # Scope check (loop.ts:399-408): a name outside the resolved set
            # never becomes a call — it is a refusal the model can read.
            if capability_id not in allowed_set:
                consecutive_failures += 1
                reason = (f'"{capability_id}" is not one of your tools. '
                          f"You have: {', '.join(sorted(allowed_set)) or 'none'}.")
                beat("permission", "fabric", reason,
                     rule="agent-tool-scope", decision="deny",
                     capabilityId=capability_id)
                transcript.append({"role": "assistant", "text": reason})
                continue

            result = await self.fabric.invoke(capability_id, call_input, {
                "actor": self.actor, "projectId": self.project_id,
                "cwd": self.project_path, "workflowId": self.workflow_id,
                "runId": self.run_id, "workflowNodeId": node["id"]})

            performed_by = (result.get("output") or {}).get("nodeId") \
                if isinstance(result.get("output"), dict) else None
            ev = {"invocationId": result["invocationId"], "capabilityId": capability_id,
                  "outcome": result["outcome"], "decision": result["policy"]["decision"],
                  "decisionRule": result["policy"]["rule"], "risk": result["policy"]["risk"],
                  "verified": result["verification"]["passed"], "at": result["endedAt"],
                  "durationMs": result["durationMs"]}
            if result.get("approvalId"):
                ev["approvalId"] = result["approvalId"]
            if performed_by:
                ev["nodeId"] = performed_by
            evidence.append(ev)
            beat("permission", "fabric",
                 f'{result["policy"]["decision"]} — {result["policy"]["reason"]}',
                 rule=result["policy"]["rule"], decision=result["policy"]["decision"],
                 capabilityId=capability_id)

            # Park BEFORE execution/observation beats (oracle order).
            if result["outcome"] == "awaiting-approval":
                approval = {"requestId": result.get("approvalId"),
                            "capabilityId": capability_id,
                            "requestedAt": result.get("startedAt"),
                            "summary": f"the agent needs {capability_id}"}
                stop_reason = "awaiting-approval"
                parked = approval
                beat("intervention", "human",
                     f"Waiting on your authorization for {capability_id}.",
                     capabilityId=capability_id, evidence=ev)
                output_text = f"Paused: {capability_id} needs your go-ahead before the agent can continue."
                # resume payload rides the trace (AgentTrace.resume)
                self._last_resume = {
                    "transcript": transcript[-40:],
                    "pendingCall": {"capabilityId": capability_id,
                                    "input": call_input},
                    "iteration": iteration,
                    "tokensUsed": tokens_used,
                    "elapsedMs": int((time.time() - t0) * 1000),
                }
                break

            beat("execution", "fabric", result.get("detail") or "",
                 capabilityId=capability_id, evidence=ev)

            if result["outcome"] == "denied":
                stop_reason = "denied"
                output_text = self.redact(text_of(result))
                beat("decision", "ai", f"policy refused {capability_id}",
                     capabilityId=capability_id)
                break

            consecutive_failures = 0
            observation = _json(result.get("output"))
            beat("observation", "fabric", observation[:2000], untrusted=True,
                 capabilityId=capability_id)
            transcript.append({"role": "user", "text": observation[:2000]})
            if iteration >= bounds["maxIterations"]:
                stop_reason = "max-iterations"
                break

        if stop_reason is None:
            stop_reason = "max-iterations" if iteration >= bounds["maxIterations"] else "failed"
        if stop_reason != "completed":
            beat("result", "ai", self.redact(output_text))
        approval_extra = {"approval": parked} if parked else {}
        resume_extra = {}
        if parked:
            resume_extra = {"resume": getattr(self, "_last_resume", None)}
        return finish(stop_reason,
                      MSGS.get(stop_reason, stop_reason),
                      approval=approval_extra.get("approval") if isinstance(approval_extra, dict) else None,
                      resume=None,
                      error=None)

def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


def create_agent_runner(**deps) -> AgentRunner:
    return AgentRunner(**deps)


_ = Any, AGENT_CEILINGS, AGENT_DEFAULTS, re
