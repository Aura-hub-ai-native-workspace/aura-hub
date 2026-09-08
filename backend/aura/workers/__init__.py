"""Workers — first-class AI worker identities beneath the Central Agent.

A worker is an execution/reasoning runtime AURA delegates bounded work
to. It is NOT a tool: git and the GitHub CLI are capabilities the Fabric
drives directly, while a worker is another agent that decides, inside
its own private context, how to carry out a task AURA gave it. Confusing
the two is what made "connected" meaningless, so the two are separated
here and stay separated in the UI.

What this package adds, and deliberately nothing more:

  adapters.py    how each worker actually runs, and what its runtime can
                 genuinely enforce (evidence, never analogy)
  readiness.py   the real round-trip that has to succeed before the word
                 CONNECTED may be used
  this module    the honest descriptor the API and UI read

What this package is NOT: a second orchestrator, a worker daemon, a
second supervisor, or a second event system. Dispatch stays in the
Central Agent, governance stays in aura.governance, execution stays in
the Capability Fabric, and every descriptor below is derived from those
same sources rather than a parallel record.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .adapters import (
    ADAPTERS,
    WorkerAdapter,
    adapter_for_binary,
    adapter_for_id,
    governance_level,
    verified_invocations,
)
from .readiness import ReadinessProof, prove_worker

#: Worker lifecycle, owned by AURA. The execution states reuse the
#: TaskOutcome vocabulary rather than inventing a parallel one: a worker
#: is ACTIVE because a task it holds is running, and PARKED because that
#: task parked. Only the connection states are new.
LIFECYCLE = (
    "DISCOVERED", "NOT_CONNECTED", "CONNECTING", "CONNECTED", "IDLE",
    "ACTIVE", "WAITING", "PARKED", "COMPLETED", "FAILED", "CANCELLED",
    "TERMINATED", "UNSUPPORTED",
)


@dataclass
class WorkerDescriptor:
    """Everything AURA can honestly say about one worker right now."""

    id: str
    name: str
    binary: str
    kind: str = "worker"
    runtime: str = "local-process"

    installed: bool = False
    version: str = ""
    install_detail: str = ""

    invocable: bool = False
    """AURA has a verified way to drive this runtime non-interactively."""

    connected: bool = False
    lifecycle: str = "NOT_CONNECTED"
    reason: str = ""
    detail: str = ""

    governance: str = "UNSUPPORTED"
    governance_supports: dict[str, str] = field(default_factory=dict)

    capabilities: list[str] = field(default_factory=list)
    roles: list[str] = field(default_factory=list)
    proof: dict | None = None
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "binary": self.binary,
            "kind": self.kind, "runtime": self.runtime,
            "installed": self.installed, "version": self.version,
            "installDetail": self.install_detail,
            "invocable": self.invocable, "connected": self.connected,
            "lifecycle": self.lifecycle, "reason": self.reason,
            "detail": self.detail, "governance": self.governance,
            "governanceSupports": dict(self.governance_supports),
            "capabilities": list(self.capabilities),
            "roles": list(self.roles), "proof": self.proof,
            "notes": self.notes,
        }


#: Roles a worker can satisfy, derived from the node capabilities it
#: provides. Mirrors central_agent.worker_match.ROLE_NODE_CAPABILITY;
#: that module stays the authority for matching, this is presentation.
_ROLE_FOR_CAPABILITY = {
    "coding-agent": ("code", "review"),
    "terminal": ("execute",),
}


def roles_for(capabilities: list[str]) -> list[str]:
    roles: list[str] = []
    for cap in capabilities:
        for role in _ROLE_FOR_CAPABILITY.get(cap, ()):
            if role not in roles:
                roles.append(role)
    return roles


def is_worker(node_id: str) -> bool:
    return node_id in {a.id for a in ADAPTERS}


def describe_workers(nodes=None, *, probe: bool = True,
                     ) -> list[WorkerDescriptor]:
    """The worker truth table.

    ``connected`` is read from the registry's PROOF record, never from
    the presence of a binary and never from the registry merely holding
    a row. A worker registered without a proof is reported NOT_CONNECTED
    with the reason recorded at registration time.
    """
    from ..environment import catalog_entry

    registry: dict[str, dict] = {}
    if nodes is not None:
        for record in nodes.list_nodes():
            if isinstance(record, dict) and record.get("id"):
                registry[record["id"]] = record

    out: list[WorkerDescriptor] = []
    for adapter in ADAPTERS:
        entry = catalog_entry(adapter.id)
        caps = list(entry.capabilities) if entry else ["coding-agent"]
        desc = WorkerDescriptor(
            id=adapter.id, name=adapter.name, binary=adapter.binary,
            capabilities=caps, roles=roles_for(caps),
            invocable=adapter.invocation_verified,
            governance_supports=dict(adapter.supports),
            notes=adapter.notes)

        if probe:
            _fill_installed(desc, adapter)
        record = registry.get(adapter.id)
        proof = (record or {}).get("readiness") or None
        desc.proof = proof
        _fill_connection(desc, adapter, proof)
        out.append(desc)
    return out


def _fill_installed(desc: WorkerDescriptor, adapter: WorkerAdapter) -> None:
    from ..environment import probe_node

    try:
        result = probe_node(adapter.id)
    except Exception as exc:  # noqa: BLE001 — a probe failure is reportable
        desc.install_detail = f"The probe could not run: {exc}"
        return
    desc.installed = bool(result.present)
    desc.version = result.version or ""
    desc.install_detail = result.detail


def _fill_connection(desc: WorkerDescriptor, adapter: WorkerAdapter,
                     proof: dict | None) -> None:
    from .readiness import NOT_INSTALLED

    if proof and proof.get("proved") is True:
        desc.connected = True
        desc.lifecycle = "CONNECTED"
        desc.governance = proof.get("governance") or "UNSUPPORTED"
        desc.detail = proof.get("detail") or ""
        desc.governance_supports = (proof.get("governanceSupports")
                                    or desc.governance_supports)
        return

    desc.connected = False
    desc.governance = "NOT_CONNECTED"
    if proof:
        desc.lifecycle = "NOT_CONNECTED"
        desc.reason = proof.get("reason") or "INVOCATION_FAILED"
        desc.detail = proof.get("detail") or ""
        return
    if not desc.installed:
        desc.lifecycle = "NOT_CONNECTED"
        desc.reason = NOT_INSTALLED
        desc.detail = desc.install_detail or (
            f"{adapter.name} is not installed on this machine.")
        return
    desc.lifecycle = "DISCOVERED"
    desc.reason = ""
    desc.detail = (
        f"{adapter.name} is installed but AURA has not yet proved it can "
        "dispatch to it and receive a real result. Connect it to run the "
        "readiness handshake.")


def connect_worker(worker_id: str, nodes, home: str,
                   *, prover=None) -> tuple[WorkerDescriptor | None, dict]:
    """Run the readiness handshake and record what it proved.

    This is the ONLY way a worker becomes connected. It is a human-
    initiated product operation: it measures the machine, it performs no
    work on a user's project, and it grants no authority — the runtime
    binding it records makes the worker ROUTABLE, exactly as registering
    any node always has, while policy, approvals and the audit trail
    keep deciding every actual dispatch.

    Returns (descriptor, proof-dict). A failed proof is persisted too, so
    the reason a worker is not connected survives the request.
    """
    adapter = adapter_for_id(worker_id)
    if adapter is None:
        return None, {"proved": False, "reason": "ADAPTER_UNKNOWN",
                      "detail": f"'{worker_id}' is not a known worker."}
    from ..environment import catalog_entry

    entry = catalog_entry(adapter.id)
    caps = list(entry.capabilities) if entry else ["coding-agent"]
    run = prover or prove_worker
    proof = run(adapter, home)
    record = proof.to_dict()
    nodes.register_worker(
        adapter.id, adapter.name, caps, binary=adapter.binary,
        version="", readiness=record)
    workers = [w for w in describe_workers(nodes) if w.id == adapter.id]
    return (workers[0] if workers else None), record


def disconnect_worker(worker_id: str, nodes) -> bool:
    """Forget a worker. The runtime binding and the proof go with it, so
    the next dispatch cannot ride a stale connection."""
    return nodes.remove(worker_id)


def matrix_rows(workers: list[WorkerDescriptor]) -> list[dict]:
    """The §25 truth table, one row per worker, no fabricated cells."""
    return [{
        "worker": w.name, "installed": w.installed, "invocable": w.invocable,
        "realResponse": bool(w.proof and w.proof.get("proved")),
        "governance": w.governance, "connected": w.connected,
        "reason": w.reason,
    } for w in workers]


__all__ = [
    "ADAPTERS", "LIFECYCLE", "ReadinessProof", "WorkerAdapter",
    "WorkerDescriptor", "adapter_for_binary", "adapter_for_id",
    "connect_worker", "describe_workers", "disconnect_worker",
    "governance_level", "is_worker", "matrix_rows", "prove_worker",
    "roles_for", "verified_invocations",
]
