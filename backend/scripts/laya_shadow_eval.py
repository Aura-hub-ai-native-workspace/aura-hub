"""Controlled evaluation of the Laya shadow planner against a real model.

For each request this runs the SAME message twice:

1. baseline — no shadow planner; records the authoritative outcome.
2. shadowed — shadow planner enabled with a real provider; records the
   authoritative outcome and the shadow record.

The authoritative results must match. Shadow records must be correlated to
the session, the request leg and the authoritative plan. Requests run one at
a time and each waits for its shadow run, so the production budget defaults
are the ones being measured.

Usage:
    AURA_HOME=<isolated home> python scripts/laya_shadow_eval.py --out results.json

The provider comes from ``<AURA_HOME>/agent/providers.json`` through the
existing loader. No credentials are read or written by this script.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

REQUESTS: list[tuple[str, str]] = [
    ("informational", "Explain the architecture of this project."),
    ("informational", "Where is authentication implemented?"),
    ("informational", "How does the SSE stream reach the frontend in this codebase?"),
    ("simple-direct", "Check git status"),
    ("simple-write", "Create a file called notes.txt containing hello"),
    ("review-read-only", "Review this project for security problems."),
    ("review-and-remediate", "Implement token refresh in src/auth and have another AI review it"),
    ("multi-step", "Implement a login endpoint under backend/api and run the tests"),
    ("parallel-workers", "Have OpenCode and Kilo Code investigate the failing tests in parallel, read only, do not modify files."),
    ("inventory", "What workflows are stored?"),
    ("inventory", "List my registered projects"),
    ("knowledge", "Search my knowledge base for deployment notes"),
    ("conversational", "Hi"),
    ("ambiguous", "Could you do something about it?"),
    ("effectful", "Delete the old branch and push to origin"),
    ("dependency-chain", "Investigate why the build fails, then fix it and verify the tests pass."),
    ("explicit-read-only", "Inspect the project and summarize the architecture. Do not modify any files."),
    ("unsupported", "Deploy the service to production on Kubernetes."),
]


def _build_agents(home: Path):
    from aura.central_agent import AgentSessionStore, CentralAgent
    from aura.central_agent.intent import IntentCompiler
    from aura.central_agent.model_routing import default_model_port
    from aura.central_agent.shadow_planner import ShadowPlanner, ShadowPlanStore, isolated_port
    from aura.fabric import FabricConfig

    cfg = FabricConfig(fabric=None, audit_store=None, ledger=None,
                       permissions={}, executors={}, secrets=None)
    sessions = AgentSessionStore(home)
    baseline = CentralAgent(fabric_cfg=cfg, session_store=sessions,
                            intent_compiler=IntentCompiler(mode="heuristic"))
    # Authoritative planning stays heuristic. Only the shadow uses the model.
    port = default_model_port()
    if port is None:
        raise SystemExit("no provider configured under AURA_HOME/agent/providers.json")
    shadow = ShadowPlanner(isolated_port(port), ShadowPlanStore(home))
    shadowed = CentralAgent(fabric_cfg=cfg, session_store=sessions,
                            intent_compiler=IntentCompiler(mode="heuristic"),
                            shadow_planner=shadow)
    return baseline, shadowed, shadow


def _authoritative(result) -> dict:
    return {"status": result.status, "outcome": result.outcome,
            "performed": list(result.performed or []),
            "verified": list(result.verified or [])}


def run(home: Path, out: Path) -> dict:
    os.environ["AURA_HOME"] = str(home)
    baseline, shadowed, shadow = _build_agents(home)
    rows = []
    for category, message in REQUESTS:
        started = time.monotonic()
        base_result = baseline.submit(message, project_id="laya-eval")
        base_auth = _authoritative(base_result)

        result = shadowed.submit(message, project_id="laya-eval")
        shadow.wait(timeout=180)
        auth = _authoritative(result)
        sid = shadowed.sessions.last_session_id
        session = shadowed.sessions.load(sid) if sid else None
        store = shadow.store
        recs = store.list(sid) if sid else []

        correlated = bool(recs) and all(
            r["sessionId"] == sid
            and r.get("requestId") == getattr(session, "lastRequestId", None)
            and (r.get("authoritativePlanId") in (None, getattr(session, "activePlanId", None)))
            for r in recs)
        rec = recs[-1] if recs else None
        rows.append({
            "category": category, "message": message,
            "baseline": base_auth, "shadowed": auth,
            "authoritativeMatches": base_auth == auth,
            "sessionId": sid,
            "shadowStatus": rec["status"] if rec else "none",
            "shadowErrorCategory": rec.get("errorCategory") if rec else None,
            "shadowProvider": rec.get("provider") if rec else None,
            "shadowModel": rec.get("model") if rec else None,
            "shadowLatencyMs": rec.get("latencyMs") if rec else None,
            "shadowAttempts": rec.get("attempts") if rec else None,
            "comparison": rec.get("comparison") if rec else None,
            "governance": rec.get("governance") if rec else None,
            "candidateTasks": (rec.get("candidateSummary") or {}).get("taskCount") if rec else None,
            "correlated": correlated,
            "executedFlagFalse": bool(rec) and rec.get("executed") is False,
            "wallSeconds": round(time.monotonic() - started, 1),
        })
        print(f"[{category:20}] auth-match={base_auth == auth} "
              f"shadow={rows[-1]['shadowStatus']} correlated={correlated}",
              file=sys.stderr, flush=True)

    summary = summarize(rows)
    payload = {"summary": summary, "rows": rows}
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return payload


def summarize(rows: list[dict]) -> dict:
    from collections import Counter

    statuses = Counter(r["shadowStatus"] for r in rows)
    validated = [r for r in rows if r["shadowStatus"] == "validated"]
    cmp_rows = [r["comparison"] for r in validated if r["comparison"]]

    def rate(key: str) -> float | None:
        if not cmp_rows:
            return None
        return round(sum(1 for c in cmp_rows if c[key]) / len(cmp_rows), 3)

    latencies = [r["shadowLatencyMs"] for r in rows
                 if isinstance(r["shadowLatencyMs"], (int, float))]
    return {
        "requests": len(rows),
        "authoritativeMatches": sum(1 for r in rows if r["authoritativeMatches"]),
        "shadowStatusCounts": dict(statuses),
        "allRecordsCorrelated": all(r["correlated"] for r in rows if r["shadowStatus"] != "none"),
        "allRecordsNotExecuted": all(r["executedFlagFalse"] for r in rows if r["shadowStatus"] != "none"),
        "comparisonAgreementRates": {
            "sameCapabilities": rate("sameCapabilities"),
            "sameDependencyStructure": rate("sameDependencyStructure"),
            "sameWorkerRoles": rate("sameWorkerRoles"),
            "sameNodePins": rate("sameNodePins"),
            "sameHighRiskCount": rate("sameHighRiskCount"),
        },
        "latencyMs": {
            "median": round(statistics.median(latencies), 1) if latencies else None,
            "max": round(max(latencies), 1) if latencies else None,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    home = Path(os.environ.get("AURA_HOME", ""))
    if not home.exists():
        raise SystemExit("AURA_HOME must point at an existing isolated home")
    os.environ["AURA_LAYA_SHADOW"] = "1"
    payload = run(home, args.out)
    print(json.dumps(payload["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
