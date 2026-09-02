"""Differential tests — Python vs the REAL TypeScript, on seeded random inputs.

This is mission §24 in miniature and the Phase 1 gate's core: 300+ cases per
digest function across the identifier domain AURA actually fingerprints,
compared against esbuild-bundled originals. Any divergence is a blocker.

Deterministic: random.Random(141_101) — reruns are byte-identical case sets.
"""

from __future__ import annotations

import json
import random

import pytest
from _tsrun import run_ts_batch
from conftest import tsref  # noqa: F401  (session fixture)

from aura.canonical import fingerprint_invocation, graph_hash

SEED = 141_101
N_FINGERPRINT = 200
N_GRAPH = 120

KEY_TOKENS = [
    "path", "content", "command", "filePath", "File", "Path", "alpha", "branch",
    "remote", "url", "query", "body", "headers", "timeoutMs", "maxIterations",
    "task", "tools", "includePatterns", "title", "text", "opts", "config", "a", "B", "z9",
]
VALUES = ["src/a.ts", "hi", "main", "https://example.test/x", 0, 1, 2, -7, True, False, "", "**/*.ts"]


def _rand_input(rng: random.Random) -> dict:
    n = rng.randint(0, 5)
    keys = rng.sample(KEY_TOKENS, k=min(n, len(KEY_TOKENS)))
    out: dict = {}
    for k in keys:
        if rng.random() < 0.25:
            inner_keys = rng.sample(KEY_TOKENS, k=rng.randint(1, 3))
            # Random insertion order on purpose: nested objects must NOT be
            # canonicalized — both sides must agree they're significant.
            out[k] = {ik: rng.choice(VALUES) for ik in inner_keys}
        elif rng.random() < 0.15:
            out[k] = [rng.choice(VALUES) for _ in range(rng.randint(0, 3))]
        else:
            out[k] = rng.choice(VALUES)
    return out


def _rand_context(rng: random.Random) -> dict:
    ctx: dict = {}
    for field in ("projectId", "cwd", "workflowId", "workflowNodeId"):
        r = rng.random()
        if r < 0.4:
            ctx[field] = f"p-{rng.randrange(1000)}"
        elif r < 0.5:
            ctx[field] = None
        # else: absent entirely (?? null semantics)
    return ctx


@pytest.fixture(scope="module")
def fingerprint_cases() -> list[dict]:
    rng = random.Random(SEED)
    caps = ["filesystem.write", "terminal.execute", "git.push", "http.request",
            "agent.delegate", "system.install", "X.cap", "mixed.Case_cap"]
    return [
        {
            "capabilityId": rng.choice(caps),
            "input": _rand_input(rng),
            "context": _rand_context(rng),
        }
        for _ in range(N_FINGERPRINT)
    ]


@pytest.fixture(scope="module")
def graph_cases() -> list[dict]:
    rng = random.Random(SEED + 1)

    def rid(i: int) -> str:
        style = i % 4
        if style == 0:
            return f"n-{i}"
        if style == 1:
            return f"Node{i}"
        if style == 2:
            return f"node_{i}"
        return f"N{i}x"

    cases = []
    for _ in range(N_GRAPH):
        count = rng.randint(1, 6)
        ids = [rid(i) for i in range(count)]
        nodes = [
            {
                "id": nid,
                "type": rng.choice(["agent", "output", "condition", "current-project"]),
                "x": rng.random() * 1000,   # MUST be ignored
                "y": rng.random() * 1000,   # MUST be ignored
                "config": _rand_input(rng), # insertion order varies
            }
            for nid in ids
        ]
        edges = []
        for _ in range(rng.randint(0, count)):
            e = rng.choice(ids)
            t = rng.choice(ids)
            edge = {"from": e, "fromPort": rng.choice(["out", "true", "false", "done"]), "to": t}
            if rng.random() < 0.5:
                edge["id"] = f"e{rng.randrange(10**6)}"  # MUST be ignored
            edges.append(edge)
        cases.append({"nodes": nodes, "edges": edges})
    return cases


def test_differential_fingerprint(tsref, fingerprint_cases):  # noqa: F811
    py = [fingerprint_invocation(c["capabilityId"], c["input"], c["context"]) for c in fingerprint_cases]
    ts = run_ts_batch(tsref, "fingerprint", fingerprint_cases)
    mismatches = [(i, c, p, t) for i, (c, p, t) in enumerate(zip(fingerprint_cases, py, ts)) if p != t]
    assert not mismatches, (
        f"{len(mismatches)} fingerprint divergences; first: {mismatches[0][1]} py={mismatches[0][2]} ts={mismatches[0][3]}"
    )
    assert len(set(py)) > N_FINGERPRINT * 0.8, "case set degenerated — not enough entropy"


def test_differential_graph_hash(tsref, graph_cases):  # noqa: F811
    py = [graph_hash(c["nodes"], c["edges"]) for c in graph_cases]
    ts = run_ts_batch(tsref, "graphHash", graph_cases)
    mismatches = [(c, p, t) for c, p, t in zip(graph_cases, py, ts) if p != t]
    assert not mismatches, (
        f"{len(mismatches)} graphHash divergences; first: {json.dumps(mismatches[0][0])[:300]} "
        f"py={mismatches[0][1]} ts={mismatches[0][2]}"
    )
