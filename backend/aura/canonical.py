"""Canonicalization — byte-exact ports of the frozen TS digest functions.

Constitution:
  docs/migration/canonicalization-spec.md   (algorithms + collation trap)
  docs/migration/canonicalization-vectors.json (ground truth, from real TS)

THE COLLATION TRAP (spec §1.1): TypeScript sorts fingerprinted keys with
`a.localeCompare(b)` — ICU root collation, where comparison is case-insensitive
at primary strength and lowercase sorts BEFORE uppercase at tertiary strength.
Python's `sorted()` is code-point order and DISAGREES ('B' < 'a' by ordinals;
ICU says 'a' < 'B'). Every sort in this module therefore goes through
`icu_root_key`, whose correctness is asserted against frozen vector V4 and a
seeded randomized differential battery against the REAL bundled TypeScript
(backend/tests/differential).

Known domain limit (documented, not hidden): the key reproduces ICU root for
the identifier/text domains AURA actually fingerprints (ASCII letters, digits,
underscore, common punctuation). Exotic scripts fall back to a best-effort
approximation; expanding fingerprinted input into such scripts REQUIRES
extending this function and re-running vectors + differential first.
"""

from __future__ import annotations

import hashlib
import unicodedata
from typing import Any, Iterable

from .jsonutil import dumps_compact

__all__ = ["icu_root_key", "fingerprint_invocation", "graph_hash", "digest32"]

# ── ICU root collation approximation ────────────────────────────────────────

# Printable-ASCII primary-strength ordering, PROBED from Node 22's
# localeCompare (ICU root): one punctuation/symbol bucket sorts BEFORE digits,
# which sort BEFORE case-merged letters. Intra-bucket order is the probe's own
# total order. Re-derive with backend/tests/differential if ever in doubt.
_PUNCT_BUCKET = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"
_PUNCT_RANK = {ch: i for i, ch in enumerate(_PUNCT_BUCKET)}
_DIGIT_RANK_OFFSET = len(_PUNCT_BUCKET)


def _primary_key(ch: str) -> tuple[int, int]:
    """Per-character primary weight class: (bucket, order-within-bucket)."""
    if ch == " ":
        return (0, -1)  # whitespace leads the variable-weight bucket
    r = _PUNCT_RANK.get(ch)
    if r is not None:
        return (0, r)
    if "0" <= ch <= "9":
        return (1, _DIGIT_RANK_OFFSET + ord(ch))
    return (2, ord(ch))  # letters (and anything out of domain)


def _split_marks(s: str) -> tuple[str, str]:
    """NFD-split into base characters and combining marks."""
    nfd = unicodedata.normalize("NFD", s)
    base = "".join(ch for ch in nfd if not unicodedata.combining(ch))
    marks = "".join(ch for ch in nfd if unicodedata.combining(ch))
    return base, marks


def icu_root_key(s: str) -> tuple[tuple[tuple[int, int], ...], str, tuple[tuple[int, int], ...]]:
    """Multi-level sort key approximating Node's default `localeCompare`.

    L1 primary:   per-char (bucket, order) over CASE-FOLDED text — punctuation
                  < digits < letters, matching the probed ICU root order.
    L2 secondary: the accents (combining marks) of the original.
    L3 tertiary:  per character (case_class, code_point), lower=0 before upper=1.

    This is a KEY formulation (not a cmp), so it composes with sorted() safely.
    """
    folded = s.casefold()
    l1 = tuple(_primary_key(ch) for ch in folded)
    _, l2 = _split_marks(s)
    l3 = tuple(
        (0 if ch.islower() else 1 if ch.isupper() else 0, ord(ch)) for ch in s
    )
    return (l1, l2, l3)


def _sorted_keys(d: dict[str, Any]) -> dict[str, Any]:
    return {k: d[k] for k in sorted(d.keys(), key=icu_root_key)}


# ── digest helpers ───────────────────────────────────────────────────────────


def digest32(canonical_json: str) -> str:
    """sha256 hex, first 32 chars — exactly as both TS call sites do."""
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()[:32]


# ── fingerprintInvocation (capability-fabric/src/fabric.ts:122-138) ─────────


def fingerprint_invocation(
    capability_id: str,
    input: dict[str, Any],
    context: dict[str, Any] | None,
) -> str:
    """Identity of an EXACT invocation, for binding an approval to it.

    Included: capability, every argument (TOP-LEVEL keys only are sorted —
    nested objects keep insertion order, matching JSON.stringify semantics),
    and the two context fields deciding WHERE an effect lands. Absent context
    fields become null (`?? null`). Excluded on purpose: ids that legitimately
    differ between resume legs (runId etc.) — see spec §1.
    """
    ctx = context or {}
    canonical_obj: dict[str, Any] = {
        "capabilityId": capability_id,
        "input": _sorted_keys(input if input else {}),
        "projectId": ctx.get("projectId") if ctx.get("projectId") is not None else None,
        "cwd": ctx.get("cwd") if ctx.get("cwd") is not None else None,
        "workflowId": ctx.get("workflowId") if ctx.get("workflowId") is not None else None,
        "workflowNodeId": ctx.get("workflowNodeId") if ctx.get("workflowNodeId") is not None else None,
    }
    return digest32(dumps_compact(canonical_obj))


# ── hashGraph (ai-service/src/workflow/versions.ts:95-113) ──────────────────


def graph_hash(nodes: Iterable[dict[str, Any]], edges: Iterable[dict[str, Any]]) -> str:
    """Stable identity of a workflow graph's BEHAVIOUR.

    Included: node id/type/config (config TOP-LEVEL keys sorted); edge
    endpoints+ports. Excluded on purpose: node x/y, edge ids, names — moving a
    node on the canvas is NOT a new version. Edge sort key is plain string
    concatenation `${from}${fromPort}${to}` under localeCompare — reproduce its
    ambiguity exactly rather than "improving" it (spec §2).
    """
    canonical_nodes = [
        {
            "id": n["id"],
            "type": n["type"],
            "config": _sorted_keys(n.get("config") or {}),
        }
        for n in sorted(nodes, key=lambda n: icu_root_key(n["id"]))
    ]
    canonical_edges = [
        {"from": e["from"], "fromPort": e["fromPort"], "to": e["to"]} for e in edges
    ]
    canonical_edges.sort(key=lambda e: icu_root_key(f"{e['from']}{e['fromPort']}{e['to']}"))
    return digest32(dumps_compact({"nodes": canonical_nodes, "edges": canonical_edges}))
