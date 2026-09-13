"""Correlation identity for the agent lifecycle.

One opaque id per inbound HTTP leg (``request_id``) ties together everything
that leg causes: session events, Fabric invocations, worker dispatches,
approval decisions, and evidence. Longer-lived identity reuses existing
canonical ids — no new identifiers where one already serves:

  request --request_id--> session --session_id--> leg (== request_id)
    |--approval_id--> ledger decision + resume grant
    |--capability_run_id--> Fabric invocationId / engine runId
    |--worker_run_id--> worker assignment + run record
    └--evidence_id--> (sessionId, planId, createdAt) composite

Ids are server-generated, ``req-`` + 12 hex chars, validated at every
boundary that accepts one. They carry no content and no secrets — safe
for logs, events, audit records, and debug surfaces.
"""

from __future__ import annotations

import re
import uuid

_REQUEST_RE = re.compile(r"^req-[0-9a-f]{12}$")


def new_request_id() -> str:
    """One fresh opaque request id, always server-side generated."""
    return f"req-{uuid.uuid4().hex[:12]}"


def is_request_id(value: object) -> bool:
    """Boundary validator: well-shaped or it is not a request id."""
    return isinstance(value, str) and _REQUEST_RE.fullmatch(value) is not None


__all__ = ["new_request_id", "is_request_id"]
