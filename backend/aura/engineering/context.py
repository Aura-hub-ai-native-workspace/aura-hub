"""Engineering Context — plugs into the ContextAssembler to inject engineering state.

The ContextAssembler in central_agent/context.py is the canonical seam for
adding domain-specific context. This module provides a provider that contributes
engineering context items to the bundle:

- Project engineering summary (nodes, artifacts, tools)
- Available engineering capabilities
- Recent engineering events
- Tool availability
- Artifact status overview

This follows the existing ContextItem/ContextBundle pattern.
"""

from __future__ import annotations

from typing import Any

from ..central_agent.context import PROVENANCE_SYSTEM, ContextAssembler, ContextBundle, ContextItem
from .artifacts import ArtifactStore
from .capabilities import engineering_capabilities_summary
from .events import EngineeringEventStore
from .graph import EngineeringGraph
from .tools import ToolRegistry


def make_engineering_context_provider(
    project_id: str,
    graph: EngineeringGraph | None = None,
    artifact_store: ArtifactStore | None = None,
    tool_registry: ToolRegistry | None = None,
    event_store: EngineeringEventStore | None = None,
):
    """Return a function compatible with ContextAssembler's injection pattern.

    The returned function takes a ContextBundle and populates it with
    engineering-specific context items. It can be wired into the assembler
    via the ``_extra_providers`` hook or called directly during assembly.

    Usage::

        provider = make_engineering_context_provider("my-project", graph=g)
        bundle = ContextBundle()
        provider(bundle)
        # bundle now contains engineering context items
    """

    def _populate(bundle: ContextBundle) -> None:
        # ── Engineering project summary ───────────────────────────────
        if graph is not None:
            summary = graph.summary()
            total_nodes = summary.get("totalNodes", 0)
            total_edges = summary.get("totalEdges", 0)
            node_types = summary.get("nodeTypes", {})
            type_str = ", ".join(f"{k}:{v}" for k, v in sorted(node_types.items()))
            bundle.items.append(ContextItem(
                kind="engineering-graph",
                text=f"Project has {total_nodes} nodes, {total_edges} edges. Types: {type_str}",
                provenance=PROVENANCE_SYSTEM,
            ))

        # ── Artifacts overview ────────────────────────────────────────
        if artifact_store is not None:
            art_summary = artifact_store.summary()
            total_arts = art_summary.get("totalArtifacts", 0)
            by_status = art_summary.get("byStatus", {})
            status_str = ", ".join(f"{k}:{v}" for k, v in sorted(by_status.items()))
            if total_arts > 0:
                bundle.items.append(ContextItem(
                    kind="engineering-artifacts",
                    text=f"Project has {total_arts} artifacts. Status: {status_str}",
                    provenance=PROVENANCE_SYSTEM,
                ))

            # List unverified/stale artifacts as action items
            unverified = artifact_store.list_artifacts(
                status=None  # we filter below
            )
            stale = artifact_store.stale_artifacts()
            if stale:
                names = ", ".join(a.name for a in stale[:5])
                bundle.items.append(ContextItem(
                    kind="engineering-action",
                    text=f"Stale artifacts need revalidation: {names}",
                    provenance=PROVENANCE_SYSTEM,
                ))

        # ── Tool availability ─────────────────────────────────────────
        if tool_registry is not None:
            tool_summary = tool_summary_dict = tool_registry.summary()
            installed = tool_summary.get("installed", 0)
            missing = tool_summary.get("missing", 0)
            unknown = tool_summary.get("unknown", 0)
            bundle.items.append(ContextItem(
                kind="engineering-tools",
                text=f"Tools: {installed} installed, {missing} missing, {unknown} unknown",
                provenance=PROVENANCE_SYSTEM,
            ))

        # ── Available capabilities ────────────────────────────────────
        cap_summary = engineering_capabilities_summary()
        total_caps = cap_summary.get("total", 0)
        by_domain = cap_summary.get("byDomain", {})
        domain_str = ", ".join(f"{k}:{v}" for k, v in sorted(by_domain.items()))
        if total_caps > 0:
            bundle.items.append(ContextItem(
                kind="engineering-capabilities",
                text=f"{total_caps} engineering capabilities: {domain_str}",
                provenance=PROVENANCE_SYSTEM,
            ))

        # ── Recent events ─────────────────────────────────────────────
        if event_store is not None:
            recent = event_store.recent_events(limit=5)
            if recent:
                for evt in recent:
                    bundle.items.append(ContextItem(
                        kind="engineering-event",
                        text=f"{evt.event_type.value}: {evt.outcome or 'no outcome'}",
                        provenance=PROVENANCE_SYSTEM,
                    ))

    return _populate


def extend_context_assembler(assembler: ContextAssembler, **kwargs: Any) -> None:
    """Convenience: wire an engineering provider into an existing assembler.

    This adds an ``_extra_providers`` list to the assembler instance.
    After calling this, ``assembler.assemble()`` will include engineering
    context items automatically.

    Keyword arguments are forwarded to ``make_engineering_context_provider``.
    """
    provider = make_engineering_context_provider(**kwargs)
    if not hasattr(assembler, "_extra_providers"):
        assembler._extra_providers = []  # type: ignore[attr-defined]
    assembler._extra_providers.append(provider)  # type: ignore[attr-defined]

    # Monkey-patch assemble to include extra providers
    _original_assemble = assembler.assemble

    def _patched_assemble(*args: Any, **kw: Any) -> ContextBundle:
        bundle = _original_assemble(*args, **kw)
        for extra in getattr(assembler, "_extra_providers", []):
            extra(bundle)
        return bundle

    assembler.assemble = _patched_assemble  # type: ignore[method-assign]
