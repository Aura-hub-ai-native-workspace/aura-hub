"""Python-side mirror of the TS store-ops interpreter.

Executes the SAME op-script against aura.persistence classes with the SAME
deterministic clock/random sequences, so results and on-disk bytes can be
compared 1:1 against the TypeScript oracle run.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from aura.persistence._common import counter_rand, iso_from_ms, make_gen_id, stepped_clock
from aura.persistence.automation import AutomationStore
from aura.persistence.runs import (
    WorkflowRunStore,
    append_log,
    attach_evidence,
    empty_node_record,
    run_state_for,
    summarize_run,
    transition_node,
)
from aura.persistence.versions import WorkflowVersionStore
from aura.persistence.workflows import WorkflowStore


def run_py_store_ops(home: str, start_ms: int, ops: list[dict]) -> dict[str, Any]:
    import os

    os.environ["AURA_HOME"] = home
    # fresh state per call: env is read lazily everywhere
    clock_ms = stepped_clock(start_ms)
    rand = counter_rand()

    def iso() -> str:
        return iso_from_ms(clock_ms())

    gen = make_gen_id(lambda: clock_ms(), lambda: rand())

    WF = WorkflowStore(clock=iso, id_gen=gen)
    RUNS = WorkflowRunStore(clock=iso, id_gen=gen)
    VER = WorkflowVersionStore(clock=iso, id_gen=gen)
    AUTO = AutomationStore(clock=iso, id_gen=gen)

    results: list[Any] = []

    import re

    def resolve(v: Any) -> Any:
        """$rN / $rN.a.b[i].c — mirror of the TS driver's resolver."""
        if isinstance(v, str):
            m = re.fullmatch(r"\$r(\d+)(?:\.(.*))?", v)
            if m:
                cur = results[int(m.group(1))]
                rest = m.group(2)
                if rest:
                    for part in rest.split("."):
                        cur = cur[int(part)] if part.isdigit() else cur.get(part) if isinstance(cur, dict) else None
                return cur
            return v
        if isinstance(v, list):
            return [resolve(x) for x in v]
        if isinstance(v, dict):
            return {k: resolve(x) for k, x in v.items()}
        return v

    def deep_merge(dst: dict, src: dict) -> None:
        for k, v in src.items():
            if isinstance(v, dict) and not isinstance(v, list) and isinstance(dst.get(k), dict):
                deep_merge(dst[k], v)
            else:
                dst[k] = v

    for op in ops:
        target, _, method = op["op"].partition(".")
        try:
            if target == "obj":
                if method == "merge":
                    dst_obj = resolve(op["args"][0])
                    patch = resolve(op["args"][1])
                    deep_merge(dst_obj, patch)
                    results.append(None)
                else:
                    raise KeyError(f"obj.{method}")
                continue
            if target == "helpers":
                fn = method.split(":")[0]
                args = [resolve(a) for a in (op.get("args") or [])]
                if fn == "emptyNodeRecord":
                    results.append(empty_node_record(*args))
                elif fn == "transitionNode":
                    transition_node(args[0], args[1], args[2] if len(args) > 2 else None, clock=iso)
                    results.append(None)
                elif fn == "appendLog":
                    append_log(args[0], args[1], args[2], args[3], clock=iso)
                    results.append(None)
                elif fn == "attachEvidence":
                    attach_evidence(args[0], args[1], args[2])
                    results.append(None)
                elif fn == "runStateFor":
                    results.append(run_state_for(args[0]))
                elif fn == "summarizeRun":
                    results.append(summarize_run(args[0]))
                else:
                    raise KeyError(fn)
                continue
            if target == "fs":
                p = Path(home) / op["path"]
                if method == "write":
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(op["data"], encoding="utf-8")
                elif method == "rm":
                    import shutil

                    shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
                elif method == "read":
                    try:
                        results.append(p.read_text(encoding="utf-8"))
                    except OSError:
                        results.append(None)
                continue
            obj = {"wf": WF, "runs": RUNS, "ver": VER, "auto": AUTO}[target]
            r = getattr(obj, method)(*(resolve(a) for a in (op.get("args") or [])))
            results.append(r)
        except Exception as e:  # surface errors symmetrically to the TS side
            results.append({"__error__": str(e)})

    tree = {}
    root = Path(home)
    for p in sorted(root.rglob("*")):
        if p.is_file():
            tree[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"results": results, "tree": tree}
