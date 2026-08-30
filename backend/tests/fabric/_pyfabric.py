"""Python-side mirror of the fabricops scenario runner.

Same scripted-host semantics, same op dispatch, same determinism (clock draws
+1 ms; instant backoff recorded instead of slept). Compared 1:1 against the
TypeScript oracle run of the identical script.
"""

from __future__ import annotations

import re
from typing import Any

from aura.fabric import CapabilityFabric


class ScriptedHost:
    """Configurable host: scripted mode (P4) or wiring mode (P5)."""

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self._present = cfg.get("presentNodes") or []
        self.resolve_node = None
        if cfg.get("wiring"):
            from aura.fabric.routing import resolve_node_for

            def _resolve(cap, ctx, can_use=None):
                return resolve_node_for(cap, ctx, self._present, can_use)
            self.resolve_node = _resolve

    def permissions_for(self, capability: dict, _context: dict) -> dict[str, bool]:
        return self.cfg.get("permissions", {}).get(
            capability["id"], {"read": True, "write": True, "execute": True, "autonomous": True})

    def node_available(self, capability: dict) -> bool | None:
        # Wiring-mode semantics (fabric/index.ts:153-159): null unless the
        # capability needs a node; internal surfaces never depend on one.
        if self.cfg.get("wiring"):
            needed = capability.get("requiresNodeCapability")
            if not needed:
                return None
            if capability.get("surface") == "aura-internal":
                return True
            provided = set(self.cfg.get("providedNodeCapabilities") or [])
            return needed in provided
        na = self.cfg.get("nodeAvailable") or {}
        return na[capability["id"]] if capability["id"] in na else True

    async def request_approval(self, request: dict, context: dict) -> bool:
        # Wiring-mode semantics (fabric/index.ts:170-176): grant ONLY when
        # THIS call carried explicit authorization for every item.
        if self.cfg.get("wiring"):
            approved = set(context.get("approvedCapabilities") or [])
            return all(i["capabilityId"] in approved for i in request.get("items") or [])
        mode = self.cfg.get("approvals")
        if mode == "grant":
            return True
        if mode == "throw":
            raise RuntimeError("host exploded")
        return False  # park


class ScriptedExecutor:
    def __init__(self, spec: dict) -> None:
        self.capabilityId = spec["capabilityId"]
        self._queue = [dict(s) for s in spec["steps"]]
        self._verify = spec.get("verify")

    async def run(self, _invocation: dict) -> dict:
        step = self._queue.pop(0) if len(self._queue) > 1 else self._queue[0]
        if "throw" in step and step["throw"] is not None:
            raise RuntimeError(step["throw"])
        out = {"ok": bool(step.get("ok")), "detail": step.get("detail", "")}
        if "output" in step:
            out["output"] = step["output"]
        return out

    async def verify(self, _invocation: dict, _last: dict) -> dict:
        v = self._verify or {}
        if "throw" in v and v["throw"] is not None:
            raise RuntimeError(v["throw"])
        return {"passed": v.get("passed"), "kind": v.get("kind"), "detail": v.get("detail", "")}


def run_py_fabric_ops(home: str | None, start_ms: int, config: dict, ops: list[dict]) -> dict:
    import os

    if home:
        os.environ["AURA_HOME"] = home

    state = {"tick": start_ms}

    def tick_ms() -> int:
        state["tick"] += 1
        return state["tick"]

    from aura.persistence._common import iso_from_ms

    def tick_iso() -> str:
        # consume one ms-draw then format — matches FakeDate semantics exactly
        return iso_from_ms(tick_ms())

    slept: list[float] = []

    async def instant_sleep(ms: float) -> None:
        slept.append(ms)

    events: list[dict] = []
    results: list[Any] = []

    fabric = CapabilityFabric(ScriptedHost(config), clock_ms=tick_ms,
                              clock_iso=tick_iso, sleep=instant_sleep)
    fabric.listen(events.append)
    if "policyRaw" in config:
        from aura.policy import sanitize_policy

        fabric.set_policy(sanitize_policy(config["policyRaw"]))
    from aura.executors import all_executors as _all_exec

    registry_stub = type("R", (), {
        "list_projects": staticmethod(list),
        "profile": staticmethod(lambda pid: None),
        "current_project": staticmethod(lambda: None),
    })()
    for adapter in _all_exec(registry_stub):
        if config.get("executorIds") and adapter.capabilityId not in config["executorIds"]:
            continue
        fabric.register(adapter)
    for ex in config.get("executors") or []:
        fabric.register(ScriptedExecutor(ex))

    def resolve(v: Any) -> Any:
        if isinstance(v, str):
            m = re.fullmatch(r"\$r(\d+)(?:\.(.*))?", v)
            if m:
                cur = results[int(m.group(1))]
                rest = m.group(2)
                if rest:
                    for part in rest.split("."):
                        cur = cur[int(part)] if part.isdigit() else cur.get(part)
                return cur
            return v
        if isinstance(v, list):
            return [resolve(x) for x in v]
        if isinstance(v, dict):
            return {k: resolve(x) for k, x in v.items()}
        return v

    async def drive() -> None:
        for op in ops:
            try:
                kind = op["op"]
                if kind == "invoke":
                    r = await fabric.invoke(resolve(op["capabilityId"]),
                                            resolve(op.get("input") or {}),
                                            resolve(op.get("context") or {}))
                    results.append(r)
                elif kind == "evaluate":
                    results.append(fabric.evaluate(resolve(op["capabilityId"]),
                                                   resolve(op.get("context") or {})))
                elif kind == "decide":
                    results.append(fabric.decide_approval(resolve(op["id"]), op["granted"],
                                                          op.get("by") or "user", op.get("reason")))
                elif kind == "consume":
                    results.append(fabric.consume_approval(resolve(op["id"])))
                elif kind == "pending":
                    import copy

                    results.append(copy.deepcopy(fabric.pending_approvals()))
                elif kind == "audit":
                    import copy

                    results.append(copy.deepcopy(fabric.audit_log))
                else:
                    raise KeyError(kind)
            except Exception as e:  # mirror TS catch shape
                results.append({"__error__": str(e)})

    import asyncio

    asyncio.run(drive())
    return {"results": results, "events": events, "slept": slept}
