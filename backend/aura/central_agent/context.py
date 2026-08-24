"""Context assembly — bounded, provenance-marked, governance-aware.

The agent never dumps a workspace into a model request. A ContextBundle is
assembled from: session history (own store), stored workflows (own store),
capabilities (the Fabric manifest), pending approvals (the ledger), and an
OPTIONAL bounded project scan that itself goes through governed git
invocations when a project path is supplied. Every item carries
provenance; external content stays marked untrusted.

This module is the seam where the future Python Context Fabric (P9) will
plug in; it deliberately owns no persistence of its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PROVENANCE_SYSTEM = "system"
PROVENANCE_SESSION = "session"
PROVENANCE_STORE = "store"
PROVENANCE_EXTERNAL = "external"

MAX_ITEMS_PER_SOURCE = 20
MAX_ITEM_CHARS = 600


@dataclass
class ContextItem:
    kind: str          # 'capability' | 'workflow' | 'approval' | 'message' | 'project'
    text: str
    provenance: str    # one of the PROVENANCE_* constants
    untrusted: bool = False


@dataclass
class ContextBundle:
    items: list[ContextItem] = field(default_factory=list)

    def render(self, max_chars: int = 8000) -> str:
        """Bounded plain-text view for prompts. Untrusted items are fenced
        and labelled so no consumer can mistake them for instructions."""
        parts: list[str] = []
        used = 0
        for item in self.items[:MAX_ITEMS_PER_SOURCE * 5]:
            text = item.text[:MAX_ITEM_CHARS]
            if item.untrusted:
                line = f"<untrusted-data provenance=\"{item.provenance}\">{text}</untrusted-data>"
            else:
                line = f"[{item.kind}|{item.provenance}] {text}"
            if used + len(line) > max_chars:
                break
            parts.append(line)
            used += len(line) + 1
        return "\n".join(parts)


class ContextAssembler:
    def __init__(self, workflow_lister=None, capability_lister=None,
                 approval_lister=None, session_loader=None,
                 project_scanner=None) -> None:
        self._workflows = workflow_lister or (lambda: [])
        self._capabilities = capability_lister or (lambda: [])
        self._approvals = approval_lister or (lambda: [])
        self._sessions = session_loader or (lambda sid: None)
        self._project_scan = project_scanner or (lambda path: [])

    def assemble(self, session_id: str | None = None,
                 project_path: str | None = None) -> ContextBundle:
        bundle = ContextBundle()
        caps = self._capabilities()[:MAX_ITEMS_PER_SOURCE]
        for c in caps:
            bundle.items.append(ContextItem(
                kind="capability",
                text=f"{c.id}: {c.description} (risk {c.risk})",
                provenance=PROVENANCE_SYSTEM))
        wfs = self._workflows()[:MAX_ITEMS_PER_SOURCE]
        for w in wfs:
            bundle.items.append(ContextItem(
                kind="workflow",
                text=f"{w.get('id')}: {w.get('name')} "
                     f"({w.get('nodeCount', '?')} nodes)",
                provenance=PROVENANCE_STORE))
        approvals = self._approvals()[:MAX_ITEMS_PER_SOURCE]
        for a in approvals:
            summary = a.get("summary") or ""
            bundle.items.append(ContextItem(
                kind="approval",
                text=f"{a.get('id')} pending: {summary[:200]}",
                provenance=PROVENANCE_SYSTEM))
        if session_id:
            session = self._sessions(session_id)
            if session is not None:
                for m in session.messages[-6:]:
                    bundle.items.append(ContextItem(
                        kind="message", text=f"{m.role}: {m.content[:300]}",
                        provenance=PROVENANCE_SESSION))
        if project_path:
            for entry in self._project_scan(project_path)[:MAX_ITEMS_PER_SOURCE]:
                bundle.items.append(ContextItem(
                    kind="project", text=str(entry)[:300],
                    provenance=PROVENANCE_EXTERNAL, untrusted=True))
        return bundle
