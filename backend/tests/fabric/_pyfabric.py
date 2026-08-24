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
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.resolve_node = None  # Phase 5

    def permissions_for(self, capability: dict, _context: dict) -> dict[str, bool]:
        return self.cfg.get("permissions", {}).get(
            capability["id"], {"read": True, "write": True, "execute": True, "autonomous": True})

    def node_available(self, capability: dict) -> bool | None:
        na = self.cfg.get("nodeAvailable") or {}
        return na[capability["id"]] if capability["id"] in na else True

    async def request_approval(self, request: dict, _context: dict) -> bool:
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
