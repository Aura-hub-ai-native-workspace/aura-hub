"""Worker billing policy — nothing that might cost money runs by default.

AURA cannot know what a worker's runtime bills. A worker being installed,
connected, "free-tier" in a catalogue, or readiness-proven says nothing about
cost: Claude Code, Codex and Gemini CLIs bill their vendor accounts, and
opencode/kilo bill whichever provider the person configured inside them. So the
rule is the reverse of an allow-by-availability one:

    unknown billing  == potentially paid  ==  denied

Only the OWNER can change that, in ``<AURA_HOME>/worker-policy.json``::

    {"verifiedFree": ["opencode"],      # owner states: this worker costs nothing here
     "authorized":   ["claude-code"]}   # owner accepts the cost of this worker

A model, a plan, a task or a chat message cannot write or widen
this: it is read from the owner's file at every decision. This module is the one
place the decision is made; ``executors.agent_delegate_run`` (the dispatch
boundary), ``agent_delegate_supports_node`` (worker selection and failover) and
``workers.readiness.prove_worker`` (a real, billable round-trip) all ask it.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

POLICY_FILE = "worker-policy.json"

#: Workers whose runtime is known to bill a vendor account. Informational: they
#: are denied by default like every unknown worker; this only sharpens the message.
KNOWN_BILLABLE = frozenset({"claude-code", "codex-cli", "gemini-cli"})

VERIFIED_FREE = "verified-free"
AUTHORIZED = "owner-authorized"
BILLABLE = "billable"
UNKNOWN = "unknown"


@dataclass(frozen=True)
class WorkerDecision:
    worker: str
    allowed: bool
    billing: str          # verified-free | owner-authorized | billable | unknown
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def _ids(raw: object) -> frozenset[str]:
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(x for x in raw if isinstance(x, str) and x)


def load_policy(home: str | Path | None = None) -> tuple[frozenset[str], frozenset[str]]:
    """(verifiedFree, authorized) from the owner's file; both empty if absent or unreadable.

    A missing, malformed or unreadable file means NO worker is allowed.
    """
    if home is None:
        from ..config import aura_home

        home = aura_home()
    try:
        raw = json.loads((Path(home) / POLICY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset(), frozenset()
    if not isinstance(raw, dict):
        return frozenset(), frozenset()
    return _ids(raw.get("verifiedFree")), _ids(raw.get("authorized"))


def authorize(worker_id: str, home: str | Path | None = None) -> WorkerDecision:
    """Record the owner's decision to accept the cost of ONE known worker.

    This is only ever called from the owner's own click in the desktop app
    (``POST /workers/authorize``); it is not a capability and no plan, model
    or chat message reaches it. Only a worker AURA has an adapter for can be
    authorized, other keys in the file are preserved, and the write is atomic.
    """
    from .adapters import adapter_for_id

    wid = str(worker_id or "").strip()
    if adapter_for_id(wid) is None:
        raise ValueError(f"'{wid}' is not a worker AURA knows.")
    if home is None:
        from ..config import aura_home

        home = aura_home()
    path = Path(home) / POLICY_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
    except (OSError, ValueError):
        raw = {}
    authorized = sorted(_ids(raw.get("authorized")) | {wid})
    raw["authorized"] = authorized
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(raw, indent=2), encoding="utf-8")
    tmp.replace(path)
    return decide(wid, home)


def owner_setting(name: str, default: object = False, home: str | Path | None = None) -> object:
    """One scalar setting from the owner's policy file (never from a model or a plan)."""
    if home is None:
        from ..config import aura_home

        home = aura_home()
    try:
        raw = json.loads((Path(home) / POLICY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    return raw.get(name, default) if isinstance(raw, dict) else default


def decide(worker_id: str, home: str | Path | None = None) -> WorkerDecision:
    """May this worker run? Deny unless the owner said so."""
    free, authorized = load_policy(home)
    wid = str(worker_id or "")
    if wid in free:
        return WorkerDecision(wid, True, VERIFIED_FREE,
                              f"{wid} is marked verified-free in {POLICY_FILE}.")
    if wid in authorized:
        return WorkerDecision(wid, True, AUTHORIZED,
                              f"{wid} is authorized in {POLICY_FILE}: the owner accepted its cost.")
    billing = BILLABLE if wid in KNOWN_BILLABLE else UNKNOWN
    why = ("it bills a vendor account" if billing == BILLABLE
           else "its billing is unknown, and unknown is treated as potentially paid")
    return WorkerDecision(
        wid, False, billing,
        f"{wid} was not run: {why}. Being installed or connected does not show it is free. "
        f"To allow it, the owner adds it to \"verifiedFree\" or \"authorized\" in "
        f"<AURA_HOME>/{POLICY_FILE}.")


def worker_id_of(node: dict | None) -> str:
    """The catalogue id of a node, falling back to the adapter for its binary."""
    if not isinstance(node, dict):
        return ""
    if node.get("id"):
        return str(node["id"])
    from .adapters import adapter_for_binary

    adapter = adapter_for_binary(str(node.get("binary") or ""))
    return adapter.id if adapter else ""
