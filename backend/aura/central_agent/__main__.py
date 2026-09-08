"""CLI — run one intent through the central agent and print the result JSON.

    python3 -m aura.central_agent --intent "list my workflows" [--project ID]
                                  [--home DIR] [--mode heuristic|model]

Deterministic by default (heuristic mode): the same command produces the
same governed actions, which is what runtime verification requires.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def build_fabric_config(audit, ledger):
    """FabricConfig wired to this installation's stores."""
    from ..executors import all_executors, register_canonical_internal_capabilities
    from ..fabric import CapabilityFabric, FabricConfig, FabricHost

    class _H(FabricHost):
        def permissions_for(self, _cap, _ctx):
            return {"read": True, "write": True, "execute": True, "autonomous": True, "network": True}
        def node_available(self, _cap):
            return True
        async def request_approval(self, _req, _ctx):
            return False

    register_canonical_internal_capabilities(None)
    host = _H()
    fabric = CapabilityFabric(host)
    fabric.attach_audit_store(audit.load, audit.append)
    fabric.attach_approval_store(lambda: [], lambda x: None)
    fabric._ledger = ledger
    execs = {}
    for exe in all_executors():
        try:
            fabric.register(exe)
            execs[exe.capabilityId] = exe
        except Exception:
            pass
    return FabricConfig(
        fabric=fabric,
        policy_config={},
        permissions={"read": True, "write": True},
        executors=execs,
        audit_store=audit,
        ledger=ledger,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m aura.central_agent")
    parser.add_argument("--intent", required=True, help="natural-language request")
    parser.add_argument("--project", default=None, help="project id context")
    parser.add_argument("--home", default=None, help="AURA_HOME override")
    parser.add_argument("--mode", default="heuristic", choices=("heuristic", "model"))
    args = parser.parse_args(argv)

    if args.home:
        os.environ["AURA_HOME"] = args.home

    from ..approvals import ApprovalLedger
    from ..audit import AuditStore
    from ..config import aura_home
    from .events import EventBus
    from .intent import IntentCompiler
    from .service import CentralAgent
    from .session import AgentSessionStore

    home = aura_home()
    audit = AuditStore(home / "audit" / "trail.jsonl")
    ledger = ApprovalLedger(audit_append=audit.append)

    # `--mode model` used to construct an IntentCompiler with no port,
    # which raises before anything runs. The port comes from the same
    # operator provider file the service reads; without one, the honest
    # answer is to say so rather than to fail with a type error.
    from .model_routing import default_model_port

    model_port = default_model_port() if args.mode == "model" else None
    if args.mode == "model" and model_port is None:
        print(json.dumps({"error": (
            "model mode needs a provider: write "
            f"{home / 'agent' / 'providers.json'} with at least one entry, "
            "or run with --mode heuristic.")}, indent=2))
        return 2

    bus = EventBus()
    agent = CentralAgent(
        fabric_cfg=build_fabric_config(audit, ledger),
        session_store=AgentSessionStore(home),
        bus=bus,
        intent_compiler=(
            IntentCompiler(mode="model", model_port=model_port,
                           allow_heuristic_fallback=True)
            if model_port is not None else IntentCompiler(mode="heuristic")),
    )
    result = agent.submit(args.intent, project_id=args.project)
    print(json.dumps({
        "result": result.model_dump(),
        "events": [e.type for e in bus.tail],
    }, indent=2, ensure_ascii=False))
    return 0 if result.outcome in ("completed", "awaiting-approval") else 1


if __name__ == "__main__":
    sys.exit(main())
