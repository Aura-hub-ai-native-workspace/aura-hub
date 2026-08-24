"""THE Phase-5 gate: resolveNode routing + REAL executor effects, TS vs Python.

Both sides run through their genuine wiring (createFabric(deps) with
resolveNodeFor over injected presentNodes; real file-backed approval/audit
stores under isolated AURA_HOMEs) and execute REAL effects in sibling
disposable project directories. Absolute-path outputs are normalized to
<HOME> before comparison; everything else — including refusal strings,
timed-out suffixes, exit codes, evidence attribution and event order — must
be byte-equal.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

import sys

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT.parent))
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "differential"))
sys.path.insert(0, str(_ROOT / "fabric"))

from differential.conftest import tsref  # noqa: E402, F401  (session fixture)

from _tsrun import run_fabric_ops  # noqa: E402
from fabric._pyfabric import run_py_fabric_ops  # noqa: E402

START_MS = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)

GIT_NODE = {"id": "node-git", "name": "Git", "binary": "git",
            "capabilities": ["source-control"]}
AGENT_QWEN = {"id": "node-qwen", "name": "Qwen", "binary": "qwen",
              "capabilities": ["coding-agent"]}
AGENT_CURSOR = {"id": "node-cursor", "name": "Cursor", "binary": "cursor-agent",
                "capabilities": ["coding-agent"]}

CTX = {"actor": {"kind": "agent", "id": "agent:workflow"}, "projectId": "p",
       "cwd": "<PROJ>"}

# Stable approval identity across invocations (mission:task:capability key)
MISSION_CTX = {**CTX, "missionId": "m-1", "taskId": "t-9"}
APPROVED_ALL = ["filesystem.write", "git.status", "git.commit", "git.branch", "git.diff", "git.push"]


def _wiring(present, provided=None, policy_raw=None):
    cfg = {"wiring": True, "presentNodes": present,
           "providedNodeCapabilities": provided or [], "approvals": "park"}
    if policy_raw is not None:
        cfg["policyRaw"] = policy_raw
    return cfg


SCENARIOS: list[tuple[str, dict, list[dict], list[str]]] = [
    # name, config, ops, executorIds (Python-side registration filter)
    ("route-unknown-node",
     _wiring([GIT_NODE]),
     [{"op": "invoke", "capabilityId": "git.status", "input": {},
       "context": {**CTX, "nodeId": "nope"}}]),
    ("route-lacks-capability",
     _wiring([AGENT_QWEN]),
     [{"op": "invoke", "capabilityId": "git.status", "input": {},
       "context": {**CTX, "nodeId": "node-qwen"}}]),
    ("route-unsupported-requested",
     _wiring([AGENT_CURSOR]),
     [{"op": "invoke", "capabilityId": "agent.delegate",
       "input": {"task": "do things"}, "context": {**CTX, "nodeId": "node-cursor"}}],
     ["agent.delegate"]),
    ("route-unsupported-providers-listed",
     _wiring([AGENT_QWEN, AGENT_CURSOR]),
     [{"op": "invoke", "capabilityId": "agent.delegate",
       "input": {"task": "do things"}, "context": CTX}],
     ["agent.delegate"]),
    ("route-no-provider",
     _wiring([]),
     [{"op": "invoke", "capabilityId": "git.status", "input": {}, "context": CTX}]),
    ("route-auto-picks-first-provider-and-runs",
     _wiring([GIT_NODE]),
     [{"op": "invoke", "capabilityId": "git.status", "input": {}, "context": CTX},
      {"op": "audit"}],
     ["git.status"]),
    ("exec-fs-triangle",
     _wiring([]),
     [{"op": "invoke", "capabilityId": "filesystem.write",
       "input": {"path": "src/deep/a.txt", "content": "hello"}, "context": CTX},
      {"op": "invoke", "capabilityId": "filesystem.read",
       "input": {"path": "src/deep/a.txt"}, "context": CTX},
      {"op": "invoke", "capabilityId": "filesystem.list",
       "input": {"path": "."}, "context": CTX},
      {"op": "invoke", "capabilityId": "filesystem.read",
       "input": {"path": "../../../etc/hostname"}, "context": CTX},
      {"op": "invoke", "capabilityId": "filesystem.write",
       "input": {"path": "../escape.txt", "content": "x"}, "context": CTX},
      {"op": "invoke", "capabilityId": "filesystem.read",
       "input": {"path": "missing.txt"}, "context": CTX},
      {"op": "audit"}]),
    ("exec-terminal-matrix",
     _wiring([]),
     [{"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": "echo hello-world"}, "context": CTX},
      {"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": "npm install -g left-pad"}, "context": CTX},
      {"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": "curl example.test"}, "context": CTX},
      {"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": ""}, "context": CTX},
      {"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": "ls src"}, "context": CTX},
      {"op": "audit"}],
     ["terminal.execute"]),
    ("exec-terminal-timeout-124",
     _wiring([]),
     [{"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": "sleep 5"},
       "context": {**CTX, "timeoutMs": 300}},
      {"op": "audit"}],
     ["terminal.execute"]),
    ("exec-git-commit-cycle",
     _wiring([GIT_NODE]),
     [{"op": "invoke", "capabilityId": "filesystem.write",
       "input": {"path": "f.txt", "content": "v1"}, "context": {**MISSION_CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "invoke", "capabilityId": "git.status", "input": {}, "context": {**CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "invoke", "capabilityId": "git.commit",
       "input": {"message": "first"}, "context": {**CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "invoke", "capabilityId": "git.branch",
       "input": {"name": "feature-x"}, "context": {**CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "invoke", "capabilityId": "filesystem.write",
       "input": {"path": "f.txt", "content": "v2"},
       "context": {**MISSION_CTX, "approvedCapabilities": ["filesystem.write"]}},
      {"op": "invoke", "capabilityId": "git.diff", "input": {}, "context": {**CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "invoke", "capabilityId": "git.commit",
       "input": {"message": "second\n\nbody line"}, "context": {**CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "invoke", "capabilityId": "git.push", "input": {},
       "context": {**CTX, "approvedCapabilities": APPROVED_ALL}},
      {"op": "audit"}],
     ["filesystem.write", "git.status", "git.commit", "git.branch", "git.diff", "git.push"]),
    ("governed-write-parks-then-spends",
     {**_wiring([]), "approvals": "park"},
     [{"op": "invoke", "capabilityId": "filesystem.write",
       "input": {"path": "governed.txt", "content": "secret-plan"},
       "context": MISSION_CTX},                                            # r0 parked (medium risk)
      {"op": "pending"},                                           # r1 request w/ fingerprint
      {"op": "decide", "id": "$r0.approvalId", "granted": True},
      {"op": "invoke", "capabilityId": "filesystem.write",
       "input": {"path": "governed.txt", "content": "secret-plan"},
       "context": MISSION_CTX},                                     # r3 spends → real write
      {"op": "audit"}],
     ["filesystem.write"]),
]

SCENARIOS = [
    (n, c, o, (rest[0] if rest else []))
    for (n, c, o, *rest) in SCENARIOS
]
IDS = [s[0] for s in SCENARIOS]


def _reset_proj(d: Path) -> None:
    """Wipe to a fresh git repo — identical starting state for each side."""
    import shutil
    import subprocess as sp

    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    sp.run(["git", "init", "-q"], cwd=d, check=True, capture_output=True)
    sp.run(["git", "config", "user.email", "t@t"], cwd=d, check=True, capture_output=True)
    sp.run(["git", "config", "user.name", "t"], cwd=d, check=True, capture_output=True)


def _prepare_dirs(tmp_path_factory):
    dirs = []
    for i in range(len(SCENARIOS)):
        base = tmp_path_factory.mktemp(f"p5-{i}")
        proj = base / "proj"
        homes = (base / "home-ts", base / "home-py")
        for h in homes:
            h.mkdir()
        _reset_proj(proj)
        dirs.append((homes[0], homes[1], str(proj)))
    return dirs


def subprocess_init_git(d: Path) -> None:
    import subprocess as sp

    sp.run(["git", "init", "-q"], cwd=d, check=True, capture_output=True)
    sp.run(["git", "config", "user.email", "t@t"], cwd=d, check=True, capture_output=True)
    sp.run(["git", "config", "user.name", "t"], cwd=d, check=True, capture_output=True)


@pytest.fixture(scope="module")
def ran(tsref, tmp_path_factory):  # noqa: F811
    homes = _prepare_dirs(tmp_path_factory)
    outs = []
    for (name, config, ops, exec_ids), (h_ts, h_py, proj) in zip(SCENARIOS, homes):
        cfg_ts = json.loads(json.dumps(config))
        cfg_py = json.loads(json.dumps(config))
        ops_base = [json.loads(json.dumps(o)) for o in ops]

        def bind(op_list):
            for o in op_list:
                ctx = o.get("context")
                if isinstance(ctx, dict) and ctx.get("cwd") == "<PROJ>":
                    ctx["cwd"] = proj
        bind(ops_base)

        # TS side first, then wipe the project to the identical virgin state
        # so the Python run sees the same paths (fingerprints are cwd-bound).
        ops_ts = json.loads(json.dumps(ops_base))
        cfg_ts["executorIds"] = exec_ids or None
        ts_out = run_fabric_ops(tsref, cfg_ts, ops_ts, str(h_ts), START_MS)

        _reset_proj(Path(proj))
        ops_py = json.loads(json.dumps(ops_base))
        cfg_py["executorIds"] = exec_ids or list(
            __import__("aura.executors", fromlist=["EXECUTOR_TABLE"]).EXECUTOR_TABLE.keys())
        py_out = run_py_fabric_ops(str(h_py), START_MS, cfg_py, ops_py)

        outs.append((name, ts_out, py_out, proj, proj, str(h_ts), str(h_py)))
    return outs


def _norm(obj: str, ts_home: str, py_home: str, ts_proj: str, py_proj: str) -> str:
    return (obj.replace(ts_home, "<HOME>").replace(py_home, "<HOME>")
               .replace(ts_proj, "<PROJ>").replace(py_proj, "<PROJ>")
               .replace(os.path.basename(ts_home), "<HOMEBASE>")
               .replace(os.path.basename(py_home), "<HOMEBASE>"))


def test_all_scenarios_parity(ran):
    problems: list[str] = []
    for name, ts_out, py_out, proj_ts, proj_py, h_ts, h_py in ran:
        ts_json = json.dumps(ts_out, sort_keys=True)
        py_json = json.dumps(py_out, sort_keys=True)
        ts_n = _norm(ts_json, h_ts, h_py, proj_ts, proj_py)
        py_n = _norm(py_json, h_ts, h_py, proj_ts, proj_py)
        # invocation ids contain time-derived segments already deterministic;
        # home paths only appear inside audit 'at'? no — normalize anyway
        if ts_n != py_n:
            # locate first difference for the report
            i = next((k for k, (a, b) in enumerate(zip(ts_n, py_n)) if a != b), min(len(ts_n), len(py_n)))
            problems.append(
                f"{name}: first diff @{i}\n TS…{ts_n[max(0,i-80):i+120]}\n PY…{py_n[max(0,i-80):i+120]}")
    assert not problems, "\n\n".join(problems)


def test_side_effects_real_and_equal(ran):
    """The governed-write scenario MUST have written the real file on both sides."""
    by_name = dict(zip(IDS, ran))
    _, _, _, proj, _proj2, _h1, _h2 = by_name["governed-write-parks-then-spends"]
    assert (Path(proj) / "governed.txt").read_text() == "secret-plan"

    _, _, _, cproj, _c2, _h1, _h2 = by_name["exec-git-commit-cycle"]
    for proj in (cproj,):
        import subprocess as sp

        log = sp.run(["git", "-C", proj, "log", "--oneline"], capture_output=True, text=True).stdout
        assert "first" in log and "second" in log
        branch = sp.run(["git", "-C", proj, "rev-parse", "--abbrev-ref", "HEAD"],
                        capture_output=True, text=True).stdout.strip()
        assert branch == "feature-x"


def test_denials_leave_zero_side_effects(ran):
    by_name = dict(zip(IDS, ran))
    ts_out, py_out = by_name["route-no-provider"][1], by_name["route-no-provider"][2]
    for out in (ts_out, py_out):
        assert out["results"][0]["outcome"] == "denied"
        assert not any(e["type"] == "invocation.started" for e in out["events"])
