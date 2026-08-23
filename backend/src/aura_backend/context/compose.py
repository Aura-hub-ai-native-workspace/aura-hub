"""AURA Context Fabric — composition.

A port of packages/ai-service/src/context/compose.ts.

This is a FACADE. It computes no repository understanding of its own.
Every value it returns is projected from an authority that already owns
that fact:

    identity, modules, profile, health   → intelligence loaders
    context version                      → intelligence versioning
    staleness rule                       → intelligence.is_cache_stale
    change intelligence                  → intelligence.change
    git                                  → intelligence.git_signals
    project root / identity              → workspace ProjectRegistry
    environment                          → the caller's last observed scan
    capabilities                         → the Capability Fabric
    missions                             → the mission records
    activity                             → CapabilityFabric.audit()

Three hard rules, enforced by construction:

1. **One project.** Composition takes one project id, resolves it through
   the registry, and derives every section from that project's own root.
   Facts that cannot be attributed to it are reported `unknown` rather
   than borrowed from elsewhere.

2. **Read-only.** Nothing here writes, spawns, mounts, indexes or
   snapshots. It calls `load_*` and `get_*`, never `generate_*`,
   `save_*` or `create_version`.

3. **No rescans.** The environment is supplied by the caller from the
   scan it already performed. Staleness uses one `stat`, not a walk.
"""

from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..fabric import CAPABILITY_MANIFEST, CapabilityFabric
from ..fabric.types import InvocationActor, InvocationContext, now_iso
from ..intelligence import (
    MissionReader,
    analyze_change_patterns,
    detect_hotspots,
    gather_git_status,
    gather_recent_commits,
    get_change_velocity,
    get_current_version,
    identity_needs_regeneration,
    is_cache_stale,
    load_change_log,
    load_identity,
    load_repository_health,
    load_repository_profile,
    load_repository_summary,
)
from ..policy.types import PolicyDecision
from ..workspace.profile import load_profile
from ..workspace.projects import ProjectRegistry
from .types import (
    ContextConstraint,
    ContextGit,
    ContextProject,
    ContextResult,
    ContextUnavailable,
    ContextView,
    EnvironmentSnapshot,
    Freshness,
    Section,
)

# Node's `os.arch()` vocabulary, which the reference reports. Reporting
# `x86_64` here would be a different string for the same machine.
_ARCH = {
    "x86_64": "x64", "amd64": "x64", "AMD64": "x64",
    "aarch64": "arm64", "arm64": "arm64",
    "i386": "ia32", "i686": "ia32", "x86": "ia32",
    "armv7l": "arm", "ppc64le": "ppc64", "s390x": "s390x",
    "riscv64": "riscv64", "loongarch64": "loong64",
}


@dataclass
class ContextSources:
    registry: ProjectRegistry
    missions: MissionReader
    home: Path
    # The project the pipeline currently has mounted, if any.
    mounted_project_id: str | None = None
    # None when the Fabric is not attached — capabilities then read `unknown`.
    fabric: CapabilityFabric | None = None
    # None when nothing has been scanned yet — environment reads `unknown`.
    environment: EnvironmentSnapshot | None = None


@dataclass
class ComposeOptions:
    surface: str = "general"
    # A git snapshot the caller already took.
    git: ContextGit | None = None
    # Skip the git read entirely (git then reads `unknown`).
    include_git: bool = True
    activity_limit: int = 10
    mission_limit: int = 5


# ── freshness helpers ────────────────────────────────────────────────

def _unknown(reason: str) -> Section:
    return Section(value=None, freshness="unknown", generated_at=None, reason=reason)


@dataclass
class _Grade:
    freshness: Freshness
    generated_at: str | None
    reason: str | None = None


def _grade(generated_at: str | None, root: str) -> _Grade:
    """Grade an artifact using the engine's OWN staleness rule, so the
    Fabric can never call something fresh that the engine would
    regenerate."""
    if not generated_at:
        return _Grade("unknown", None, "never computed")
    if is_cache_stale(generated_at, root):
        return _Grade("stale", generated_at,
                      "the repository changed after this was computed")
    return _Grade("fresh", generated_at)


def _worst(grades: list[str]) -> Freshness:
    """A view is only as fresh as its weakest KNOWN part."""
    if "stale" in grades:
        return "stale"
    if "fresh" in grades:
        return "fresh"
    return "unknown"


# ── section projections ──────────────────────────────────────────────

def _project_repository(home: Path, project_id: str, root: str) -> Section:
    """L0/L1/L2 — identity, modules, architecture profile, health scores."""
    identity = load_identity(home, project_id)
    summary = load_repository_summary(home, project_id)
    profile = load_repository_profile(home, project_id)
    health = load_repository_health(home, project_id)

    if not identity and not summary and not profile and not health:
        return _unknown("the repository has not been indexed yet")

    # Identity has its own regeneration test — prefer it over the generic
    # timestamp rule, because it is the check the engine actually applies.
    identity_stale = identity_needs_regeneration(home, project_id, root) if identity else False
    grades = [
        (
            _Grade("stale", identity.get("generatedAt"), "the project fingerprint changed")
            if identity_stale
            else _Grade("fresh", identity.get("generatedAt"))
        )
        if identity
        else _Grade("unknown", None, "identity never computed"),
        _grade((summary or {}).get("generatedAt"), root),
        _grade((profile or {}).get("generatedAt"), root),
        _grade((health or {}).get("generatedAt"), root),
    ]

    timestamps = sorted(g.generated_at for g in grades if g.generated_at)
    newest = timestamps[-1] if timestamps else None

    # Modules are reduced to orientation only. The full summary can be
    # hundreds of entries; an agent needs the shape, then it looks.
    modules = [
        {
            "name": m.get("name"), "path": m.get("path"),
            "fileCount": m.get("fileCount"), "description": m.get("description"),
        }
        for m in ((summary or {}).get("modules") or [])[:24]
    ]

    value = {
        "identity": identity,
        "modules": modules,
        "totalFiles": (summary or {}).get("totalFiles"),
        "entryPoints": (identity or {}).get("entryPoints") or [],
        "profile": profile,
        "health": {"score": health["score"]} if health else None,
    }

    stale = [g for g in grades if g.freshness == "stale"]
    return Section(
        value=value,
        freshness=_worst([g.freshness for g in grades]),
        generated_at=newest,
        reason=stale[0].reason if stale else None,
    )


def _project_changes(home: Path, root: str) -> Section:
    """L3 — change intelligence, scoped to this project.

    The change log is a single workspace-wide file whose entries carry a
    file path but no project id. Attribution is therefore by path prefix.
    When entries exist but none are absolute they cannot be attributed to
    any project, and this reports `unknown` rather than silently lending
    another project's history to this one.
    """
    log = load_change_log(home)
    if not log:
        return _unknown("no change history has been recorded")

    entries = log.get("entries") or []
    attributable = [e for e in entries if os.path.isabs(e.get("file", ""))]
    if entries and not attributable:
        return _unknown(
            "recorded changes carry no absolute path, so they cannot be "
            "attributed to this project"
        )

    scoped_entries = [
        e for e in attributable
        if e["file"] == root or e["file"].startswith(root + os.sep)
    ]
    # Re-run the existing analysers over the project-scoped slice, so the
    # maths stays owned by the change module rather than copied here.
    scoped = {"entries": scoped_entries, "patterns": [], "generatedAt": log.get("generatedAt")}

    return Section(
        value={
            "velocity": get_change_velocity(scoped),
            "hotspots": detect_hotspots(scoped)[:8],
            "patterns": [p["pattern"] for p in analyze_change_patterns(scoped)[:6]],
        },
        freshness="fresh",
        generated_at=log.get("generatedAt"),
    )


def _project_git(root: str) -> Section:
    """L4 — git, read through the existing read-only signal gatherers."""
    status = gather_git_status(root)
    at = now_iso()
    if not status.available:
        return Section(value=None, freshness="unknown", generated_at=None,
                       reason=status.reason)
    return Section(
        value=ContextGit(
            branch=status.branch,
            dirty=status.dirty,
            changed_files=status.changed_files,
            recent_commits=gather_recent_commits(root, 5),
        ).to_json(),
        # Git is read live at composition time, so it is fresh by construction.
        freshness="fresh",
        generated_at=at,
    )


def _project_environment(snapshot: EnvironmentSnapshot | None) -> Section:
    """L4 — the machine, from the caller's already-observed scan."""
    if not snapshot or not snapshot.scanned_at:
        return _unknown("the environment has not been scanned yet")
    return Section(
        value={
            "os": f"{_node_platform()} {platform.release()}",
            "arch": _ARCH.get(platform.machine(), platform.machine()),
            # Version is the probe's own output. No credential, token or
            # environment variable is read here — only what `--version` said.
            "tools": [
                {
                    "id": n.get("id"), "name": n.get("name"),
                    "capabilities": n.get("capabilities") or [],
                    "version": n.get("version"),
                    "internal": bool(n.get("internal", False)),
                }
                for n in snapshot.nodes
            ],
            "providedCapabilities": sorted(snapshot.provided_capabilities),
        },
        freshness="fresh",
        generated_at=snapshot.scanned_at,
    )


def _node_platform() -> str:
    """Node's `os.platform()` vocabulary: linux / darwin / win32."""
    return "win32" if sys.platform.startswith("win") else sys.platform


def _project_capabilities(
    fabric: CapabilityFabric | None, project_id: str, root: str
) -> Section:
    """L4 — what can actually be done right now.

    Read straight from the Capability Fabric: the manifest for the list,
    `is_supported` for whether an executor exists, and `evaluate` for the
    real policy decision including node routing. No capability registry
    is duplicated and nothing is executed.
    """
    if fabric is None:
        return _unknown("the capability fabric is not attached to this service")

    context = InvocationContext(
        actor=InvocationActor(kind="system", id="context-fabric"),
        project_id=project_id,
        cwd=root,
    )

    value: list[dict[str, Any]] = []
    for cap in CAPABILITY_MANIFEST:
        if not fabric.is_supported(cap.id):
            value.append({
                "id": cap.id, "name": cap.name, "risk": cap.risk.value,
                "availability": "not-drivable",
                "reason": "no executor is registered for this capability",
            })
            continue

        evaluation = fabric.evaluate(cap.id, context)
        if evaluation is None:
            value.append({
                "id": cap.id, "name": cap.name, "risk": cap.risk.value,
                "availability": "unavailable",
                "reason": "the fabric does not describe this capability",
            })
            continue

        if evaluation.decision == PolicyDecision.DENY:
            # `node-unsupported` is the honest "installed but AURA cannot
            # drive it" case. It is not the same as absent, and the
            # difference decides whether "install it" is useful advice.
            availability = (
                "not-drivable" if evaluation.rule == "node-unsupported" else "unavailable"
            )
        elif evaluation.decision == PolicyDecision.AUTO_EXECUTE:
            availability = "available"
        else:
            availability = "approval"

        value.append({
            "id": cap.id, "name": cap.name, "risk": cap.risk.value,
            "availability": availability,
            "rule": evaluation.rule,
            "reason": evaluation.reason,
        })

    return Section(value=value, freshness="fresh", generated_at=now_iso())


def _project_missions(missions: MissionReader, project_id: str, limit: int) -> Section:
    """L4 — missions, from the one mission store.

    Reports execution-level status only. The mission model has no
    per-task RUNNING state, so no task is ever described as "working" —
    the count of genuinely completed tasks is reported instead.
    """
    try:
        listed = missions.list(project_id)
    except OSError:
        return _unknown("the mission store could not be read")

    value = [
        {
            "id": m["id"],
            "text": m["text"],
            "createdAt": m["createdAt"],
            "category": m["category"],
            "status": (m.get("execution") or {}).get("status"),
            "taskCount": m["taskCount"],
            "completedTasks": _count_completed(missions, project_id, m["id"]),
            "approved": (m.get("approval") or {}).get("status") == "approved",
        }
        for m in listed[:limit]
    ]
    return Section(value=value, freshness="fresh", generated_at=now_iso())


def _count_completed(missions: MissionReader, project_id: str, mission_id: str) -> int:
    """Terminal task states only. `proposed` is not progress; it is a question."""
    record = missions.get(project_id, mission_id) or {}
    tasks = (record.get("goalGraph") or {}).get("tasks") or []
    return len([t for t in tasks if t.get("status") in ("accepted", "done")])


def _project_activity(
    fabric: CapabilityFabric | None, project_id: str, limit: int
) -> Section:
    """L4 — recent activity, projected from the Fabric's audit trail.

    A read of the existing authority; no activity record is created,
    copied or persisted here.
    """
    if fabric is None:
        return _unknown("the capability fabric is not attached to this service")

    matching = [r for r in fabric.audit() if r.project_id == project_id]
    # `slice(-limit)` with limit 0 is the whole array in JavaScript, and
    # `[-0:]` is the whole list in Python — the same, deliberately.
    window = matching[-limit:] if limit else matching[0:]
    value = [
        {
            "at": r.at,
            "capabilityId": r.capability_id,
            "actor": r.actor.kind,
            "nodeId": r.executed_node_id or r.node_id,
            "outcome": r.outcome.value if hasattr(r.outcome, "value") else r.outcome,
            "decision": r.decision.value if hasattr(r.decision, "value") else r.decision,
        }
        for r in reversed(window)
    ]
    # `nodeId` is optional in the contract: absent means unattributable.
    for record in value:
        if record["nodeId"] is None:
            del record["nodeId"]

    return Section(value=value, freshness="fresh", generated_at=now_iso())


def _project_constraints(
    project: ContextProject, git: dict[str, Any] | None, freshness: Freshness
) -> list[ContextConstraint]:
    """Each constraint is derived from an OBSERVED fact, not from advice."""
    out = [
        ContextConstraint(
            id="project-boundary",
            text=(
                f'All work belongs to the project "{project.name}" rooted at '
                f"{project.root}. Do not read or modify files outside this root."
            ),
        ),
        ContextConstraint(
            id="governed-execution",
            text=(
                "Execution is governed by the AURA Capability Fabric. High-risk "
                "capabilities require explicit human approval and cannot be "
                "self-authorized."
            ),
        ),
        ContextConstraint(
            id="no-fabrication",
            text=(
                "The facts in this context were computed by AURA. Where a section "
                "is marked unknown, treat it as not established — do not "
                "substitute an assumption."
            ),
        ),
    ]

    if git and git.get("dirty"):
        out.append(ContextConstraint(
            id="uncommitted-work",
            text=(
                f"The working tree has {git['changedFiles']} uncommitted change(s) "
                f"on branch \"{git['branch']}\". Never reset, clean, stash, "
                "checkout over or discard this work."
            ),
        ))

    if freshness == "stale":
        out.append(ContextConstraint(
            id="stale-context",
            text=(
                "Part of this context is stale: the repository changed after it "
                "was computed. Verify against the files before relying on the "
                "affected sections."
            ),
        ))

    return out


# ── the composer ─────────────────────────────────────────────────────

def compose_context_view(
    project_id: str,
    sources: ContextSources,
    options: ComposeOptions | None = None,
) -> ContextResult:
    """Compose one project's `ContextView`.

    Resolves the project through the registry — the single project
    authority — and never mounts, opens or touches it. An unresolvable id
    yields an explicit `unavailable` result so a caller can never read
    "no such project" as "an empty project".
    """
    options = options or ComposeOptions()
    record = sources.registry.get(project_id)
    if record is None:
        return ContextUnavailable(
            project_id=project_id,
            reason=f'no project is registered with id "{project_id}"',
        )

    root = record.path
    home = sources.home
    profile = load_profile(home, project_id)

    project = ContextProject(
        id=record.id,
        name=record.name,
        root=root,
        type=profile.type if profile else record.type,
        language=profile.primary_language if profile else record.language,
        mounted=sources.mounted_project_id == record.id,
        last_opened_at=record.last_opened_at,
    )

    repository = _project_repository(home, project_id, root)
    changes = _project_changes(home, root)
    environment = _project_environment(sources.environment)
    capabilities = _project_capabilities(sources.fabric, project_id, root)
    missions = _project_missions(sources.missions, project_id, options.mission_limit)
    activity = _project_activity(sources.fabric, project_id, options.activity_limit)

    if options.git is not None:
        git = Section(value=options.git.to_json(), freshness="fresh", generated_at=now_iso())
    elif options.include_git:
        git = _project_git(root)
    else:
        git = _unknown("git was not read for this request")

    # Overall freshness IS the repository understanding's freshness.
    #
    # Not a blend: live reads (git, capabilities, missions, activity) are
    # fresh by construction and would mask an unindexed project behind a
    # confident headline. And not the worst of everything either — the
    # workspace-wide change log is normally empty, which would pin every
    # project to `unknown` forever and make the signal useless.
    freshness: Freshness = repository.freshness

    version = get_current_version(home, project_id)

    return ContextView(
        context_version=version.get("version") if version else None,
        composed_at=now_iso(),
        surface=options.surface,
        freshness=freshness,
        project=project,
        repository=repository,
        changes=changes,
        git=git,
        environment=environment,
        capabilities=capabilities,
        missions=missions,
        activity=activity,
        constraints=_project_constraints(project, git.value, freshness),
    )
