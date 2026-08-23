"""Differential verification of the policy engine.

Generates an exhaustive matrix of policy cases, runs it through BOTH the
TypeScript reference engine and the Python port, and reports every
difference in `decision` or `rule`.

The case matrix is generated rather than hand-written so it covers
combinations nobody thought to test — which is the point: a hand-picked
case list tends to encode the same assumptions as the implementation.

Usage (from backend/):
    uv run python -m parity.policy_parity --repo /mnt/storage/aura-hub
"""

from __future__ import annotations

import argparse
import itertools
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from aura_backend.policy import (
    PermissionScope,
    PolicyConfig,
    PolicyDecision,
    PolicyInput,
    PolicySubject,
    RiskLevel,
    evaluate_policy,
    sanitize_policy,
)

# Capabilities drawn from the real manifest, chosen to hit every floor and
# the no-floor path.
CAPABILITIES = [
    {
        "id": "project.list",
        "name": "List projects",
        "risk": "low",
        "permissions": ["aura.read"],
        "irreversible": False,
    },
    {
        "id": "filesystem.write",
        "name": "Write a file",
        "risk": "medium",
        "permissions": ["project.write"],
        "irreversible": False,
    },
    {
        "id": "agent.delegate",
        "name": "Delegate to a coding agent",
        "risk": "high",
        "permissions": [
            "project.read",
            "project.write",
            "process.execute",
            "network.outbound",
        ],
        "irreversible": True,
    },
    {
        "id": "git.push",
        "name": "Push a branch",
        "risk": "high",
        "permissions": ["project.write", "network.outbound"],
        "irreversible": True,
    },
    {
        "id": "system.install",
        "name": "Install a tool",
        "risk": "high",
        "permissions": ["process.execute", "system.modify"],
        "irreversible": False,
    },
    {
        "id": "provider.connect",
        "name": "Connect a provider",
        "risk": "high",
        "permissions": ["account.authorize"],
        "irreversible": False,
    },
    {
        "id": "resource.drop",
        "name": "Drop a resource",
        "risk": "low",
        "permissions": ["resource.destroy"],
        "irreversible": False,
    },
]

DECISIONS = [d.value for d in PolicyDecision]
ALL_GRANTS = [s.value for s in PermissionScope]
NODE_ID = "opencode"


def build_cases() -> list[dict]:
    cases: list[dict] = []

    def add(name: str, cap: dict, config: dict, **kw) -> None:
        cases.append(
            {
                "name": name,
                "capability": cap,
                "config": config,
                "granted": kw.get("granted", ALL_GRANTS),
                "nodeAvailable": kw.get("nodeAvailable"),
                "subject": kw.get("subject", {"node": {"id": NODE_ID, "name": NODE_ID}}),
                "sanitize": kw.get("sanitize", False),
            }
        )

    base = {
        "byRisk": {"low": "auto-execute", "medium": "ask-user", "high": "require-approval"},
        "overrides": {},
        "allowAutonomous": True,
    }

    for cap in CAPABILITIES:
        add(f"default/{cap['id']}", cap, base)

        # Every risk default against every capability.
        for d in DECISIONS:
            add(
                f"byRisk={d}/{cap['id']}",
                cap,
                {**base, "byRisk": {"low": d, "medium": d, "high": d}},
            )

        # Every capability override.
        for d in DECISIONS:
            add(f"override={d}/{cap['id']}", cap, {**base, "overrides": {cap["id"]: d}})

        # Every node override, both key forms.
        for d in DECISIONS:
            add(
                f"nodeOverride@={d}/{cap['id']}",
                cap,
                {**base, "nodeOverrides": {f"@{NODE_ID}": d}},
            )
            add(
                f"nodeOverrideCap@={d}/{cap['id']}",
                cap,
                {**base, "nodeOverrides": {f"{cap['id']}@{NODE_ID}": d}},
            )

        # Allow-lists: naming the node, excluding it, and empty.
        add(f"allowlist-includes/{cap['id']}", cap, {**base, "nodeAllowlists": {cap["id"]: [NODE_ID]}})
        add(f"allowlist-excludes/{cap['id']}", cap, {**base, "nodeAllowlists": {cap["id"]: ["other"]}})
        add(f"allowlist-empty/{cap['id']}", cap, {**base, "nodeAllowlists": {cap["id"]: []}})

        # Autonomy off.
        add(f"autonomy-off/{cap['id']}", cap, {**base, "allowAutonomous": False})

        # Hard floors.
        add(f"node-unavailable/{cap['id']}", cap, base, nodeAvailable=False)
        add(f"nothing-granted/{cap['id']}", cap, base, granted=[])

        # No node at all.
        add(f"no-node/{cap['id']}", cap, base, subject=None)

        # Everything permissive at once.
        add(
            f"all-permissive/{cap['id']}",
            cap,
            {
                "byRisk": {"low": "auto-execute", "medium": "auto-execute", "high": "auto-execute"},
                "overrides": {cap["id"]: "auto-execute"},
                "nodeOverrides": {
                    f"@{NODE_ID}": "auto-execute",
                    f"{cap['id']}@{NODE_ID}": "auto-execute",
                },
                "nodeAllowlists": {cap["id"]: [NODE_ID]},
                "allowAutonomous": True,
            },
        )

        # Layered combinations: override x node-override.
        for a, b in itertools.product(DECISIONS, repeat=2):
            add(
                f"layered/{a}+{b}/{cap['id']}",
                cap,
                {**base, "overrides": {cap["id"]: a}, "nodeOverrides": {f"@{NODE_ID}": b}},
            )

        # Hostile configuration, through the sanitizer on both sides.
        for garbage in (
            {"nodeAllowlists": {cap["id"]: "not-a-list"}},
            {"overrides": {cap["id"]: "definitely-run-it"}},
            {"byRisk": {"high": "yolo"}},
            {"nodeOverrides": {cap["id"]: "auto-execute"}},
            {"allowAutonomous": "yes"},
            {"allowAutonomous": 1},
        ):
            add(
                f"sanitized/{json.dumps(garbage, sort_keys=True)}/{cap['id']}",
                cap,
                garbage,
                sanitize=True,
            )

    return cases


def run_python(cases: list[dict]) -> list[dict]:
    out = []
    for c in cases:
        cap = c["capability"]
        raw = c["config"]
        config = (
            sanitize_policy(raw)
            if c["sanitize"]
            else PolicyConfig(
                by_risk={RiskLevel(k): PolicyDecision(v) for k, v in raw.get("byRisk", {}).items()},
                overrides={k: PolicyDecision(v) for k, v in raw.get("overrides", {}).items()},
                node_overrides={
                    k: PolicyDecision(v) for k, v in raw.get("nodeOverrides", {}).items()
                },
                node_allowlists=dict(raw.get("nodeAllowlists", {})),
                allow_autonomous=raw.get("allowAutonomous", True),
            )
        )
        subject = PolicySubject(
            capability_id=cap["id"],
            risk=RiskLevel(cap["risk"]),
            permissions=tuple(PermissionScope(p) for p in cap["permissions"]),
            irreversible=cap.get("irreversible", False),
            node_id=(c["subject"] or {}).get("node", {}).get("id") if c["subject"] else None,
            node_name=(c["subject"] or {}).get("node", {}).get("name", "") if c["subject"] else "",
            capability_name=cap["name"],
        )
        result = evaluate_policy(
            PolicyInput(
                subject=subject,
                node_available=c["nodeAvailable"],
                granted=frozenset(PermissionScope(g) for g in c["granted"]),
            ),
            config,
        )
        out.append({
            "name": c["name"],
            "decision": result.decision.value,
            "rule": result.rule,
            "reason": result.reason,
        })
    return out


def run_typescript(cases: list[dict], repo: Path) -> list[dict]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(cases, f)
        cases_path = f.name
    oracle = Path(__file__).parent / "policy_oracle.ts"
    proc = subprocess.run(
        ["node", str(repo / "scripts" / "run-ts.mjs"), str(oracle), cases_path, str(repo)],
        capture_output=True,
        text=True,
        cwd=repo,
    )
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit("the TypeScript oracle failed to run; cannot claim parity")
    return json.loads(proc.stdout)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/mnt/storage/aura-hub")
    args = ap.parse_args()

    cases = build_cases()
    ts = run_typescript(cases, Path(args.repo))
    py = run_python(cases)

    assert len(ts) == len(py) == len(cases)
    failures = []
    for t, p in zip(ts, py):
        assert t["name"] == p["name"]
        if t != p:
            failures.append(
                f"{t['name']}\n"
                f"    TypeScript: {t['decision']:<16} rule={t['rule']}  reason={t['reason']!r}\n"
                f"    Python:     {p['decision']:<16} rule={p['rule']}  reason={p['reason']!r}"
            )

    for f in failures:
        print(f"DIFF {f}")
    print(f"\n{len(cases) - len(failures)}/{len(cases)} policy cases match the reference engine")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
