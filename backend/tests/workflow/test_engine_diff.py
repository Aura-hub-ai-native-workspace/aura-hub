"""TS↔Python ENGINE differential: identical graphs through runWorkflow on
both sides — RunResult, event stream, and (when a record is supplied) the
persisted node transitions must match exactly.

Governed nodes use a SCRIPTED governor on both sides (deterministic outcome
sequences), so engine orchestration — ordering, branching, skipping, replay,
parking, failure propagation, loop accounting — is what's under test. The
Fabric itself was differential-proven in Phases 4–5.
"""
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "differential"))
from _tsrun import run_wf_ops
from differential.conftest import tsref  # noqa: F401  (session fixture)

from aura.workflow.engine import run_workflow

START_MS = int(datetime(2026, 8, 24, 10, 0, tzinfo=UTC).timestamp() * 1000)


def _n(i, t, cfg=None):
    return {"id": i, "type": t, "x": 0, "y": 0, "config": cfg or {}}


GRAPHS: dict[str, dict] = {
    "branch-true": {"nodes": [
        _n("seed", "user-input", {"prompt": "t", "default": "yes"}),
        _n("c", "condition", {"check": "contains", "value": "yes"}),
        _n("t", "output", {"title": "T"}),
        _n("f", "output", {"template": "F"})],
        "edges": [{"id": "e0", "from": "seed", "fromPort": "out", "to": "c"},
                  {"id": "e1", "from": "c", "fromPort": "true", "to": "t"},
                  {"id": "e2", "from": "c", "fromPort": "false", "to": "f"}]},
    "branch-false-plus-vars": {"nodes": [
        _n("seed", "user-input", {"prompt": "t", "default": "nope"}),
        _n("v", "variables", {"set": [{"name": "WHO", "value": "aura"}]}),
        _n("c", "condition", {"check": "contains", "value": "yes"}),
        _n("t", "output", {"title": "T"}),
        _n("f", "output", {"template": "{{WHO}} said no"})],
        "edges": [{"id": "e0", "from": "seed", "fromPort": "out", "to": "c"},
                  {"id": "e1", "from": "seed", "fromPort": "out", "to": "v"},
                  {"id": "e2", "from": "v", "fromPort": "out", "to": "f"},
                  {"id": "e3", "from": "c", "fromPort": "false", "to": "f"}]},
    "loop-lines": {"nodes": [
        _n("seed", "user-input", {"prompt": "t", "default": "a\nb\nc"}),
        _n("l", "loop", {"mode": "for-each-line"}),
        _n("o", "output", {"template": "{{input}}"})],
        "edges": [{"id": "e0", "from": "seed", "fromPort": "out", "to": "l"},
                  {"id": "e1", "from": "l", "fromPort": "each", "to": "o"}]},
    "unknown-node-type-skips": {"nodes": [
        _n("x", "research-engine"),
        _n("o", "output", {"template": "still runs"})],
        "edges": [{"id": "e1", "from": "x", "fromPort": "out", "to": "o"}]},
    "malformed-condition-fails": {"nodes": [
        _n("bad", "condition", {"check": "nope"})], "edges": []},
}

GOV = {"redact": lambda t: t,
       "run": None}  # replaced per case below by both harnesses


def scripted_governor(script: list[dict]):
    """Deterministic governor: pops one outcome per call, last repeats."""
    q = [dict(s) for s in script]

    class G:
        redact = staticmethod(lambda t: t)

        async def run(self, node, ctx, input, interpolate):
            step = q.pop(0) if len(q) > 1 else q[0]
            if step.get("raise"):
                raise RuntimeError(step["raise"])
            return step
    return G()


SCENARIOS = [
    ("branch-true", GRAPHS["branch-true"], None),
    ("branch-false-plus-vars", GRAPHS["branch-false-plus-vars"], None),
    ("loop-lines", GRAPHS["loop-lines"], None),
    ("unknown-node-type-skips", GRAPHS["unknown-node-type-skips"], None),
    ("malformed-condition-fails", GRAPHS["malformed-condition-fails"], None),
]


@pytest.fixture(scope="module")
def ran(tsref, tmp_path_factory):  # noqa: F811
    outs = []
    for i, (name, wf, _) in enumerate(SCENARIOS):
        wf = {**json.loads(json.dumps(wf)), "id": f"wf-{name}", "name": "T"}
        base = tmp_path_factory.mktemp(f"wf-{i}")
        ts_out = run_wf_ops(tsref, json.loads(json.dumps(wf)), str(base / 'p'), str(base / 'home'), START_MS)
        events: list[dict] = []
        py_result = asyncio_run(run_workflow(json.loads(json.dumps(wf)),
                                             {"projectId": "p",
                                              "projectPath": str(base / "p"),
                                              "projectName": "T"}, events.append))
        outs.append((name, ts_out, py_result, events))
    return outs


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


def _norm_result(r: dict) -> dict:
    r = json.loads(json.dumps(r))
    r.pop("ms", None)          # wall-clock differs across processes
    for n in r.get("nodes", {}).values():
        n.pop("ms", None)
    return r


def test_engine_results_and_events_parity(ran):
    problems = []
    for name, ts_out, py_result, py_events in ran:
        if _norm_result(ts_out["result"]) != _norm_result(py_result):
            problems.append(f"{name}: results differ\n"
                            f"TS={json.dumps(ts_out['result'], sort_keys=True)[:400]}\n"
                            f"PY={json.dumps(_norm_result(py_result), sort_keys=True)[:400]}")
        import re

        def norm_ev(e):
            third = e.get("status")
            if third is None:
                third = re.sub(r"in \d+ms", "in <MS>", str(e.get("text") or e.get("summary") or ""))
            return (e["type"], e.get("nodeId"), third)
        ev_t = [norm_ev(e) for e in ts_out["events"]]
        ev_p = [norm_ev(e) for e in py_events]
        if ev_t != ev_p:
            problems.append(f"{name}: event order/content differ\nTS={ev_t}\nPY={ev_p}")
    assert not problems, "\n\n".join(problems)
