"""The scripted scenarios both fabrics are run through.

Kept separate from the harness so the coverage is readable as a list of
claims rather than buried in plumbing. Every scenario names a behaviour
the Fabric is supposed to have.
"""

from __future__ import annotations

from typing import Any

AGENT = {"actor": {"kind": "agent", "id": "mission:m1"}, "projectId": "proj"}
GIT_NODE = {"id": "git", "name": "Git", "capabilities": ["source-control"]}
OPENCODE = {"id": "opencode", "name": "OpenCode", "capabilities": ["coding-agent"],
            "binary": "opencode"}
CLAUDE = {"id": "claude", "name": "Claude Code", "capabilities": ["coding-agent"],
          "binary": "claude"}
TERMINAL = {"id": "terminal", "name": "Terminal", "capabilities": ["terminal"]}
HTTP = {"id": "http", "name": "HTTP", "capabilities": ["http-client"]}

PERMISSIVE = {
    "byRisk": {"low": "auto-execute", "medium": "auto-execute", "high": "auto-execute"},
    "overrides": {},
    "allowAutonomous": True,
}


def _ctx(**kw: Any) -> dict[str, Any]:
    return {**AGENT, **kw}


def build_scenarios() -> list[dict[str, Any]]:
    s: list[dict[str, Any]] = []

    # ── the manifest itself ──────────────────────────────────────────
    s.append({"name": "manifest/complete", "steps": [{"op": "manifest"}]})

    # ── contract validation ──────────────────────────────────────────
    s.append({
        "name": "contract/unknown-capability",
        "steps": [{"op": "invoke", "capabilityId": "nope.nothing", "input": {}}],
    })
    s.append({
        "name": "contract/missing-required",
        "steps": [
            {"op": "invoke", "capabilityId": "filesystem.write", "input": {"path": "a.txt"}},
            {"op": "invoke", "capabilityId": "filesystem.read", "input": {}},
            {"op": "invoke", "capabilityId": "filesystem.read", "input": {"path": ""}},
        ],
    })
    s.append({
        "name": "contract/wrong-types",
        "steps": [
            {"op": "invoke", "capabilityId": "filesystem.read", "input": {"path": 42}},
            {"op": "invoke", "capabilityId": "git.diff", "input": {"staged": "yes"}},
            {"op": "invoke", "capabilityId": "filesystem.read", "input": {"path": ["a"]}},
            {"op": "invoke", "capabilityId": "git.diff", "input": {"staged": True},
             "context": _ctx()},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.diff", "behavior": "ok"}],
    })

    # ── routing: every denial code ───────────────────────────────────
    s.append({
        "name": "routing/no-provider",
        "steps": [{"op": "invoke", "capabilityId": "git.status", "context": _ctx()}],
        "nodes": [],
        "executors": [{"capabilityId": "git.status", "behavior": "ok"}],
    })
    s.append({
        "name": "routing/unknown-node",
        "steps": [{"op": "invoke", "capabilityId": "git.status",
                   "context": _ctx(nodeId="svn")}],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.status", "behavior": "ok"}],
    })
    s.append({
        "name": "routing/node-lacks-capability",
        "steps": [{"op": "invoke", "capabilityId": "git.status",
                   "context": _ctx(nodeId="terminal")}],
        "nodes": [GIT_NODE, TERMINAL],
        "executors": [{"capabilityId": "git.status", "behavior": "ok"}],
    })
    s.append({
        "name": "routing/node-unsupported-requested",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "do it"},
                   "context": _ctx(nodeId="claude", approvedCapabilities=["agent.delegate"])}],
        "nodes": [OPENCODE, CLAUDE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok",
                       "supportsNodes": ["opencode"]}],
    })
    s.append({
        "name": "routing/node-unsupported-none-drivable",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "do it"},
                   "context": _ctx(approvedCapabilities=["agent.delegate"])}],
        "nodes": [CLAUDE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok",
                       "supportsNodes": ["opencode"]}],
    })
    s.append({
        "name": "routing/catalogue-order-is-the-tiebreak",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "do it"},
                   "context": _ctx(approvedCapabilities=["agent.delegate"])}],
        # Both drivable; the FIRST in catalogue order must win.
        "nodes": [CLAUDE, OPENCODE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok",
                       "supportsNodes": ["opencode", "claude"]}],
    })
    s.append({
        "name": "routing/requested-node-is-honoured-not-substituted",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "do it"},
                   "context": _ctx(nodeId="claude",
                                   approvedCapabilities=["agent.delegate"])}],
        "nodes": [OPENCODE, CLAUDE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok",
                       "supportsNodes": ["opencode", "claude"]}],
    })

    # ── policy floors reached through the fabric ─────────────────────
    s.append({
        "name": "policy/irreversible-floor-survives-permissive-config",
        "policy": PERMISSIVE,
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "rewrite everything"}, "context": _ctx()},
                  {"op": "pending"}],
        "nodes": [OPENCODE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok"}],
    })
    s.append({
        "name": "policy/system-floor-survives-permissive-config",
        "policy": PERMISSIVE,
        "steps": [{"op": "invoke", "capabilityId": "system.install",
                   "input": {"nodeId": "pnpm"}, "context": _ctx()},
                  {"op": "pending"}],
        "executors": [{"capabilityId": "system.install", "behavior": "ok"}],
    })
    s.append({
        "name": "policy/authorization-floor-survives-permissive-config",
        "policy": PERMISSIVE,
        "steps": [{"op": "invoke", "capabilityId": "provider.connect",
                   "input": {"providerId": "groq", "apiKey": "sk-secret-value"},
                   "context": _ctx()},
                  {"op": "pending"}],
        "executors": [{"capabilityId": "provider.connect", "behavior": "ok"}],
    })
    s.append({
        "name": "policy/permission-denied-from-narrowed-run-scope",
        "grantsByRun": {"run1": {"read": True, "write": False, "execute": False,
                                 "autonomous": False}},
        "steps": [{"op": "invoke", "capabilityId": "filesystem.write",
                   "input": {"path": "a.txt", "content": "x"},
                   "context": _ctx(runId="run1", workflowNodeId="n1")}],
        "executors": [{"capabilityId": "filesystem.write", "behavior": "ok"}],
    })
    s.append({
        "name": "policy/deny-override-beats-a-floor",
        "policy": {**PERMISSIVE, "overrides": {"agent.delegate": "deny"}},
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "x"}, "context": _ctx()}],
        "nodes": [OPENCODE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok"}],
    })
    s.append({
        "name": "policy/node-allowlist-denies",
        "policy": {**PERMISSIVE, "nodeAllowlists": {"git.commit": ["other"]}},
        "steps": [{"op": "invoke", "capabilityId": "git.commit",
                   "input": {"message": "wip"}, "context": _ctx()}],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })

    # ── approvals ────────────────────────────────────────────────────
    s.append({
        "name": "approval/parks-then-grants-then-runs",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "first"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "pending"},
            {"op": "decide", "granted": True, "decidedBy": "user"},
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "first"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "pending"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok",
                       "verify": "pass"}],
    })
    s.append({
        "name": "approval/a-grant-is-single-use",
        # Spending the grant must not leave it spendable. A refresh, a
        # reconnect or a replayed request must not re-authorize an action
        # that already ran.
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "decide", "granted": True},
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            # Third call: the grant is spent, so this must park again.
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "pending"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/a-granted-request-can-only-be-spent-once",
        # Exercises the single-use guard directly rather than through the
        # gate, which carries a guard of its own — otherwise removing one
        # of the two would be invisible.
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "decideAndDoubleSpend"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/consuming-a-pending-request-does-nothing",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "consumeFirst"},
            {"op": "pending"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/one-question-however-many-attempts",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "pending"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/workflow-run-node-is-one-question",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(runId="r1", workflowNodeId="n1")},
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(runId="r1", workflowNodeId="n1")},
            {"op": "pending"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/decline-records-and-runs-nothing",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "decide", "granted": False, "decidedBy": "user",
             "reason": "not yet"},
            {"op": "pending"},
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/deciding-twice-is-harmless",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "decide", "granted": True},
            {"op": "decide", "granted": True},
            {"op": "decideById", "id": "nonexistent", "granted": True},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/inline-grant-executes-without-parking",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(approvedCapabilities=["git.commit"])},
            {"op": "pending"},
        ],
        "nodes": [GIT_NODE],
        "executors": [{"capabilityId": "git.commit", "behavior": "ok"}],
    })
    s.append({
        "name": "approval/a-grant-does-not-cover-the-next-capability",
        "steps": [
            {"op": "invoke", "capabilityId": "git.commit", "input": {"message": "x"},
             "context": _ctx(approvedCapabilities=["git.commit"])},
            {"op": "invoke", "capabilityId": "git.branch", "input": {"name": "feat"},
             "context": _ctx(approvedCapabilities=["git.commit"])},
        ],
        "nodes": [GIT_NODE],
        "executors": [
            {"capabilityId": "git.commit", "behavior": "ok"},
            {"capabilityId": "git.branch", "behavior": "ok"},
        ],
    })
    s.append({
        "name": "approval/secrets-are-redacted-in-the-request-and-the-audit",
        "steps": [
            {"op": "invoke", "capabilityId": "provider.connect",
             "input": {"providerId": "groq", "apiKey": "sk-super-secret-do-not-log"},
             "context": _ctx(missionId="m1", taskId="t1")},
            {"op": "pending"},
        ],
        "executors": [{"capabilityId": "provider.connect", "behavior": "ok"}],
    })

    # ── execution, recovery and verification ─────────────────────────
    s.append({
        "name": "execute/unsupported-capability-has-no-executor",
        "steps": [{"op": "invoke", "capabilityId": "browser.read", "context": _ctx()},
                  {"op": "supported"}],
        "nodes": [{"id": "pw", "name": "Playwright",
                   "capabilities": ["browser-automation"]}],
    })
    s.append({
        "name": "execute/non-transient-failure-does-not-retry",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.read",
                   "input": {"path": "a.txt"}, "context": _ctx()}],
        "executors": [{"capabilityId": "filesystem.read", "behavior": "fail",
                       "detail": "permission denied"}],
    })
    s.append({
        "name": "execute/transient-failure-retries-to-the-bound",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.read",
                   "input": {"path": "a.txt"}, "context": _ctx()}],
        "executors": [{"capabilityId": "filesystem.read", "behavior": "transient"}],
    })
    s.append({
        "name": "execute/transient-then-recovers",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.read",
                   "input": {"path": "a.txt"}, "context": _ctx()}],
        "executors": [{"capabilityId": "filesystem.read",
                       "behavior": "transient-then-ok", "succeedOnAttempt": 2}],
    })
    s.append({
        "name": "execute/a-throwing-executor-is-a-failure-not-a-crash",
        "steps": [
            {"op": "invoke", "capabilityId": "filesystem.read",
             "input": {"path": "a.txt"}, "context": _ctx()},
            {"op": "invoke", "capabilityId": "filesystem.list",
             "input": {}, "context": _ctx()},
        ],
        "executors": [
            {"capabilityId": "filesystem.read", "behavior": "throw",
             "detail": "boom"},
            {"capabilityId": "filesystem.list", "behavior": "throw-empty"},
        ],
    })
    s.append({
        "name": "verify/failed-check-is-unverified-not-succeeded",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.write",
                   "input": {"path": "a.txt", "content": "x"},
                   "context": _ctx(approvedCapabilities=["filesystem.write"])}],
        "executors": [{"capabilityId": "filesystem.write", "behavior": "ok",
                       "verify": "fail"}],
    })
    s.append({
        "name": "verify/a-throwing-check-fails-closed",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.write",
                   "input": {"path": "a.txt", "content": "x"},
                   "context": _ctx(approvedCapabilities=["filesystem.write"])}],
        "executors": [{"capabilityId": "filesystem.write", "behavior": "ok",
                       "verify": "throw"}],
    })
    s.append({
        "name": "verify/declared-but-unimplemented-is-null-not-passed",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.write",
                   "input": {"path": "a.txt", "content": "x"},
                   "context": _ctx(approvedCapabilities=["filesystem.write"])}],
        "executors": [{"capabilityId": "filesystem.write", "behavior": "ok"}],
    })
    s.append({
        "name": "verify/no-declared-check-reports-so",
        "steps": [{"op": "invoke", "capabilityId": "filesystem.read",
                   "input": {"path": "a.txt"}, "context": _ctx()}],
        "executors": [{"capabilityId": "filesystem.read", "behavior": "ok",
                       "detail": "read it"}],
    })

    # ── attribution ──────────────────────────────────────────────────
    s.append({
        "name": "attribution/executor-report-wins-over-resolution",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "x"},
                   "context": _ctx(approvedCapabilities=["agent.delegate"])}],
        "nodes": [OPENCODE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok",
                       "output": {"nodeId": "opencode", "exitCode": 0}}],
    })
    s.append({
        "name": "attribution/a-denied-call-never-claims-execution",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "x"},
                   "context": _ctx(nodeId="claude",
                                   approvedCapabilities=["agent.delegate"])}],
        "nodes": [OPENCODE, CLAUDE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok",
                       "supportsNodes": ["opencode"]}],
    })
    s.append({
        "name": "attribution/a-nodeless-capability-never-claims-a-node",
        # system.install's output names the node being INSTALLED — the
        # object of the work, not the actor. It must not become attribution.
        "steps": [{"op": "invoke", "capabilityId": "system.install",
                   "input": {"nodeId": "pnpm"},
                   "context": _ctx(approvedCapabilities=["system.install"])}],
        "executors": [{"capabilityId": "system.install", "behavior": "ok",
                       "output": {"nodeId": "pnpm", "installOutcome": "installed"},
                       "verify": "pass"}],
    })
    s.append({
        "name": "attribution/a-parked-call-never-claims-execution",
        "steps": [{"op": "invoke", "capabilityId": "agent.delegate",
                   "input": {"task": "x"}, "context": _ctx()}],
        "nodes": [OPENCODE],
        "executors": [{"capabilityId": "agent.delegate", "behavior": "ok"}],
    })

    # ── pre-flight evaluate agrees with invoke ───────────────────────
    s.append({
        "name": "evaluate/agrees-with-routing",
        "steps": [
            {"op": "evaluate", "capabilityId": "git.status", "context": _ctx()},
            {"op": "evaluate", "capabilityId": "git.status",
             "context": _ctx(nodeId="svn")},
            {"op": "evaluate", "capabilityId": "agent.delegate", "context": _ctx()},
            {"op": "evaluate", "capabilityId": "nope.nothing", "context": _ctx()},
            {"op": "evaluate", "capabilityId": "project.list", "context": _ctx()},
        ],
        "nodes": [GIT_NODE, OPENCODE],
        "executors": [
            {"capabilityId": "git.status", "behavior": "ok"},
            {"capabilityId": "agent.delegate", "behavior": "ok",
             "supportsNodes": ["opencode"]},
        ],
    })

    # ── internal capabilities need no node ───────────────────────────
    s.append({
        "name": "internal/aura-internal-needs-no-node",
        "steps": [
            {"op": "invoke", "capabilityId": "project.list", "context": _ctx()},
            {"op": "invoke", "capabilityId": "knowledge.graph",
             "input": {"projectId": "proj"}, "context": _ctx()},
        ],
        "nodes": [],
        "executors": [
            {"capabilityId": "project.list", "behavior": "ok", "detail": "3 projects"},
            {"capabilityId": "knowledge.graph", "behavior": "ok"},
        ],
    })

    # ── http surface ─────────────────────────────────────────────────
    s.append({
        "name": "http/needs-a-client-node",
        "steps": [
            {"op": "invoke", "capabilityId": "http.request",
             "input": {"url": "https://example.invalid"},
             "context": _ctx(approvedCapabilities=["http.request"])},
            {"op": "invoke", "capabilityId": "http.request",
             "input": {"url": "https://example.invalid", "method": "POST"},
             "context": _ctx()},
        ],
        "nodes": [HTTP],
        "executors": [{"capabilityId": "http.request", "behavior": "ok",
                       "verify": "pass"}],
    })

    return s
