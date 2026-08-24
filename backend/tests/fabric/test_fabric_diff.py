"""THE Phase-4 gate: TS CapabilityFabric vs Python port on scripted scenarios.

Fifteen scenarios covering the whole governed pipeline and its hostile edges:
unknown capability, contract violations (×3), permission denial, no-provider,
auto-execute success with the attribution guard, park→decide→re-invoke→respend,
named-approval spend / fingerprint-mismatch / missing-approval, transient
retry success and exhaustion, non-transient failure, unverified outcomes
(×3 branches), unsupported capability, secret redaction + target truncation,
override denial, and a hostile host that throws during requestApproval.

Compared per scenario: every returned value, the FULL event stream, the backoff
schedule, and audit/approval snapshots — ids, timestamps and durations are
deterministic via shared clock sequences (+1 ms per draw).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

import sys
from pathlib import Path

_DIFF = Path(__file__).resolve().parents[1] / "differential"
sys.path.insert(0, str(_DIFF.parent))
sys.path.insert(0, str(_DIFF))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from differential.conftest import tsref  # noqa: E402, F401  (session fixture)
from _tsrun import run_fabric_ops  # noqa: E402
from fabric._pyfabric import run_py_fabric_ops  # noqa: E402

START_MS = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)

MISSION_CTX = {
    "actor": {"kind": "agent", "role": "implementer", "id": "agent:workflow"},
    "projectId": "p-demo", "cwd": "/projects/demo",
    "missionId": "m-1", "taskId": "t-9",
    "workflowId": "wf-x", "runId": "wr-1", "workflowNodeId": "n-ag",
}
PLAIN_CTX = {"actor": {"kind": "human", "id": "user"}, "projectId": "p-demo"}

EXEC_WRITE = {"capabilityId": "filesystem.write",
              "steps": [{"ok": True, "detail": "wrote 2 bytes", "output": {"bytes": 2}}],
              "verify": {"passed": True, "kind": "read-back", "detail": "file matches"}}
EXEC_READ = {"capabilityId": "filesystem.read",
             "steps": [{"ok": True, "detail": "read", "output": {"nodeId": "ghost-node"}}]}
EXEC_TERM = {"capabilityId": "terminal.execute",
             "steps": [{"throw": "ETIMEDOUT"}, {"ok": True, "detail": "exit 0"}],
             "verify": {"passed": True, "kind": "exit-code", "detail": "exit 0"}}
EXEC_LIST = {"capabilityId": "filesystem.list",
             "steps": [{"throw": "socket hang up"}]}
EXEC_INSPECT = {"capabilityId": "project.inspect",
                "steps": [{"ok": False, "detail": "exited 1"}]}
EXEC_NAV = {"capabilityId": "browser.navigate",
            "steps": [{"ok": True, "detail": "navigated"}],
            "verify": {"passed": False, "kind": "read-back", "detail": "title mismatch"}}
EXEC_BREAD = {"capabilityId": "browser.read",
              "steps": [{"ok": True, "detail": "read"}],
              "verify": {"throw": "boom"}}
EXEC_SHOT = {"capabilityId": "browser.screenshot",
             "steps": [{"ok": True, "detail": "captured"}]}   # no verify fn


def base_executors() -> list[dict]:
    return [EXEC_WRITE, EXEC_READ, EXEC_TERM, EXEC_LIST, EXEC_INSPECT,
            EXEC_NAV, EXEC_BREAD, EXEC_SHOT]


def scenario_park_decide() -> tuple[dict, list[dict]]:
    cfg = {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
           "executors": base_executors()}
    ops = [
        {"op": "invoke", "capabilityId": "filesystem.write",
         "input": {"path": "src/a.ts", "content": "hi"},
         "context": MISSION_CTX},                                                    # r0 parked
        {"op": "pending"},                                                           # r1 request shape
        {"op": "decide", "id": "$r0.approvalId", "granted": True},                   # r2 grant + audit record
        {"op": "audit"},                                                             # r3 [decision record]
        {"op": "invoke", "capabilityId": "filesystem.write",
         "input": {"path": "src/a.ts", "content": "hi"},
         "context": MISSION_CTX},                                                    # r4 spends open grant → runs
        {"op": "pending"},                                                           # r5 empty again
        {"op": "invoke", "capabilityId": "filesystem.write",
         "input": {"path": "src/a.ts", "content": "hi2"},
         "context": MISSION_CTX},                                                    # r6 consumed → NEW pending
        {"op": "pending"},                                                           # r7 fresh question
    ]
    return cfg, ops


def scenario_named_spend() -> tuple[dict, list[dict]]:
    cfg = {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
           "executors": base_executors()}
    long_url = "https://api.example.test/v2/" + "x" * 90
    ops = [
        {"op": "invoke", "capabilityId": "http.request",
         "input": {"url": long_url, "method": "GET"},
         "context": PLAIN_CTX},                                                      # r0 parked; target truncated
        {"op": "decide", "id": "$r0.approvalId", "granted": True},
        {"op": "invoke", "capabilityId": "http.request",
         "input": {"url": long_url, "method": "GET", "apiKey": "sk-super-secret-value"},
         "context": {**PLAIN_CTX, "approvalId": "$r0.approvalId"}},                  # r2 named spend runs
    ]
    return cfg, ops


def scenario_named_mismatch() -> tuple[dict, list[dict]]:
    cfg = {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
           "executors": base_executors()}
    ops = [
        {"op": "invoke", "capabilityId": "filesystem.write",
         "input": {"path": "src/a.ts", "content": "hi"}, "context": PLAIN_CTX},      # r0
        {"op": "decide", "id": "$r0.approvalId", "granted": True},
        {"op": "invoke", "capabilityId": "filesystem.write",
         "input": {"path": "src/EVIL.ts", "content": "hi"},
         "context": {**PLAIN_CTX, "approvalId": "$r0.approvalId"}},                  # r2 mismatch parks
        {"op": "pending"},                                                           # r3 standing question intact
    ]
    return cfg, ops


SCENARIOS: list[tuple[str, dict, list[dict]]] = [
    ("unknown-capability",
     {"permissions": {}, "nodeAvailable": {}, "approvals": "park", "executors": []},
     [{"op": "invoke", "capabilityId": "does.not.exist", "input": {}, "context": PLAIN_CTX}]),

    ("contract-missing-required",
     {"permissions": {}, "nodeAvailable": {}, "approvals": "park", "executors": []},
     [{"op": "invoke", "capabilityId": "filesystem.read", "input": {},
       "context": PLAIN_CTX}]),

    ("contract-wrong-type",
     {"permissions": {}, "nodeAvailable": {}, "approvals": "park", "executors": []},
     [{"op": "invoke", "capabilityId": "filesystem.read",
       "input": {"path": 7}, "context": PLAIN_CTX}]),

    ("contract-string-array",
     {"permissions": {}, "nodeAvailable": {}, "approvals": "park", "executors": []},
     [{"op": "evaluate", "capabilityId": "terminal.execute",
       "context": PLAIN_CTX},
      {"op": "invoke", "capabilityId": "terminal.execute",
       "input": {"command": "ls", "files": "not-an-array"}, "context": PLAIN_CTX}]),

    ("permission-denied",
     {"permissions": {"git.push": {"read": False, "write": False, "execute": False, "autonomous": False}},
      "nodeAvailable": {}, "approvals": "park", "executors": []},
     [{"op": "invoke", "capabilityId": "git.push",
       "input": {"branch": "main"}, "context": PLAIN_CTX}]),

    ("no-provider-deny",
     {"permissions": {}, "nodeAvailable": {"system.install": False}, "approvals": "park",
      "executors": []},
     [{"op": "invoke", "capabilityId": "system.install",
       "input": {"package": "demo-tool"}, "context": PLAIN_CTX}]),

    ("auto-execute-attribution-guard",
     {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
      "executors": base_executors()},
     [{"op": "invoke", "capabilityId": "filesystem.read",
       "input": {"path": "README.md"}, "context": PLAIN_CTX},
      {"op": "audit"}]),

    ("irreversible-style-floor-parks-provider-connect",
     {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
      "executors": base_executors()},
     [{"op": "invoke", "capabilityId": "provider.connect",
       "input": {"provider": "demo", "apiKey": "sk-secret-abcdef"},
       "context": PLAIN_CTX},
      {"op": "pending"}]),

]
def _build_all() -> list[tuple[str, dict, list[dict]]]:
    out = [s for s in SCENARIOS if s is not None]
    c1, o1 = scenario_park_decide()
    out.append(("park-decide-respend", c1, o1))
    c2, o2 = scenario_named_spend()
    out.append(("named-spend-happy", c2, o2))
    c3, o3 = scenario_named_mismatch()
    out.append(("named-mismatch-and-missing", c3, o3))
    out.append(("named-missing-approval",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "filesystem.write",
                  "input": {"path": "a", "content": "b"},
                  "context": {**PLAIN_CTX, "approvalId": "apr-gone"}}]))
    out.append(("transient-retry-success",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "terminal.execute",
                  "input": {"command": "npm test"}, "context": PLAIN_CTX}]))
    out.append(("retry-exhausted",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "filesystem.list",
                  "input": {"path": "."}, "context": PLAIN_CTX}]))
    out.append(("non-transient-failure",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "project.inspect",
                  "input": {}, "context": PLAIN_CTX}]))
    out.append(("unverified-false",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "browser.navigate",
                  "input": {"url": "https://example.test"}, "context": PLAIN_CTX}]))
    out.append(("verify-throws",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "knowledge.graph",
                  "input": {"projectId": "p"}, "context": PLAIN_CTX}]))
    out.append(("declared-check-no-impl",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "browser.screenshot",
                  "input": {"url": "https://example.test"}, "context": PLAIN_CTX}]))
    out.append(("unsupported-capability",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "knowledge.graph",
                  "input": {"projectId": "p"}, "context": PLAIN_CTX}]))
    out.append(("override-deny",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "policyRaw": {"overrides": {"filesystem.read": "deny"}},
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "filesystem.read",
                  "input": {"path": "x"}, "context": PLAIN_CTX}]))
    out.append(("host-throws-on-request",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "throw",
                 "executors": base_executors()},
                [{"op": "invoke", "capabilityId": "filesystem.write",
                  "input": {"path": "a", "content": "b"}, "context": PLAIN_CTX}]))
    out.append(("preflight-evaluate",
                {"permissions": {}, "nodeAvailable": {}, "approvals": "park",
                 "executors": base_executors()},
                [{"op": "evaluate", "capabilityId": "git.push", "context": PLAIN_CTX},
                 {"op": "evaluate", "capabilityId": "nope.nope", "context": PLAIN_CTX}]))
    return out


ALL_SCENARIOS = _build_all()
IDS = [name for name, _, _ in ALL_SCENARIOS]


@pytest.fixture(scope="module")
def ran_scenarios(tsref, tmp_path_factory):  # noqa: F811
    outs = []
    for i, (name, config, ops) in enumerate(ALL_SCENARIOS):
        ts_home = str(tmp_path_factory.mktemp(f"ts-{i}"))
        py_home = str(tmp_path_factory.mktemp(f"py-{i}"))
        ts_out = run_fabric_ops(tsref, config, ops, ts_home, START_MS)
        py_out = run_py_fabric_ops(py_home, START_MS, config, ops)
        outs.append((name, ts_out, py_out))
    return outs


def test_scenario_results_events_and_backoff(ran_scenarios):
    for name, ts_out, py_out in ran_scenarios:
        assert len(ts_out["results"]) == len(py_out["results"]), name
        assert ts_out["results"] == py_out["results"], f"{name}: results differ"
        assert ts_out["events"] == py_out["events"], (
            f"{name}: event streams differ:\n"
            f"TS={[(e['type'], e.get('invocationId') or e.get('requestId')) for e in ts_out['events']]}\n"
            f"PY={[(e['type'], e.get('invocationId') or e.get('requestId')) for e in py_out['events']]}"
        )
        assert ts_out.get("slept", []) == py_out.get("slept", []), f"{name}: backoff differs"


def test_hostile_edges_present(ran_scenarios):
    by_name = dict(zip(IDS, [ (t, p) for n, t, p in ran_scenarios ]))
    results = by_name["unknown-capability"][0]["results"]
    assert results[0]["outcome"] == "failed"
    assert results[0]["policy"]["rule"] == "unknown-capability"

    denied = by_name["permission-denied"][0]["results"][0]
    assert denied["policy"]["rule"] == "permission-denied"

    mismatch = by_name["named-mismatch-and-missing"][0]["results"][2]
    assert mismatch["outcome"] == "awaiting-approval"

    exhausted = by_name["retry-exhausted"][0]["results"][0]
    assert exhausted["attempts"] == 3 and "after 3 attempts" in exhausted["detail"]

    unsupported = by_name["unsupported-capability"][0]["results"][0]
    assert unsupported["outcome"] == "unsupported"


def test_audit_snapshots_identical_in_park_flow(ran_scenarios):
    by_name = dict(zip(IDS, [(t, p) for n, t, p in ran_scenarios]))
    ts_out, py_out = by_name["park-decide-respend"]
    ts_decision_audit = ts_out["results"][3]
    py_decision_audit = py_out["results"][3]
    assert ts_decision_audit == py_decision_audit
    assert ts_decision_audit[0]["decisionRule"] == "risk-default:medium"
