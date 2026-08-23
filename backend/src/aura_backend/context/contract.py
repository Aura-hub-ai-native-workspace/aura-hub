"""AURA Context Fabric — the agent contract.

A port of packages/ai-service/src/context/contract.ts.

Renders a `ContextView` into the stable, plain-text block a downstream
agent receives. This is the wire format between AURA and anything that
reasons on its behalf.

Five rules, all of them load-bearing:

1. **Unknown is rendered; empty is omitted.** A section AURA never
   established prints an explicit `unknown` line with the reason. A
   section AURA established and found empty is left out entirely.

2. **Stale is labelled in place.** Not in a footnote — on the section,
   so it cannot be read past.

3. **No secrets.** Only values that already passed through the
   projections in `compose.py` reach here. This renderer adds no new
   source of data.

4. **No persuasion.** No confidence adjectives. Facts and provenance only.

5. **Compact.** Orientation, not content.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..core.js_number import js_number as _num
from .types import ContextView, Freshness, Section


@dataclass(frozen=True)
class SurfaceBudget:
    modules: int
    commits: int
    hotspots: int
    activity: int
    # Show every capability, or only the ones that can actually be used.
    all_capabilities: bool


# How much of each section a surface needs. A `git` question does not
# need twenty module summaries; an `architecture` question does. These
# are budgets, not new intent logic.
BUDGETS: dict[str, SurfaceBudget] = {
    "general":      SurfaceBudget(8, 3, 3, 5, False),
    "coding":       SurfaceBudget(12, 3, 5, 5, False),
    "debugging":    SurfaceBudget(8, 5, 8, 10, False),
    "architecture": SurfaceBudget(20, 2, 3, 3, False),
    "git":          SurfaceBudget(3, 5, 5, 5, False),
    "testing":      SurfaceBudget(10, 3, 5, 5, False),
    "mission":      SurfaceBudget(6, 3, 3, 10, True),
    "planning":     SurfaceBudget(16, 3, 5, 5, True),
    "review":       SurfaceBudget(10, 5, 8, 10, False),
}

_WHITESPACE = re.compile(r"\s+")


def _stale_note(reason: str | None) -> str:
    return f" [STALE{f': {reason}' if reason else ''}]"


def _head(tag: str, freshness: Freshness, reason: str | None) -> str:
    """Section header, carrying its own freshness so it cannot be read past."""
    return f"<{tag}>{_stale_note(reason)}" if freshness == "stale" else f"<{tag}>"


def _section(tag: str, s: Section, body: Callable[[Any], list[str]]) -> str | None:
    """Render a section, or an explicit unknown marker, or nothing.

    Returns None when the section is known-and-empty (omit it).
    """
    if s.freshness == "unknown" or s.value is None:
        return "\n".join([
            f"<{tag}>", f"unknown: {s.reason or 'not established'}", f"</{tag}>",
        ])
    lines = [line for line in body(s.value) if line]
    if not lines:
        return None
    return "\n".join([_head(tag, s.freshness, s.reason), *lines, f"</{tag}>"])


def _list(items: list[str], maximum: int) -> str:
    head = ", ".join(items[:maximum])
    return head + (f", +{len(items) - maximum} more" if len(items) > maximum else "")


def render_context_contract(view: ContextView, surface: str | None = None) -> str:
    """Render the contract.

    Deterministic: the same view renders the same text, so a caller can
    diff two contracts to see what actually changed.
    """
    budget = BUDGETS.get(surface or view.surface, BUDGETS["general"])
    blocks: list[str | None] = []

    # ── project ──────────────────────────────────────────────────────
    blocks.append("\n".join([
        "<PROJECT_CONTEXT>",
        f"name: {view.project.name}",
        f"root: {view.project.root}",
        f"type: {view.project.type}",
        f"language: {view.project.language}",
        "context_version: "
        + (_num(view.context_version) if view.context_version is not None else "none recorded"),
        f"context_freshness: {view.freshness}",
        f"composed_at: {view.composed_at}",
        "</PROJECT_CONTEXT>",
    ]))

    # ── repository ───────────────────────────────────────────────────
    def _repository(r: dict[str, Any]) -> list[str]:
        lines: list[str] = []
        identity = r.get("identity")
        if identity:
            style = identity.get("architectureStyle")
            lines.append(
                f"kind: {identity.get('repositoryType')}"
                + (f" ({style})" if style != "unknown" else "")
            )
            purpose = identity.get("purpose")
            if purpose:
                lines.append(
                    "purpose: " + _WHITESPACE.sub(" ", purpose).strip()[:300]
                )
            primary = identity.get("primaryLanguage")
            if primary and primary != "unknown":
                lines.append(f"primary_language: {primary}")
            if identity.get("buildSystem"):
                lines.append(f"build_system: {identity['buildSystem']}")
            frameworks = identity.get("frameworks") or []
            if frameworks:
                lines.append(f"frameworks: {_list(frameworks, 8)}")
        if r.get("totalFiles") is not None:
            lines.append(f"total_files: {_num(r['totalFiles'])}")
        entry_points = r.get("entryPoints") or []
        if entry_points:
            lines.append(f"entry_points: {_list(entry_points, 5)}")
        modules = r.get("modules") or []
        if modules:
            lines.append("modules:")
            for m in modules[:budget.modules]:
                lines.append(
                    f"  - {m['name']} ({m['path']}, {_num(m['fileCount'])} files)"
                )
            if len(modules) > budget.modules:
                lines.append(f"  - +{len(modules) - budget.modules} more modules")
        profile = r.get("profile")
        if profile:
            patterns = profile.get("designPatterns") or []
            if patterns:
                lines.append(f"design_patterns: {_list(patterns, 6)}")
            decisions = profile.get("keyDecisions") or []
            if decisions:
                lines.append("key_decisions:")
                for d in decisions[:5]:
                    lines.append(f"  - {d}")
        health = r.get("health")
        if health:
            lines.append(f"health_score: {_num(health['score']['overall'])}/100")
        return lines

    blocks.append(_section("REPOSITORY_CONTEXT", view.repository, _repository))

    # ── changes ──────────────────────────────────────────────────────
    def _changes(c: dict[str, Any]) -> list[str]:
        lines: list[str] = []
        if c.get("velocity"):
            lines.append(f"change_velocity: {_num(c['velocity'])}")
        if c.get("patterns"):
            lines.append(f"patterns: {_list(c['patterns'], 5)}")
        if c.get("hotspots"):
            lines.append("hotspots:")
            for h in c["hotspots"][:budget.hotspots]:
                lines.append(f"  - {h['file']} ({h['reason']})")
        return lines

    blocks.append(_section("RECENT_CHANGES", view.changes, _changes))

    # ── git ──────────────────────────────────────────────────────────
    def _git(g: dict[str, Any]) -> list[str]:
        lines = [
            f"branch: {g['branch']}",
            "working_tree: "
            + (
                f"dirty ({_num(g['changedFiles'])} changed file(s))"
                if g["dirty"] else "clean"
            ),
        ]
        commits = g.get("recentCommits") or []
        if commits:
            lines.append("recent_commits:")
            for c in commits[:budget.commits]:
                lines.append(f"  - {c['hash']} {c['subject']}")
        return lines

    blocks.append(_section("GIT_CONTEXT", view.git, _git))

    # ── environment ──────────────────────────────────────────────────
    def _environment(e: dict[str, Any]) -> list[str]:
        lines = [f"os: {e['os']}", f"arch: {e['arch']}"]
        # Programs on the machine and AURA's own subsystems are listed
        # apart: only the former are things an agent could invoke.
        installed = [t for t in e["tools"] if not t["internal"]]
        subsystems = [t for t in e["tools"] if t["internal"]]
        if installed:
            lines.append("tools_installed:")
            for t in installed:
                lines.append(f"  - {t['name']}" + (f" {t['version']}" if t["version"] else ""))
        if subsystems:
            lines.append(
                f"aura_subsystems: {_list([t['name'] for t in subsystems], 10)}"
            )
        return lines

    blocks.append(_section("ENVIRONMENT_CONTEXT", view.environment, _environment))

    # ── capabilities ─────────────────────────────────────────────────
    def _capabilities(caps: list[dict[str, Any]]) -> list[str]:
        usable = [c for c in caps if c["availability"] == "available"]
        gated = [c for c in caps if c["availability"] == "approval"]
        blocked = [c for c in caps if c["availability"] == "not-drivable"]

        lines: list[str] = []
        if usable:
            lines.append(f"available: {_list([c['id'] for c in usable], 40)}")
        if gated:
            lines.append(
                f"requires_human_approval: {_list([c['id'] for c in gated], 40)}"
            )
        if budget.all_capabilities and blocked:
            lines.append("present_but_not_drivable:")
            for c in blocked[:10]:
                lines.append(
                    f"  - {c['id']}" + (f" ({c['reason']})" if c.get("reason") else "")
                )
        # Unavailable capabilities are deliberately not listed: an agent
        # does not need the catalogue of everything this machine cannot do.
        return lines

    blocks.append(_section("AVAILABLE_CAPABILITIES", view.capabilities, _capabilities))

    # ── missions ─────────────────────────────────────────────────────
    def _missions(ms: list[dict[str, Any]]) -> list[str]:
        return [
            f"- {m['text'][:120]} [{m['category']}] "
            f"status={m['status'] if m['status'] is not None else 'no plan'} "
            f"tasks={_num(m['completedTasks'])}/{_num(m['taskCount'])}"
            for m in ms
        ]

    blocks.append(_section("ACTIVE_MISSIONS", view.missions, _missions))

    # ── activity ─────────────────────────────────────────────────────
    def _activity(records: list[dict[str, Any]]) -> list[str]:
        lines: list[str] = []
        for a in records[:budget.activity]:
            who = f"{a['actor']}/{a['nodeId']}" if a.get("nodeId") else a["actor"]
            lines.append(f"- {a['at']} {a['capabilityId']} by {who} → {a['outcome']}")
        return lines

    blocks.append(_section("CURRENT_ACTIVITY", view.activity, _activity))

    # ── constraints ──────────────────────────────────────────────────
    if view.constraints:
        blocks.append("\n".join([
            "<CONTEXT_CONSTRAINTS>",
            *[f"- {c.text}" for c in view.constraints],
            "</CONTEXT_CONSTRAINTS>",
        ]))

    return "\n\n".join(b for b in blocks if b is not None)


def render_context_header(view: ContextView) -> str:
    """The smallest useful orientation: who am I working on, and is what
    I am being told current."""
    version = _num(view.context_version) if view.context_version is not None else "—"
    return "\n".join([
        f"project: {view.project.name} ({view.project.root})",
        f"context: v{version} {view.freshness}",
    ])


def usable_capabilities(view: ContextView) -> list[dict[str, Any]]:
    """Which capabilities a caller may actually invoke, for a UI or prompt."""
    return [
        c for c in (view.capabilities.value or [])
        if c["availability"] in ("available", "approval")
    ]
