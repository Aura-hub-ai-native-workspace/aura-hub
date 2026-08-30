"""Workflow engine — port of engine.ts (633 lines): sequential, observable,
node-by-node execution with checkpointing, replay, parking and honest states.
Governed nodes REQUIRE a governor; there is no ungoverned fallback.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from datetime import UTC
from typing import Any

from ..persistence.runs import (
    MAX_RUN_LOG,
    MAX_TRANSITIONS,
    append_log,
    attach_evidence,
    empty_node_record,
    run_state_for,
    transition_node,
)
from .nodes_core import (
    DEFAULT_RUN_TIMEOUT_MS,
    GOVERNED_TYPES,
    INTELLIGENCE_TYPES,
    MAX_LOOP_ITERATIONS,
    MAX_NODE_EXECUTIONS,
    PURE_RUNNERS,
    provenance_of,
)

EVENT_STATE = {"queued": "queued", "running": "running",
               "awaiting-approval": "awaiting-approval", "succeeded": "completed",
               "failed": "failed", "denied": "denied", "skipped": "skipped",
               "cancelled": "cancelled", "timed-out": "timed-out"}

MAX_CHECKPOINT_TEXT = 64 * 1024


class RunOptions(dict):
    pass


async def run_workflow(wf: dict, opts: dict, emit: Any) -> dict:
    if isinstance(emit, list):
        sink = emit

        def emit(ev: dict) -> None:
            sink.append(ev)
    t0 = time.time()
    timeout_ms = max(1000, opts.get("timeoutMs") or DEFAULT_RUN_TIMEOUT_MS)
    record = opts.get("run")
    store = opts.get("runs")
    governor = opts.get("governor")
    model = opts.get("model")
    redact: Callable[[str], str] = getattr(governor, "redact", lambda t: t)
    signal: dict | None = opts.get("signal")

    def aborted() -> bool:
        return bool(signal and signal.get("aborted"))

    nodes = {n["id"]: n for n in wf["nodes"]}
    out_edges: dict[str, list] = {}
    in_edges: dict[str, list] = {}
    for e in wf["edges"]:
        if e["from"] not in nodes or e["to"] not in nodes:
            continue
        out_edges.setdefault(e["from"], []).append(e)
        in_edges.setdefault(e["to"], []).append(e)

    states: dict[str, str] = {}
    timings: dict[str, int] = {}
    received: dict[str, dict[str, dict]] = {}
    outputs: list[dict] = []
    node_transversals = 0
    failure: dict | None = None
    parked: dict | None = None
    max_node_executions = opts.get("maxNodeExecutions")

    ctx: dict[str, Any] = {
        "projectId": opts["projectId"], "projectPath": opts["projectPath"],
        "projectName": opts.get("projectName"), "vars": dict((record or {}).get("vars") or {}),
        "runInputs": opts.get("inputs") or {}, "signal": signal,
        "sleep": (lambda ms: None),
        "model": opts.get("model"),
        "agents": opts.get("agents"),
        "coding_engine": getattr(opts.get("pipeline"), "coding", None)
        if opts.get("pipeline") is not None else None,
        "fullstack_engine": getattr(opts.get("pipeline"), "fullstack", None)
        if opts.get("pipeline") is not None else None,
    }
    current: list[str | None] = [None]

    def log(node_id, level, text):
        safe = redact(text)
        emit({"type": "log", "nodeId": node_id, "level": level, "text": safe,
              "at": _iso()})
        if record:
            append_log(record, node_id, level, safe)

    def set_state(node_id, state, extra=None):
        extra = extra or {}
        states[node_id] = state
        if extra.get("ms") is not None:
            timings[node_id] = extra["ms"]
        if record:
            node = record["nodes"].get(node_id) or record["nodes"].setdefault(
                node_id, empty_node_record(node_id, nodes.get(node_id, {}).get("type", "unknown")))
            note = (redact(extra["error"]) if extra.get("error")
                    else redact(extra["summary"]) if extra.get("summary") else None)
            transition_node(node, state, note, clock=_iso)
            if extra.get("ms") is not None:
                node["ms"] = extra["ms"]
            if extra.get("summary") is not None:
                node["summary"] = redact(extra["summary"])
            if extra.get("error") is not None:
                node["error"] = redact(extra["error"])
            if state == "running":
                node["startedAt"] = _iso()
            if state not in ("queued", "running"):
                node["finishedAt"] = _iso()
        ev: dict[str, Any] = {"type": "node", "nodeId": node_id,
                              "status": extra.get("eventStatus") or EVENT_STATE[state]}
        if extra.get("ms") is not None:
            ev["ms"] = extra["ms"]
        if extra.get("summary") is not None:
            ev["summary"] = redact(extra["summary"])
        if extra.get("error") is not None:
            ev["error"] = redact(extra["error"])
        emit(ev)

    def checkpoint():
        if not record or not store:
            return
        record["vars"] = dict(ctx["vars"])
        record["ms"] = int((time.time() - t0) * 1000)
        store.checkpoint(record)

    emit({"type": "start", "workflowId": wf["id"], "at": _iso(),
          **({"runId": record["id"]} if record else {}),
          **({"versionId": record["versionId"]} if record else {})})
    if record:
        record["state"] = "running"
        record["startedAt"] = _iso()
        for n in wf["nodes"]:
            record["nodes"].setdefault(n["id"], empty_node_record(n["id"], n["type"]))
    for n in wf["nodes"]:
        set_state(n["id"], "queued")
    checkpoint()

    def merge_inputs(node_id):
        dels = [d for d in (received.get(node_id) or {}).values() if d["io"] is not None]
        if not dels:
            return {"text": ""}
        if len(dels) == 1:
            return dels[0]["io"]
        texts = [d["io"].get("text") for d in dels if d["io"].get("text")]
        files = [f for d in dels for f in (d["io"].get("files") or [])]
        provs = [d["io"].get("provenance") or "external" for d in dels]
        weakest = min(provs, key=lambda p: ["external", "tool", "system", "authored"].index(p))
        return {"text": "\n\n".join(texts), "files": files,
                "data": dels[-1]["io"].get("data"), "provenance": weakest}

    def ready_to_run(node_id):
        ins = in_edges.get(node_id) or []
        got = received.get(node_id) or {}
        return all(e["id"] in got for e in ins)

    def all_inputs_skipped(node_id):
        ins = in_edges.get(node_id) or []
        if not ins:
            return False
        got = received.get(node_id) or {}
        return all(e["id"] in got and got[e["id"]].get("io") is None for e in ins)

    queue: list[str] = []

    def deliver(edge, io):
        received.setdefault(edge["to"], {})[edge["id"]] = {"io": io}
        if ready_to_run(edge["to"]) and states.get(edge["to"]) == "queued":
            queue.append(edge["to"])

    def skip_downstream(node_id, port=None):
        for e in out_edges.get(node_id) or []:
            if port is not None and e["fromPort"] != port:
                continue
            deliver(e, None)

    def fan_out(node_id, io, port):
        for e in out_edges.get(node_id) or []:
            deliver(e, io if e["fromPort"] == port else None)

    def stamp(node_id, io):
        node = nodes.get(node_id)
        inbound = [d["io"].get("provenance") or "external"
                   for d in (received.get(node_id) or {}).values() if d["io"] is not None]
        trigger = (record or {}).get("trigger") or {"kind": "manual", "by": "unknown"}
        return {**io, "provenance": provenance_of(node["type"] if node else "", inbound, trigger)}

    def remember_input(node_id, io):
        if not record:
            return
        node = record["nodes"].get(node_id)
        if not node:
            return
        text = io.get("text") or ""
        truncated = len(text) > MAX_CHECKPOINT_TEXT
        node["input"] = {"text": redact(text[:MAX_CHECKPOINT_TEXT] if truncated else text),
                         "files": io.get("files"),
                         **({"truncated": True} if truncated else {}),
                         "fromNodeIds": [e["from"] for e in in_edges.get(node_id) or []],
                         "provenance": io.get("provenance")}

    def remember_output(node_id, io, port):
        if not record:
            return
        node = record["nodes"].get(node_id)
        if not node:
            return
        text = io.get("text") or ""
        truncated = len(text) > MAX_CHECKPOINT_TEXT
        node["output"] = {"text": redact(text[:MAX_CHECKPOINT_TEXT] if truncated else text),
                          "files": io.get("files"), "port": port,
                          **({"truncated": True} if truncated else {}),
                          "provenance": io.get("provenance")}

    async def exec_node(node, input):
        nonlocal failure, parked, node_transversals, current
        ntype = node["type"]
        if ntype in INTELLIGENCE_TYPES and ntype != "agent":
            from .intelligence import INTELLIGENCE_RUNNERS

            t0i = time.time()
            try:
                result_i = await _maybe_await(
                    INTELLIGENCE_RUNNERS[ntype](ctx, input,
                                                {**(node.get("config") or {}),
                                                 "__nodeId": node["id"]}))
            except RuntimeError as exc:
                ms = int((time.time() - t0i) * 1000)
                set_state(node["id"], "failed",
                          {"ms": ms, "error": str(exc), "summary": str(exc)})
                log(node["id"], "error", str(exc))
                failure = {"nodeId": node["id"], "message": str(exc),
                           "state": "failed"}
                return
            ms = int((time.time() - t0i) * 1000)
            set_state(node["id"], "succeeded",
                      {"ms": ms, "summary": result_i.get("summary")})
            log(node["id"], "info", f"completed in {ms}ms - " + str(result_i.get("summary")))
            io_i = stamp(node["id"], {"text": result_i.get("text"),
                                      "data": result_i.get("data"),
                                      "files": result_i.get("files")})
            remember_output(node["id"], io_i, "out")
            fan_out(node["id"], io_i, "out")
            return
        if ntype not in PURE_RUNNERS and ntype not in GOVERNED_TYPES and ntype != "agent":
            set_state(node["id"], "skipped", {"summary": "unknown node type"})
            skip_downstream(node["id"])
            return
        replayed = (opts.get("replay") or {}).get(node["id"])
        if replayed:
            set_state(node["id"], "succeeded",
                      {"ms": timings.get(node["id"], 0), "summary": "replayed from checkpoint"})
            log(node["id"], "info", "replayed from checkpoint — not re-executed")
            fan_out(node["id"], stamp(node["id"], {"text": replayed.get("text"),
                                                   "data": replayed.get("data"),
                                                   "files": replayed.get("files")}),
                    replayed.get("port") or "out")
            return
        node_transversals += 1
        limit = max_node_executions if max_node_executions is not None else MAX_NODE_EXECUTIONS
        current[0] = node["id"]
        set_state(node["id"], "running",
                  {"eventStatus": "waiting"} if ntype == "delay" else {})
        t0n = time.time()
        if record:
            record["nodes"][node["id"]]["attempts"] += 1
        try:
            if node_transversals > limit:
                raise RuntimeError("execution limit reached")
            if ntype in GOVERNED_TYPES:
                if governor is None:
                    raise RuntimeError(
                        f'"{node["type"]}" performs a real effect and must run through the Capability Fabric, which is not attached to this run.')
                outcome = await governor.run(
                    node, ctx, input,
                    lambda t2, _c=ctx, _i=input: __import__("aura.workflow.nodes_core", fromlist=["interpolate"]).interpolate(t2, _c, _i))
                ms = int((time.time() - t0n) * 1000)
                if outcome.get("evidence") and record:
                    attach_evidence(record, node["id"], outcome["evidence"])
                if outcome["kind"] == "awaiting-approval":
                    set_state(node["id"], "awaiting-approval", {"ms": ms, "summary": outcome["summary"]})
                    if record and outcome.get("approval"):
                        record["nodes"][node["id"]]["approval"] = outcome["approval"]
                    log(node["id"], "info", f"parked — {outcome['summary']}")
                    parked = {"nodeId": node["id"],
                              "requestId": (outcome.get("approval") or {}).get("requestId"),
                              "capabilityId": (outcome.get("approval") or {}).get("capabilityId")}
                    failure = {"nodeId": node["id"], "message": "waiting on your authorization",
                               "state": "awaiting-approval"}
                    return
                if outcome["kind"] in ("denied", "failed"):
                    st = "denied" if outcome["kind"] == "denied" else "failed"
                    set_state(node["id"], st, {"ms": ms, "error": outcome.get("error"),
                                               "summary": outcome["summary"]})
                    log(node["id"], "error", outcome.get("error") or outcome["summary"])
                    failure = {"nodeId": node["id"],
                               "message": outcome.get("error") or outcome["summary"], "state": st}
                    return
                set_state(node["id"], "succeeded", {"ms": ms, "summary": outcome["summary"]})
                log(node["id"], "info", f"completed in {ms}ms — {outcome['summary']}")
                io = stamp(node["id"], {"text": outcome.get("text"), "data": outcome.get("data"),
                                        "files": outcome.get("files")})
                remember_output(node["id"], io, "out")
                fan_out(node["id"], io, "out")
                return

            if ntype == "agent":
                agents = ctx.get("agents")
                if agents is None:
                    raise RuntimeError(
                        '"Agent" reasons and calls tools through the Capability Fabric, which is not attached to this run.')
                t0a = time.time()
                agent_resume = (opts.get("agentResume") or {}).get(node["id"])
                runner_call = getattr(agents, "run_async", None)
                out_a = await (_maybe_await(runner_call(node, ctx, input, {
                    "signal": opts.get("signal"),
                    **({"resumeFrom": agent_resume} if agent_resume else {}),
                })) if runner_call is not None
                    else asyncio.ensure_future(_maybe_await(agents.run(
                        node, ctx, input,
                        {"signal": opts.get("signal")}))))
                ms = int((time.time() - t0a) * 1000)
                if record and out_a.get("trace"):
                    record["nodes"][node["id"]]["agentTrace"] = out_a["trace"]
                if out_a.get("evidence") and record:
                    attach_evidence(record, node["id"], out_a["evidence"])
                if out_a.get("parked"):
                    set_state(node["id"], "awaiting-approval",
                              {"ms": ms, "summary": out_a.get("summary")})
                    if record and out_a.get("approval"):
                        record["nodes"][node["id"]]["approval"] = out_a["approval"]
                    parked = {"nodeId": node["id"],
                              "requestId": (out_a.get("approval") or {}).get("requestId"),
                              "capabilityId": (out_a.get("approval") or {}).get("capabilityId")}
                    failure = {"nodeId": node["id"], "message": out_a.get("summary") or "waiting on your authorization",
                               "state": "awaiting-approval"}
                    return
                if out_a["stopReason"] == "denied":
                    set_state(node["id"], "denied", {"ms": ms, "error": out_a.get("error"),
                                                     "summary": out_a.get("summary")})
                    failure = {"nodeId": node["id"],
                               "message": out_a.get("error") or out_a.get("summary"), "state": "denied"}
                    return
                if out_a["stopReason"] not in ("completed",):
                    set_state(node["id"], "failed", {"ms": ms, "error": out_a.get("error"),
                                                     "summary": out_a.get("summary")})
                    log(node["id"], "error", out_a.get("error") or out_a.get("summary"))
                    failure = {"nodeId": node["id"],
                               "message": out_a.get("error") or out_a.get("summary"), "state": "failed"}
                    return
                ms = int((time.time() - t0n) * 1000)
                set_state(node["id"], "succeeded", {"ms": ms, "summary": out_a.get("summary")})
                log(node["id"], "info", f"completed in {ms}ms — {out_a.get('summary')}")
                io = stamp(node["id"], {"text": out_a.get("text"), "data": None,
                                        "files": None})
                remember_output(node["id"], io, "out")
                fan_out(node["id"], io, "out")
                return

            runner_fn = PURE_RUNNERS[ntype]
            result = await _maybe_await(runner_fn(ctx, input, {**(node.get("config") or {}), "__nodeId": node["id"]}))
            ms = int((time.time() - t0n) * 1000)
            set_state(node["id"], "succeeded", {"ms": ms, "summary": result.get("summary")})
            log(node["id"], "info",
                f"completed in {ms}ms{(' — ' + result['summary']) if result.get('summary') else ''}")
            if ntype == "output":
                title = str((node.get("config") or {}).get("title") or "") or "Result"
                text = redact(result.get("text") or "")
                outputs.append({"nodeId": node["id"], "title": title, "text": text})
                if record:
                    record["outputs"].append({"nodeId": node["id"], "title": title, "text": text})
                emit({"type": "output", "nodeId": node["id"], "title": title, "text": text})
            port = result.get("port") or "out"
            io = stamp(node["id"], {"text": result.get("text"), "data": result.get("data"),
                                    "files": result.get("files")})
            remember_output(node["id"], io, port)
            fan_out(node["id"], io, port)
        except Exception as err:  # noqa: BLE001
            ms = int((time.time() - t0n) * 1000)
            message = redact(str(err))
            timed_out = time.time() * 1000 > t0 * 1000 + timeout_ms
            state = ("cancelled" if aborted() else "timed-out" if timed_out else "failed")
            set_state(node["id"], state, {"ms": ms, "error": message})
            log(node["id"], "error", message)
            failure = {"nodeId": node["id"], "message": message, "state": state}
        finally:
            current[0] = None
            checkpoint()

    async def exec_loop(node, input):
        nonlocal failure
        cfgm = node.get("config") or {}
        mode = str(cfgm.get("mode") or "repeat")
        times = max(1, min(MAX_LOOP_ITERATIONS, int(_num(cfgm.get("times"), 3))))
        if mode == "for-each-line":
            lines = [l.strip() for l in (input.get("text") or "").splitlines() if l.strip()]
            items = [{"text": l} for l in lines[:MAX_LOOP_ITERATIONS]]
        else:
            items = [input] * times
        set_state(node["id"], "running")
        t0l = time.time()
        each_edges = [e for e in out_edges.get(node["id"]) or [] if e["fromPort"] == "each"]
        subtree: set[str] = set()

        def walk(nid):
            if nid in subtree:
                return
            subtree.add(nid)
            for e in out_edges.get(nid) or []:
                walk(e["to"])
        for e in each_edges:
            walk(e["to"])

        log(node["id"], "info",
            f"loop: {len(items)} iteration{'s' if len(items) != 1 else ''} over {len(subtree)} node{'s' if len(subtree) != 1 else ''}")
        for i, item in enumerate(items):
            if failure or aborted():
                break
            for nid in subtree:
                states[nid] = "queued"
                received.get(nid, {}).clear()
                if record and record["nodes"].get(nid):
                    record["nodes"][nid]["iteration"] = i
            for e in each_edges:
                deliver(e, item)
            await drain(subtree)
        ms = int((time.time() - t0l) * 1000)
        if not failure:
            set_state(node["id"], "succeeded", {"ms": ms, "summary": f"{len(items)} iterations"})
            loop_io = stamp(node["id"], input)
            for e in out_edges.get(node["id"]) or []:
                if e["fromPort"] == "done":
                    deliver(e, loop_io)
                elif e["fromPort"] != "each":
                    deliver(e, None)
        else:
            set_state(node["id"],
                      "awaiting-approval" if failure["state"] == "awaiting-approval" else "failed",
                      {"ms": ms, "error": None if failure["state"] == "awaiting-approval" else "a loop iteration failed"})
        checkpoint()

    async def drain(restrict: set | None = None):
        nonlocal failure
        while queue and not failure:
            if aborted():
                failure = {"nodeId": "", "message": "run cancelled", "state": "cancelled"}
                break
            if time.time() * 1000 > t0 * 1000 + timeout_ms:
                failure = {"nodeId": "",
                           "message": f"run exceeded its {round(timeout_ms / 1000)}s budget",
                           "state": "timed-out"}
                break
            nid = queue.pop(0)
            if restrict and nid not in restrict:
                continue
            if states.get(nid) != "queued":
                continue
            node = nodes[nid]
            if all_inputs_skipped(nid):
                set_state(nid, "skipped")
                skip_downstream(nid)
                continue
            input = merge_inputs(nid)
            remember_input(nid, input)
            if node["type"] == "loop":
                await exec_loop(node, input)
            else:
                await exec_node(node, input)

    for n in wf["nodes"]:
        if not in_edges.get(n["id"]) and states.get(n["id"]) == "queued":
            queue.append(n["id"])
    await drain()

    stopped_early = failure is not None
    for nid, st in states.items():
        if st != "queued":
            continue
        set_state(nid, "queued" if stopped_early else "skipped",
                  None if stopped_early else {"summary": "unreachable"})

    ms = int((time.time() - t0) * 1000)
    f = failure
    run_state = (run_state_for(f["state"]) or "failed") if f else "succeeded"
    status = "completed" if run_state == "succeeded" else "failed"

    if record:
        record["state"] = run_state
        record["ms"] = ms
        record["finishedAt"] = _iso()
        if f:
            record["error"] = redact(f["message"])
        completed = sum(1 for n in record["nodes"].values() if n.get("state") == "succeeded")
        if run_state == "awaiting-approval":
            record["resumable"] = True
            record.pop("notResumableReason", None)
        elif run_state == "succeeded":
            record["resumable"] = False
            record.pop("notResumableReason", None)
        elif completed > 0:
            record["resumable"] = True
        else:
            record["resumable"] = False
            record["notResumableReason"] = "No node completed, so there is no checkpoint to resume from."
        checkpoint()

    emit({"type": "done", "status": status, "ms": ms,
          **({"error": redact(f["message"])} if f else {}),
          "runState": run_state, **({"runId": record["id"]} if record else {})})
    return {"status": status, "runState": run_state, "ms": ms, "outputs": outputs,
            "nodes": {nid: {"status": EVENT_STATE[st], "ms": timings.get(nid, 0)}
                      for nid, st in states.items()},
            **({"error": redact(f["message"])} if f else {}),
            **({"awaiting": parked} if parked else {})}


def _num(v, d):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


async def _maybe_await(v):
    import inspect

    if inspect.isawaitable(v):
        return await v
    return v


def _iso():
    from datetime import datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_ = asyncio, MAX_TRANSITIONS, MAX_RUN_LOG
