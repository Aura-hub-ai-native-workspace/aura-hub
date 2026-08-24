"""Policy engine differential — Python vs REAL TypeScript on seeded matrices.

Covers the full decision surface: floors, permission denial, no-provider,
overrides, node overrides (deny-only), allowlists (fail-closed sanitization),
autonomy switch, rule-claiming semantics (escalate vs confirm vs silent),
AND sanitizePolicy hostile-input handling — including exact reason strings.
"""

from __future__ import annotations

import random

import pytest

from aura.policy import (
    CapabilityDescriptor,
    PolicyInput,
    PolicySubject,
    evaluate_policy,
    grants_for,
    sanitize_policy,
)

from _tsrun import run_ts_batch
from conftest import tsref  # noqa: F401  (session fixture)

SEED = 202_608
N_CASES = 250

SCOPES = [
    "project.read", "project.write", "process.execute", "network.outbound",
    "account.authorize", "resource.destroy", "system.modify", "aura.read", "aura.write",
]
DECISIONS = ["auto-execute", "ask-user", "require-approval", "deny"]
JUNK_DECISIONS = ["AUTO", "", None, 3, True, "require_approval"]


def _rand_capability(rng: random.Random) -> dict:
    perms = rng.sample(SCOPES, k=rng.randint(0, 4))
    return {
        "id": rng.choice(["filesystem.write", "git.push", "system.install", "http.request",
                          "terminal.execute", "agent.delegate", "provider.connect", "x.cap"]),
        "name": rng.choice(["File write", "Push", "Install", "HTTP request", "Terminal", "Delegate"]),
        "category": "test",
        "surface": "local-process",
        "risk": rng.choice(["low", "medium", "high"]),
        "permissions": perms,
        "verify": "exit-code",
        **({"irreversible": True} if rng.random() < 0.3 else {}),
    }


def _rand_raw_config(rng: random.Random) -> dict:
    raw: dict = {}
    if rng.random() < 0.8:
        by_risk = {}
        for level in ("low", "medium", "high"):
            r = rng.random()
            if r < 0.5:
                by_risk[level] = rng.choice(DECISIONS)
            elif r < 0.65:
                by_risk[level] = rng.choice(JUNK_DECISIONS)  # hostile value → dropped
        raw["byRisk"] = by_risk
    if rng.random() < 0.6:
        overrides = {}
        for _ in range(rng.randint(0, 3)):
            ident = rng.choice(["filesystem.write", "git.push", "", "@weird", "cap@node"])
            v = rng.choice(DECISIONS + JUNK_DECISIONS)
            overrides[ident] = v
        raw["overrides"] = overrides
    if rng.random() < 0.5:
        no = {}
        for _ in range(rng.randint(0, 3)):
            key = rng.choice(["@node-a", "cap@node-a", "noatsign", "@"])
            no[key] = rng.choice(DECISIONS + JUNK_DECISIONS)
        raw["nodeOverrides"] = no
    if rng.random() < 0.5:
        na = {}
        for _ in range(rng.randint(0, 2)):
            cap_id = rng.choice(["filesystem.write", "terminal.execute"])
            style = rng.random()
            if style < 0.4:
                na[cap_id] = ["node-a", "", 42]          # junk entries filtered
            elif style < 0.6:
                na[cap_id] = "not-a-list"                 # malformed → [] (fail closed)
            else:
                na[cap_id] = [rng.choice(["node-a", "node-b"])]
        raw["nodeAllowlists"] = na
    if rng.random() < 0.6:
        style = rng.random()
        if style < 0.5:
            raw["allowAutonomous"] = rng.random() < 0.5
        elif style < 0.7:
            raw["allowAutonomous"] = "yes"                # hostile → False (cautious)
        elif style < 0.85:
            raw["allowAutonomous"] = None                 # explicit null → cautious False? TS: not boolean → false
    if rng.random() < 0.15:
        raw["unknownJunk"] = {"deep": [1, 2, 3]}         # unknown keys dropped silently
    return raw


def _py_case_to_inputs(c: dict):
    cap = CapabilityDescriptor(
        id=c["capability"]["id"],
        name=c["capability"]["name"],
        risk=c["capability"]["risk"],
        permissions=list(c["capability"]["permissions"]),
        irreversible=c["capability"].get("irreversible"),
    )
    subject = None
    if c.get("subject"):
        s = c["subject"]
        subject = PolicySubject(
            node=s.get("node"),
            requestedNodeId=s.get("requestedNodeId"),
            actorKind=s.get("actorKind"),
            actorId=s.get("actorId"),
        )
    return cap, subject


@pytest.fixture(scope="module")
def policy_cases() -> list[dict]:
    rng = random.Random(SEED)
    cases = []
    for _ in range(N_CASES):
        node_available = rng.choice([True, False, None])
        has_node = node_available is not None and rng.random() < 0.7
        subject = None
        if has_node:
            subject = {
                "node": {"id": rng.choice(["node-a", "node-b"]), "name": rng.choice(["Alpha", "Beta"])},
                **({"requestedNodeId": "node-b"} if rng.random() < 0.3 else {}),
            }
        cases.append({
            "raw": _rand_raw_config(rng),
            "capability": _rand_capability(rng),
            "granted": rng.sample(SCOPES, k=rng.randint(0, len(SCOPES))),
            "nodeAvailable": node_available,
            "subject": subject,
        })
    return cases


def test_differential_policy(tsref, policy_cases):  # noqa: F811
    mismatches = []
    for i, c in enumerate(policy_cases):
        ts_result = run_ts_batch(tsref, "policy", [c])[0]

        config = sanitize_policy(c["raw"])
        cap, subject = _py_case_to_inputs(c)
        evaluation = evaluate_policy(
            PolicyInput(capability=cap, config=config, granted=c["granted"],
                        nodeAvailable=c["nodeAvailable"], subject=subject)
        )
        py_result = {"policy": config, "evaluation": evaluation}

        if py_result != ts_result:
            mismatches.append((i, c, py_result, ts_result))

    assert not mismatches, (
        f"{len(mismatches)} policy divergences; first case #{mismatches[0][0]}:\n"
        f"input: {mismatches[0][1]}\n"
        f"py : {mismatches[0][2]}\n"
        f"ts : {mismatches[0][3]}"
    )


def test_sanitize_fail_closed_allowlist():
    """Malformed allowlist becomes EMPTY list (deny everything), never missing."""
    cfg = sanitize_policy({"nodeAllowlists": {"filesystem.write": "junk"}})
    assert cfg["nodeAllowlists"]["filesystem.write"] == []


def test_sanitize_autonomy_reads_cautious():
    """Non-boolean autonomy setting reads FALSE (cautious), absent reads default."""
    assert sanitize_policy({"allowAutonomous": "yes"})["allowAutonomous"] is False
    assert sanitize_policy({})["allowAutonomous"] is True


def test_floor_cannot_be_relabeled_by_weaker_override():
    """Irreversible floor + permissive override keeps floor rule, not override."""
    cfg = sanitize_policy({"overrides": {"x.cap": "auto-execute"}})
    cap = CapabilityDescriptor(id="x.cap", name="X cap", risk="low",
                               permissions=[], irreversible=True)
    out = evaluate_policy(PolicyInput(capability=cap, config=cfg, granted=[],
                                      nodeAvailable=None))
    assert out["decision"] == "require-approval"
    assert out["rule"] == "irreversible-floor"


def test_grants_for_mapping():
    assert grants_for({"read": True, "write": True, "execute": True}) == [
        "project.read", "aura.read", "project.write", "aura.write",
        "process.execute", "network.outbound",
    ]
    assert "resource.destroy" not in grants_for({"read": True, "write": True, "execute": True})
