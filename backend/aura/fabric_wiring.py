"""Fabric wiring shared by entry points (CLI, API, tests).

One place constructs the FabricConfig so executors, stores and policy
cannot drift between surfaces.
"""

from __future__ import annotations

from pathlib import Path

from .audit import AuditStore
from .approvals import ApprovalLedger
from .fabric import FabricConfig, builtin_executors


def default_fabric_config(audit: AuditStore, ledger: ApprovalLedger,
                          home: Path | None = None,
                          policy_config: dict | None = None) -> FabricConfig:
    from .config import aura_home

    return FabricConfig(
        policy_config=policy_config or {},
        permissions={"read": True, "write": True},
        executors=builtin_executors(home or aura_home()),
        audit_store=audit,
        ledger=ledger,
    )
