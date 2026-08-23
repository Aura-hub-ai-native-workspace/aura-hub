"""The node projection the Fabric routes against.

A port of `refreshNodeAvailability` in packages/ai-service/src/server.ts.

Two projections are built together, in ONE pass over the catalogue, from
ONE scan: the set of provided capabilities and the ordered list of present
nodes. Building them together is what stops them disagreeing about what is
connected.

**Catalogue order is preserved**, because it is the documented routing
tie-break when several present nodes provide the same capability.

### A known bug in the reference, fixed here

`refreshNodeAvailability(ids)` in `server.ts` assigns rather than merges:

```ts
providedNodeCapabilities = provided;
presentNodes = nodes;          // replaces, does not merge
```

So a **targeted** scan replaces the global projection with just that
subset, and every node not named in it appears to vanish until a full scan
runs again. A genuinely installed node then fails routing with
`no-provider`. The master handoff records this as open technical debt.

This implementation **merges** a targeted scan into the existing
projection instead. That is a deliberate behavioural difference, recorded
in the migration map, and it is covered by a negative control.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..fabric.types import NodeRef
from .catalog import CATALOG, catalog_entry
from .scanner import ProbeResult, ScanResult


@dataclass
class NodeProjection:
    """What is present on this machine right now, as routing sees it."""

    # node id -> the probe that found it. Only present nodes are kept.
    _present: dict[str, ProbeResult] = field(default_factory=dict)

    def apply(self, scan: ScanResult, *, targeted: bool) -> None:
        """Fold a scan into the projection.

        A full scan replaces what is known. A targeted scan MERGES, so
        naming two nodes does not assert that every other node vanished.
        """
        if not targeted:
            self._present = {
                node_id: result for node_id, result in scan.results.items() if result.present
            }
            return
        for node_id, result in scan.results.items():
            if result.present:
                self._present[node_id] = result
            else:
                # A targeted scan that found a node absent is real news
                # about that node — and only about that node.
                self._present.pop(node_id, None)

    def present_nodes(self) -> list[NodeRef]:
        """Present nodes, in catalogue order.

        The order is a behavioural contract: it decides which tool runs
        when the caller named none.
        """
        out: list[NodeRef] = []
        for entry in CATALOG:
            if entry.id not in self._present:
                continue
            out.append(
                NodeRef(
                    id=entry.id,
                    name=entry.name,
                    capabilities=entry.capabilities,
                    binary=entry.probe.command if entry.probe else None,
                )
            )
        return out

    def provided_capabilities(self) -> set[str]:
        provided: set[str] = set()
        for node_id in self._present:
            entry = catalog_entry(node_id)
            if entry is not None:
                provided.update(entry.capabilities)
        return provided

    def probe_of(self, node_id: str) -> ProbeResult | None:
        return self._present.get(node_id)
