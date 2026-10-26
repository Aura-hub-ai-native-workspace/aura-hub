"""Capability Fabric core — behavior-preserving port of fabric.ts (878 lines).

THE one governed path by which anything causes a side effect:
  resolve → policy → execute → verify → recover → audit

Phase-4 scope: everything except node ROUTING (resolveNode stays absent —
connected-environment lands in Phase 5). The manifest catalogue comes from
manifest.json, generated from the TypeScript source (regeneration test in
tests/fabric keeps it honest).
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from ..policy import grants_for

MAX_ATTEMPTS = 3
BASE_BACKOFF_MS = 400


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


async def _real_sleep(_ms: float) -> None:
    await asyncio.sleep(_ms / 1000)


def _is_transient(detail: str) -> bool:
    return bool(re.search(
        r"\b(timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|429|503|temporarily)\b",
        detail,
        re.IGNORECASE,
    ))


def _load_manifest() -> list[dict]:
    import json
    from pathlib import Path

    f = Path(__file__).parent / "manifest.json"
    return json.loads(f.read_text(encoding="utf-8"))["capabilities"]


MANIFEST: list[dict] = _load_manifest()
_BY_ID = {c["id"]: c for c in MANIFEST}


def describe_capability(capability_id: str) -> dict | None:
    return _BY_ID.get(capability_id)


def describe_fabric_capability(capability_id: str) -> dict | None:
    """TS-parity alias."""
    return describe_capability(capability_id)


# ── input summary / target / validation (fabric.ts:146–192) ─────────────────


def summarize_input(capability: dict, input: dict[str, Any]) -> str:
    secret = re.compile(r"^(apiKey|token|secret|password)$", re.IGNORECASE)
    parts: list[str] = []
    for field in capability.get("input") or []:
        raw = input.get(field["name"])
        if raw is None:
            continue
        if secret.match(field["name"]):
            parts.append(f"{field['name']}=<redacted>")
            continue
        # JS String() semantics for primitives; objects stringify differently
        # but contract fields are scalars — mirror the scalar cases exactly.
        if isinstance(raw, bool):
            text = "true" if raw else "false"
        elif isinstance(raw, str):
            text = raw
        elif isinstance(raw, (int, float)):
            text = repr(raw) if isinstance(raw, float) and not float(raw).is_integer() else str(int(raw)) if isinstance(raw, float) else str(raw)
        else:
            text = str(raw)
        parts.append(f"{field['name']}={text[:57] + '…' if len(text) > 60 else text}")
    return " ".join(parts) or "(no arguments)"


def describe_target(capability: dict, input: dict[str, Any]) -> str | None:
    for key in ("path", "url", "command", "name", "branch", "message", "projectId"):
        value = input.get(key)
        if isinstance(value, str) and value.strip():
            return value[:77] + "…" if len(value) > 80 else value
    return "AURA Hub" if capability.get("surface") == "aura-internal" else None


def validate_contract(capability: dict, input: dict[str, Any]) -> str | None:
    """JS typeof semantics: arrays are 'string[]', null skips like undefined."""
    js_typeof = {
        type(None): "null", bool: "boolean", int: "number", float: "number", str: "string",
    }
    for field in capability.get("input") or []:
        name = field["name"]
        value = input.get(name)
        if value is None or value == "":
            if field.get("required"):
                return f"{name} is required."
            continue
        actual = "string[]" if isinstance(value, list) else js_typeof.get(type(value), "object")
        expected = field.get("type")
        if (expected == "string[]" and actual != "string[]") or (expected != "string[]" and actual != expected):
            return f"{name} should be a {expected}, got {actual}."
    return None


NO_VERIFICATION = {
    "passed": None,
    "kind": None,
    "detail": "This action has no mechanical check, so success is reported from the executor alone.",
}


def invocation_id(clock_ms: Callable[[], int], seq_box: list[int]) -> str:
    seq_box[0] += 1
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    n = int(clock_ms())
    b36 = ""
    while n:
        n, r = divmod(n, 36)
        b36 = digits[r] + b36
    return f"inv{b36}{seq_box[0]}"


# ── hosts ────────────────────────────────────────────────────────────────────


def _as_descriptor(cap: dict | Any) -> Any:
    """Manifest dicts → policy-engine descriptor (attribute access parity)."""
    from ..policy import CapabilityDescriptor

    if isinstance(cap, CapabilityDescriptor):
        return cap
    return CapabilityDescriptor(
        id=cap["id"], name=cap["name"], risk=cap["risk"],
        permissions=list(cap.get("permissions") or []),
        irreversible=cap.get("irreversible"),
    )



class FabricHost:
    """Duck-typed host. resolveNode intentionally ABSENT until Phase 5."""

    def permissions_for(self, capability: dict, context: dict) -> dict[str, bool]:
        raise NotImplementedError

    def node_available(self, capability: dict) -> bool | None:
        return True

# ── the fabric ───────────────────────────────────────────────────────────────


class CapabilityFabric:
    def __init__(
        self,
        host: FabricHost,
        *,
        clock_ms: Callable[[], int] = _now_ms,
        clock_iso: Callable[[], str] = _now_iso,
        sleep: Callable[[float], Any] = _real_sleep,
    ) -> None:
        self.host = host
        self.executors: dict[str, Any] = {}
        self.listeners: list[Callable[[dict], None]] = []
        self.audit_log: list[dict] = []
        from ..policy.engine import DEFAULT_POLICY as _DEFAULT_POLICY

        # The one shipped default (routine work runs; floors still stop).
        self.policy: dict = {"byRisk": dict(_DEFAULT_POLICY["byRisk"]),
                             "overrides": {}, "nodeOverrides": {}, "nodeAllowlists": {},
                             "allowAutonomous": True}
        self._audit_store_append: Callable | None = None
        self._clock_ms = clock_ms
        self._clock_iso = clock_iso
        self._sleep = sleep
        self._seq = [0]

    # wiring ------------------------------------------------------------------

    def register(self, executor: Any) -> None:
        if executor.capabilityId in _BY_ID:
            native = _BY_ID[executor.capabilityId]
            if hasattr(executor, 'descriptor') and executor.descriptor:
                raise ValueError(
                    f'Cannot register escalated capability "{executor.capabilityId}": '
                    f"native capability has risk={native.get('risk')}, "
                    "and may not be overridden by agent-registered descriptors."
                )
        self.executors[executor.capabilityId] = executor
        if hasattr(executor, 'descriptor') and executor.descriptor:
            _BY_ID[executor.capabilityId] = executor.descriptor

    def listen(self, fn: Callable[[dict], None]) -> None:
        self.listeners.append(fn)

    def attach_audit_store(self, load: Callable[[], list], append: Callable[[dict], None]) -> None:
        """EVERYTHING restores for audit — forgetting would be wrong, not cautious."""
        self._audit_store_append = append
        self.audit_log = [*load(), *self.audit_log]

    def _record(self, entry: dict) -> None:
        self.audit_log.append(entry)
        try:
            if self._audit_store_append:
                self._audit_store_append(entry)
        except Exception as exc:
            # Never fail an action on a logging failure — but never lose
            # it silently either. The in-memory log keeps the record and
            # the entry is marked, so a degraded journal is visible to
            # operators instead of a gap nobody can explain.
            entry["auditPersisted"] = False
            entry["auditError"] = str(exc)[:200]
            try:
                self._emit({"type": "audit.persist-failed",
                            "at": entry.get("at"),
                            "invocationId": entry.get("invocationId"),
                            "error": str(exc)[:200]})
            except Exception:
                pass

    def _emit(self, event: dict) -> None:
        for fn in list(self.listeners):
            fn(event)

    # policy ------------------------------------------------------------------

    def set_policy(self, policy: dict) -> None:
        self.policy = policy

    # pre-flight ----------------------------------------------------------------

    def _resolve(self, capability: dict, context: dict, can_use=None) -> dict:
        if getattr(self.host, "resolve_node", None) is None:
            return {"ok": True}
        return self.host.resolve_node(capability, context, can_use)

    def evaluate(self, capability_id: str, context: dict) -> dict | None:
        capability = describe_capability(capability_id)
        if not capability:
            return None
        resolution = self._resolve(capability, context)
        if isinstance(resolution, dict) and resolution.get("ok") is False:
            return {"decision": "deny", "rule": resolution["code"],
                    "risk": capability["risk"], "reason": resolution["reason"]}
        if getattr(self.host, "resolve_node", None) is not None:
            available = bool(resolution.get("node")) if capability.get("requiresNodeCapability") else None
        else:
            available = self.host.node_available(capability)
        from ..policy import PolicyInput, PolicySubject, evaluate_policy

        subj = self._subject_for({}, resolution.get("node"))
        return evaluate_policy(PolicyInput(
            capability=_as_descriptor(capability),
            config=self.policy,
            granted=grants_for(self.host.permissions_for(capability, context)),
            nodeAvailable=available,
            subject=PolicySubject(
                node=subj.get("node"),
                requestedNodeId=subj.get("requestedNodeId"),
                actorKind=subj.get("actorKind"),
                actorId=subj.get("actorId"),
                projectId=subj.get("projectId"),
                missionId=subj.get("missionId"),
                taskId=subj.get("taskId"),
            ),
        ))

    # the ONE path --------------------------------------------------------------

    async def invoke(self, capability_id: str, input: dict[str, Any], context: dict) -> dict:
        started_at = self._clock_iso()
        started = self._clock_ms()
        invocation: dict[str, Any] = {
            "id": invocation_id(self._clock_ms, self._seq),
            "capabilityId": capability_id,
            "input": input,
            "context": context,
            "requestedAt": started_at,
        }

        capability = describe_capability(capability_id)
        if not capability:
            return self._settle(
                invocation, capability, "failed",
                f'No capability is registered under "{capability_id}".',
                dict(NO_VERIFICATION),
                {"decision": "deny", "rule": "unknown-capability", "risk": "low",
                 "reason": "The Fabric does not know this capability."},
                started, started_at, 1)

        self._emit({"type": "invocation.requested", "at": started_at, "invocation": invocation})

        # 1. contract
        invalid = validate_contract(capability, input)
        if invalid:
            return self._settle(
                invocation, capability, "failed",
                f"{invalid} Correct the argument and call it again.",
                dict(NO_VERIFICATION),
                {"decision": "deny", "rule": "invalid-input", "risk": capability["risk"],
                 "reason": invalid},
                started, started_at, 1)

        # 2. routing — which node, BEFORE anything is decided about it.
        routing_executor = self.executors.get(capability_id)
        can_use = (lambda node: routing_executor.supportsNode(node)) if (
            routing_executor is not None and hasattr(routing_executor, "supportsNode")) else None
        resolution = self._resolve(capability, context, can_use)
        if isinstance(resolution, dict) and resolution.get("ok") is False:
            self._emit({"type": "invocation.denied", "at": self._clock_iso(),
                        "invocationId": invocation["id"], "reason": resolution["reason"]})
            return self._settle(invocation, capability, "denied", resolution["reason"],
                                dict(NO_VERIFICATION),
                                {"decision": "deny", "rule": resolution["code"],
                                 "risk": capability["risk"], "reason": resolution["reason"]},
                                started, started_at, 0)
        # The executor is handed its node; it discovers nothing itself.
        if resolution.get("node") is not None:
            invocation["node"] = resolution["node"]

        # 3. policy
        from ..policy import PolicyInput, PolicySubject, evaluate_policy

        subj = self._subject_for(invocation, resolution.get("node"))
        evaluation = evaluate_policy(PolicyInput(
            capability=_as_descriptor(capability),
            config=self.policy,
            granted=grants_for(self.host.permissions_for(capability, context)),
            # With a router, availability derives from the RESOLUTION
            # (fabric.ts:541-543) so the boolean floor and routing can never
            # disagree; without one, the host answers directly.
            nodeAvailable=(bool(resolution.get("node")) if capability.get("requiresNodeCapability")
                           else None) if getattr(self.host, "resolve_node", None) is not None
                          else self.host.node_available(capability),
            subject=PolicySubject(
                node=subj.get("node"),
                requestedNodeId=subj.get("requestedNodeId"),
                actorKind=subj.get("actorKind"),
                actorId=subj.get("actorId"),
                projectId=subj.get("projectId"),
                missionId=subj.get("missionId"),
                taskId=subj.get("taskId"),
            ),
        ))

        if evaluation["decision"] == "deny":
            self._emit({"type": "invocation.denied", "at": self._clock_iso(),
                        "invocationId": invocation["id"], "reason": evaluation["reason"]})
            return self._settle(invocation, capability, "denied", evaluation["reason"],
                                dict(NO_VERIFICATION), evaluation, started, started_at, 0)

        # 4. no approval gate. The policy decision is final: anything that is not
        # auto-execute was refused in step 3 (require-approval is refused there,
        # never parked). This branch only guards against a future decision value.
        if evaluation["decision"] != "auto-execute":
            return self._settle(invocation, capability, "denied", evaluation["reason"],
                                dict(NO_VERIFICATION), evaluation, started, started_at, 0)

        # 5. execute with bounded recovery
        executor = self.executors.get(capability_id)
        if not executor:
            return self._settle(
                invocation, capability, "unsupported",
                f"{capability['name']} is planned for but has no executor yet, so nothing was run. {capability['description']}",
                dict(NO_VERIFICATION), evaluation, started, started_at, 0)

        self._emit({"type": "invocation.started", "at": self._clock_iso(),
                    "invocationId": invocation["id"], "capabilityId": capability_id})

        attempts = 0
        last: dict[str, Any] = {"ok": False, "detail": "Not attempted."}
        while attempts < MAX_ATTEMPTS:
            attempts += 1
            try:
                last = await executor.run(invocation)
            except Exception as e:  # noqa: BLE001 — TS catches everything too
                last = {"ok": False, "detail": str(e) or "The executor threw with no message."}
            if last.get("ok"):
                break
            if attempts >= MAX_ATTEMPTS or not _is_transient(last.get("detail", "")):
                break
            self._emit({"type": "invocation.retrying", "at": self._clock_iso(),
                        "invocationId": invocation["id"], "attempt": attempts + 1,
                        "reason": last.get("detail", "")})
            await self._sleep(BASE_BACKOFF_MS * 2 ** (attempts - 1))

        if not last.get("ok"):
            tried = "" if attempts == 1 else f" after {attempts} attempts"
            return self._settle(
                invocation, capability, "failed",
                f"{capability['name']} did not succeed{tried}. {last.get('detail', '')}",
                dict(NO_VERIFICATION), evaluation, started, started_at, attempts,
                last.get("output"))

        # 6. verify
        verification = dict(NO_VERIFICATION)
        if capability.get("verify") and getattr(executor, "verify", None):
            try:
                verification = await executor.verify(invocation, last)
            except Exception as e:  # noqa: BLE001
                verification = {"passed": False, "kind": capability.get("verify"),
                                "detail": f"The check itself could not run: {e}"}
            self._emit({"type": "verification.passed" if verification.get("passed")
                        else "verification.failed",
                        "at": self._clock_iso(), "invocationId": invocation["id"],
                        "detail": verification.get("detail", "")})
        elif capability.get("verify"):
            verification = {"passed": None, "kind": capability.get("verify"),
                            "detail": "This capability declares a check, but its executor does not implement one yet."}

        outcome = "unverified" if verification.get("passed") is False else "succeeded"
        detail = (f"{capability['name']} ran, but the check did not confirm it. {verification.get('detail', '')}"
                  if outcome == "unverified" else
                  f"{capability['name']} completed. {last.get('detail', '')}")

        return self._settle(invocation, capability, outcome, detail, verification,
                            evaluation, started, started_at, attempts, last.get("output"))

    # audit assembly --------------------------------------------------------------

    def _subject_for(self, invocation: dict, node: dict | None) -> dict:
        ctx = invocation.get("context") or {}
        return {
            **({"node": {"id": node["id"], "name": node["name"]}} if node else {}),
            "requestedNodeId": ctx.get("nodeId"),
            "actorKind": (ctx.get("actor") or {}).get("kind"),
            "actorId": (ctx.get("actor") or {}).get("id"),
            "projectId": ctx.get("projectId"),
            "missionId": ctx.get("missionId"),
            "taskId": ctx.get("taskId"),
        }

    def _node_id_of_output(self, output: Any) -> str | None:
        nid = output.get("nodeId") if isinstance(output, dict) else None
        return nid if isinstance(nid, str) and nid else None

    def _executed_node_id(self, invocation: dict, capability: dict | None,
                          attempts: int, output: Any) -> str | None:
        if not capability or not capability.get("requiresNodeCapability"):
            return None
        return self._node_id_of_output(output) or (
            invocation.get("node", {}).get("id") if attempts > 0 and invocation.get("node") else None
        )

    def _settle(self, invocation, capability, outcome, detail, verification, policy_eval,
                started: int, started_at: str, attempts: int,
                output: Any = None) -> dict:
        ended_at = self._clock_iso()
        duration_ms = self._clock_ms() - started

        result: dict[str, Any] = {
            "invocationId": invocation["id"],
            "capabilityId": invocation["capabilityId"],
            "outcome": outcome,
            "detail": detail,
            # JS parity: `output: undefined` DROPS the key under
            # JSON.stringify; explicit values (including executor-provided
            # null) stay. Python None plays the undefined role here.
            "verification": verification,
            "policy": policy_eval,
            "startedAt": started_at,
            "endedAt": ended_at,
            "durationMs": duration_ms,
            "attempts": attempts,
        }
        if output is not None:
            result["output"] = output

        executed_node = self._executed_node_id(invocation, capability, attempts, output)
        record: dict[str, Any] = {
            "invocationId": invocation["id"],
            "at": ended_at,
            "capabilityId": invocation["capabilityId"],
            "actor": invocation["context"].get("actor"),
            "projectId": invocation["context"].get("projectId"),
            **({"missionId": invocation["context"]["missionId"]} if invocation["context"].get("missionId") else {}),
            **({"taskId": invocation["context"]["taskId"]} if invocation["context"].get("taskId") else {}),
            **({"sessionId": invocation["context"]["sessionId"]} if invocation["context"].get("sessionId") else {}),
            **({"requestId": invocation["context"]["requestId"]} if invocation["context"].get("requestId") else {}),
            **({"workflowId": invocation["context"]["workflowId"]} if invocation["context"].get("workflowId") else {}),
            **({"runId": invocation["context"]["runId"]} if invocation["context"].get("runId") else {}),
            **({"workflowNodeId": invocation["context"]["workflowNodeId"]} if invocation["context"].get("workflowNodeId") else {}),
            "risk": policy_eval["risk"],
            "decision": policy_eval["decision"],
            "decisionRule": policy_eval["rule"],
            "outcome": outcome,
            "verified": verification.get("passed"),
            "durationMs": duration_ms,
            "inputSummary": summarize_input(capability, invocation["input"]) if capability else "(unknown capability)",
        }
        if invocation["context"].get("nodeId") is not None:
            record["requestedNodeId"] = invocation["context"]["nodeId"]
        if executed_node is not None:
            record["nodeId"] = executed_node
            record["executedNodeId"] = executed_node

        self._record(record)
        # A journal write this _record could not persist is marked on the
        # record itself; mirror it here so callers never assert an audit
        # trail that is not there. Absent when healthy, so exact-shape
        # differential assertions are unaffected.
        if record.get("auditPersisted") is False:
            result["auditDegraded"] = True
            result["auditError"] = record.get("auditError")
        self._emit({"type": "invocation.completed", "at": ended_at, "result": result})
        return result


# ── central-agent seam ───────────────────────────────────────────────────────
# Thin views over THIS canonical fabric so the already-implemented
# `aura.central_agent` service (which predates the CapabilityFabric port)
# runs unmodified on the ONE governed execution path. Every function here
# delegates; none re-implements policy, execution or audit.


class FabricConfig:
    """Dependency bundle for the agent seam. `.fabric` is the live
    CapabilityFabric — the same instance the workflow runner drives."""

    def __init__(self, *, fabric: "CapabilityFabric | None" = None,
                 policy_config: dict | None = None,
                 permissions: dict[str, bool] | None = None,
                 executors: dict | None = None,
                 audit_store=None,
                 ledger=None,
                 secrets=None) -> None:
        self.secrets = secrets
        self.fabric = fabric
        self.policy_config = policy_config or {}
        self.permissions = permissions or {"read": True, "write": True}
        self.executors = executors or {}
        self.audit_store = audit_store
        self.ledger = ledger

    def sanitized_policy(self) -> dict:
        import copy

        from ..policy.engine import DEFAULT_POLICY as _DEFAULT_POLICY

        base = self.fabric.policy if self.fabric is not None else {
            "byRisk": dict(_DEFAULT_POLICY["byRisk"]),
            "overrides": {}, "nodeOverrides": {}, "nodeAllowlists": {},
            "allowAutonomous": True,
        }
        merged = copy.deepcopy(base)
        for k, v in (self.policy_config or {}).items():
            if isinstance(v, dict) and isinstance(merged.get(k), dict):
                merged[k].update(v)
            else:
                merged[k] = v
        return merged


def _run_sync(coro) -> dict:
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        # Called from sync code inside a running loop (agent thread): run in
        # a private loop on a worker thread to avoid nested-loop errors.
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(lambda: asyncio.run(coro)).result()
    return asyncio.run(coro)


def invoke_fabric(capability_id: str, input: dict, context: dict,
                  cfg: FabricConfig) -> dict:
    """Synchronous governed invoke through the canonical fabric."""
    if cfg.fabric is None:
        raise RuntimeError("no CapabilityFabric wired into FabricConfig")
    return _run_sync(cfg.fabric.invoke(capability_id, input, context))


def describe_authority(capability_id: str, context: dict,
                       cfg: FabricConfig) -> dict | None:
    """Read-only policy preflight (what invoke WOULD decide)."""
    capability = describe_capability(capability_id)
    if not capability:
        return None
    from ..policy import PolicyInput, PolicySubject, evaluate_policy, grants_for

    host = cfg.fabric.host if cfg.fabric is not None else None
    granted = grants_for(host.permissions_for(capability, context)) if host else grants_for(cfg.permissions)
    node_available: bool | None
    if capability.get("requiresNodeCapability") is not None:
        node_available = bool(host.node_available(capability)) if host else True
    else:
        node_available = None
    return evaluate_policy(PolicyInput(
        capability=_as_descriptor(capability),
        config=cfg.sanitized_policy(),
        granted=granted,
        nodeAvailable=node_available,
        subject=PolicySubject(
            actorKind=(context.get("actor") or {}).get("kind"),
            actorId=(context.get("actor") or {}).get("id"),
            projectId=context.get("projectId"),
            taskId=context.get("taskId"),
        ),
    ))


def builtin_executors(home=None, kb=None) -> dict:
    """The canonical executor set, keyed by capability id.

    Includes the four multimodal capabilities (knowledge.search,
    document.ingest, artifact.generate, sandbox.execute) when a
    KnowledgeBase is available.  If ``kb`` is None and ``home`` is set,
    a default KnowledgeBase rooted at ``home/knowledge`` is created.
    Pass ``kb=False`` to skip multimodal registration entirely (tests
    that do not need KB can avoid the import).
    """
    from ..executors import all_executors, multimodal_executors, register_canonical_internal_capabilities
    register_canonical_internal_capabilities(None)
    result = {e.capabilityId: e for e in all_executors()}
    if kb is not False:
        _kb = kb
        if _kb is None and home is not None:
            try:
                from ..knowledge.store import KnowledgeBase as _KB
                _kb = _KB(store_dir=home / "knowledge")
            except Exception:
                _kb = None
        if _kb is not None:
            _home = home
            _adir = (_home / "artifacts") if _home is not None else None
            for e in multimodal_executors(_kb, _adir):
                result[e.capabilityId] = e
    return result
