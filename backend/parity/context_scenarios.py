"""Fixture homes for the Context Fabric differential.

Each scenario builds a complete `AURA_HOME` on disk plus a project
directory, then names the compose options to run against it. Both
implementations read the SAME home — nothing is generated twice.

The scenarios exist to reach the paths a live service cannot be made to
produce on demand: a stale artifact, a changed fingerprint, a change log
that cannot be attributed, a module list that overflows every surface
budget, a version history whose pointer is out of range.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

SURFACES = [
    "general", "coding", "debugging", "architecture", "git",
    "testing", "mission", "planning", "review",
]

# A surface no budget table knows. The reference falls back to `general`;
# so must the port, or an unknown surface silently renders a different
# amount of the project.
UNKNOWN_SURFACE = "not-a-surface"


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{dt.microsecond // 1000:03d}Z"


def _now() -> datetime:
    return datetime.now(UTC)


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def _register(home: Path, project_id: str, root: Path, **overrides: Any) -> None:
    """Write the registry file directly.

    Deliberately not through either implementation's `add()`: the
    fixture must be identical for both, and a registry written by one of
    the two under test is not a neutral input.
    """
    record = {
        "id": project_id,
        "name": overrides.get("name", project_id),
        "path": str(root),
        "type": overrides.get("type", "unknown"),
        "language": overrides.get("language", "unknown"),
        "createdAt": "2026-01-01T00:00:00.000Z",
        "lastOpenedAt": overrides.get("lastOpenedAt"),
    }
    file = home / "projects.json"
    existing = json.loads(file.read_text()) if file.exists() else []
    existing.append(record)
    _write(file, existing)


def _identity(project_id: str, generated_at: str, fingerprint: str, **kw: Any) -> dict:
    return {
        "id": project_id,
        "generatedAt": generated_at,
        "fingerprint": fingerprint,
        "repositoryType": kw.get("repositoryType", "application"),
        "architectureStyle": kw.get("architectureStyle", "layered"),
        "purpose": kw.get("purpose", "A fixture project."),
        "primaryLanguage": kw.get("primaryLanguage", "TypeScript"),
        "buildSystem": kw.get("buildSystem", "npm"),
        "frameworks": kw.get("frameworks", ["react", "fastify"]),
        "entryPoints": kw.get("entryPoints", ["src/index.ts"]),
        "confidence": 0.9,
    }


def _fingerprint(root: Path) -> str:
    """The reference's identity fingerprint, computed independently here.

    Written by the harness rather than by either implementation, so a
    port that computes it wrongly is caught rather than agreed with.
    """
    markers = ("package.json", "requirements.txt", "pyproject.toml", "go.mod",
               "Cargo.toml", "pom.xml", "Makefile", "CMakeLists.txt")
    parts = []
    for marker in markers:
        try:
            nanoseconds = (root / marker).stat().st_mtime_ns
            # Node's own arithmetic, spelled out here on purpose: the
            # harness must not borrow the port's helper, or a shared
            # mistake in it would read as agreement.
            millis = (nanoseconds // 10**9) * 1000 + (nanoseconds % 10**9) / 1e6
            parts.append(f"{marker}:{repr(millis) if millis % 1 else int(millis)}")
        except OSError:
            parts.append(f"{marker}:0")
    return "|".join(parts)


def _freeze(root: Path, seconds_ago: int = 7200) -> None:
    """Pin the project root's mtime into the past.

    `isCacheStale` compares the root's mtime against the artifact's
    timestamp, so a freshly created fixture directory is newer than every
    artifact in it and everything would read `stale`. Freezing the root
    after its contents exist is what makes a `fresh` scenario reachable
    at all — and it is applied to the same directory both
    implementations read.
    """
    stamp = (_now() - timedelta(seconds=seconds_ago)).timestamp()
    os.utime(root, (stamp, stamp))


def _git_repo(root: Path, *, dirty: bool) -> None:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "f@x",
        "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "f@x",
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
    }
    run = lambda *a: subprocess.run(
        ["git", *a], cwd=root, env=env, capture_output=True, check=True,
    )
    run("init", "-q", "-b", "fixture-branch")
    (root / "committed.txt").write_text("one\n")
    run("add", "-A")
    run("commit", "-q", "-m", "first fixture commit")
    (root / "second.txt").write_text("two\n")
    run("add", "-A")
    run("commit", "-q", "-m", "second fixture commit")
    if dirty:
        (root / "uncommitted.txt").write_text("dirty\n")


def _mission(index: int) -> dict[str, Any]:
    """A mission record in the shape the mission engine actually writes.

    `taskRuns` is present because the reference's hydration reads it
    without a guard; a record missing it is covered separately.
    """
    return {
        "id": f"m{index}",
        "projectId": "p1",
        "text": ("A mission with a deliberately long description that runs well "
                 "past the hundred and twenty character budget the contract "
                 f"renderer applies to it — number {index}."),
        "createdAt": _iso(_now() - timedelta(days=index)),
        "classification": {"category": "feature"} if index % 2 else None,
        "goalGraph": {
            "goals": [{"id": "g1", "text": "a goal"}],
            "tasks": [
                {"id": f"t{j}", "goalId": "g1", "focusAreaId": "f1",
                 "title": f"task {j}", "description": "", "kind": "implement",
                 "targetFile": None, "mode": "assisted", "priority": "medium",
                 "dependencies": [f"t{j - 1}"] if j else [],
                 "estimatedDurationMinutes": 10, "confidence": 0.7,
                 "risk": "low", "owner": "ai", "automationLevel": "assisted",
                 "status": ["proposed", "accepted", "done", "rejected"][j % 4]}
                for j in range(index + 1)
            ],
        },
        "taskRuns": [],
        "approval": {"status": "approved"} if index % 3 == 0 else {"status": "pending"},
        "quality": {"overall": 0.8},
        "execution": {"status": "completed"} if index % 2 else None,
    }


# Scenarios where `ContextMission.status` is derived by the mission
# EXECUTION ENGINE rather than read from disk.
#
# The reference's `MissionStore` hydrates every read: a record with a
# plan but no persisted `execution` block is given one, and a record
# whose execution is still live has its status recomputed from its
# checkpoints. That derivation is the engine's, and the engine is Phase
# 11 — reimplementing it here would create a second authority for
# mission status, which is exactly what must not happen.
#
# So `status` alone is masked in these scenarios and reported separately.
# Every other field of every mission is compared exactly.
STATUS_DERIVED_BY_ENGINE = {"missions", "zero-limits"}

# The one place the two implementations are known to disagree
# wholesale, and exactly how. Asserted, not tolerated: if the shape of
# the difference changes, the harness fails.
EXPECTED_DIVERGENCE = {
    "missions-unhydratable": {
        "section": "missions",
        "typescript": {"freshness": "unknown",
                       "reason": "the mission store could not be read"},
        "python": {"freshness": "fresh"},
        "why": ("hydration lives in the mission execution engine, which is "
                "Phase 11. The read-only reader ported here does not hydrate, "
                "so it survives a record the reference throws on."),
    },
}


SUPPLIED_GIT = {
    "branch": "supplied-branch",
    "dirty": True,
    "changedFiles": 4,
    "recentCommits": [
        {"hash": f"deadbeef{i:02d}", "date": f"2026-0{i}-01T00:00:00Z",
         "subject": f"supplied commit {i}"}
        for i in range(1, 7)
    ],
}

ENVIRONMENT = {
    "scannedAt": "2026-06-01T09:00:00.000Z",
    "nodes": [
        {"id": "git", "name": "Git", "capabilities": ["vcs"], "version": "2.45.0"},
        {"id": "node", "name": "Node.js", "capabilities": ["runtime"], "version": None},
        {"id": "mission-control", "name": "Mission Control",
         "capabilities": ["planning"], "version": "1.0", "internal": True},
        {"id": "claude", "name": "Claude Code",
         "capabilities": ["coding-agent"], "version": "2.0.1"},
    ],
    # Deliberately unsorted: the contract sorts, and a port that forwards
    # the caller's order would pass a lazier comparison.
    "providedCapabilities": ["vcs", "coding-agent", "runtime", "planning"],
}


def build(work: Path) -> list[dict[str, Any]]:
    """Build every fixture home and return the jobs to run against them."""
    jobs: list[dict[str, Any]] = []

    def scenario(name: str, **job: Any) -> tuple[Path, Path]:
        home = work / name / "home"
        root = work / name / "project"
        home.mkdir(parents=True)
        root.mkdir(parents=True)
        jobs.append({
            "name": name, "auraHome": str(home), "projectId": job.pop("projectId", "p1"),
            "surfaces": SURFACES + [UNKNOWN_SURFACE], **job,
        })
        return home, root

    # ── 1. an id the registry does not know ──────────────────────────
    home, root = scenario("unresolvable", projectId="nobody", includeGit=False)

    # ── 2. registered, nothing ever computed ─────────────────────────
    home, root = scenario("bare", includeGit=False)
    _register(home, "p1", root, name="Bare Project")

    # ── 3. every artifact present and current ────────────────────────
    home, root = scenario("indexed-fresh", includeGit=False, mountedProjectId="p1")
    (root / "package.json").write_text('{"name":"fixture"}')
    _register(home, "p1", root, name="Indexed", type="application",
              language="TypeScript", lastOpenedAt="2026-05-05T10:00:00.000Z")
    # Four DIFFERENT timestamps, deliberately not in file order: the
    # section reports the NEWEST of them, and a fixture where they all
    # match could not tell newest from oldest from first.
    identity_at = _iso(_now() - timedelta(minutes=17))
    summary_at = _iso(_now() - timedelta(minutes=2))     # the newest
    profile_at = _iso(_now() - timedelta(minutes=31))
    health_at = _iso(_now() - timedelta(minutes=9))
    _freeze(root)
    _write(home / "identity" / "p1.json",
           _identity("p1", identity_at, _fingerprint(root)))
    _write(home / "summaries" / "p1.json", {
        "generatedAt": summary_at, "totalFiles": 412,
        "modules": [{"name": f"mod{i}", "path": f"src/mod{i}",
                     "fileCount": i, "description": f"module {i}"}
                    for i in range(1, 41)],
    })
    _write(home / "repo-profile" / "p1.json", {
        "generatedAt": profile_at,
        "designPatterns": ["repository", "facade", "observer", "strategy",
                           "adapter", "visitor", "builder"],
        "keyDecisions": [f"decision {i}" for i in range(1, 8)],
    })
    _write(home / "health" / "p1.json",
           {"generatedAt": health_at, "score": {"overall": 87, "maintainability": 90}})
    _write(home / "versions" / "p1.json", {
        "current": 2,
        "versions": [{"version": 1, "at": "2026-01-01T00:00:00.000Z"},
                     {"version": 7, "at": "2026-02-01T00:00:00.000Z"}],
    })

    # ── 3b. artifacts minutes old, but the repository moved after ────
    # The age rule alone would call this fresh. Only the mtime check
    # catches it, which is the whole point of `isCacheStale` consulting
    # the filesystem rather than just the clock.
    home, root = scenario("touched-after-indexing", includeGit=False)
    (root / "package.json").write_text('{"name":"fixture"}')
    _register(home, "p1", root, name="Touched")
    _write(home / "summaries" / "p1.json", {
        "generatedAt": _iso(_now() - timedelta(minutes=4)),
        "totalFiles": 3, "modules": [],
    })
    # Touch the root LAST, so it is newer than the artifact that
    # describes it. No _freeze here — that is the mutation under test.
    (root / "touched-after.txt").write_text("moved\n")

    # ── 4. everything computed, then the repository moved ────────────
    home, root = scenario("indexed-stale", includeGit=False)
    (root / "package.json").write_text('{"name":"fixture"}')
    _register(home, "p1", root, name="Stale")
    old = _iso(_now() - timedelta(hours=3))
    _write(home / "identity" / "p1.json",
           _identity("p1", old, _fingerprint(root),
                     purpose="  A  purpose\twith\n\nirregular   whitespace. " + "x" * 400))
    _write(home / "summaries" / "p1.json",
           {"generatedAt": old, "totalFiles": 9, "modules": []})
    _write(home / "health" / "p1.json", {"generatedAt": old, "score": {"overall": 41.0}})

    # ── 5. identity current by clock, wrong by fingerprint ───────────
    home, root = scenario("fingerprint-changed", includeGit=False)
    (root / "package.json").write_text('{"name":"fixture"}')
    _freeze(root)
    _register(home, "p1", root, name="Fingerprint")
    _write(home / "identity" / "p1.json",
           _identity("p1", _iso(_now() - timedelta(minutes=1)), "not-the-fingerprint",
                     architectureStyle="unknown", primaryLanguage="unknown",
                     buildSystem=None, frameworks=[], entryPoints=[]))

    # ── 6. one artifact only — a partially understood project ────────
    home, root = scenario("health-only", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Health Only")
    _write(home / "health" / "p1.json",
           {"generatedAt": _iso(_now() - timedelta(minutes=2)), "score": {"overall": 55}})

    # ── 7. a change log that belongs to this project ─────────────────
    home, root = scenario("changes-mine", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Changes")
    now = _now()
    entries = []
    for i in range(12):
        entries.append({
            "file": str(root / f"src/hot{i % 3}.ts"),
            "timestamp": _iso(now - timedelta(minutes=i * 3)),
            "kind": "edit",
        })
    entries.append({"file": str(root / "src/cold.ts"),
                    "timestamp": _iso(now - timedelta(days=30)), "kind": "edit"})
    _write(home / "changes" / "log.json",
           {"entries": entries, "patterns": [], "generatedAt": _iso(now)})

    # ── 8. entries exist, none can be attributed to any project ──────
    home, root = scenario("changes-unattributable", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Relative Changes")
    _write(home / "changes" / "log.json", {
        "entries": [{"file": "src/relative.ts", "timestamp": _iso(_now()), "kind": "edit"}],
        "patterns": [], "generatedAt": _iso(_now()),
    })

    # ── 9. absolute entries, all belonging to a DIFFERENT project ────
    home, root = scenario("changes-elsewhere", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Other Changes")
    other = work / "changes-elsewhere" / "other-project"
    other.mkdir(parents=True)
    _write(home / "changes" / "log.json", {
        "entries": [{"file": str(other / "x.ts"), "timestamp": _iso(_now()), "kind": "edit"}
                    for _ in range(6)],
        "patterns": [], "generatedAt": _iso(_now()),
    })
    # A sibling whose path merely SHARES A PREFIX with the root. Prefix
    # matching without the separator would wrongly claim these.
    sibling = Path(str(root) + "-sibling")
    sibling.mkdir(parents=True)
    log = json.loads((home / "changes" / "log.json").read_text())
    log["entries"].append(
        {"file": str(sibling / "trap.ts"), "timestamp": _iso(_now()), "kind": "edit"}
    )
    _write(home / "changes" / "log.json", log)

    # ── 10. missions, more than the limit, varied shapes ─────────────
    home, root = scenario("missions", includeGit=False, missionLimit=3)
    _freeze(root)
    _register(home, "p1", root, name="Missions")
    for i in range(6):
        _write(home / "missions" / "p1" / f"m{i}.json", _mission(i))
    # A file that is not a mission, and one that is not JSON: neither may
    # become a mission, and neither may break the read.
    (home / "missions" / "p1" / "notes.txt").write_text("not a mission")
    (home / "missions" / "p1" / "broken.json").write_text("{not json")
    _write(home / "missions" / "p1" / "no-id.json", {"text": "id-less"})

    # ── 10b. a mission record the reference cannot hydrate ───────────
    # `statusForTask` reads `record.taskRuns.find(...)` unguarded, so a
    # record carrying a goal graph but no `taskRuns` array throws inside
    # `MissionStore.list`, and `projectMissions` turns that into
    # `unknown` for the WHOLE project. This scenario pins that behaviour
    # rather than avoiding it — see EXPECTED_DIVERGENCE.
    home, root = scenario("missions-unhydratable", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Unhydratable")
    broken = _mission(0)
    del broken["taskRuns"]
    _write(home / "missions" / "p1" / "m0.json", broken)

    # ── 11. an environment the caller already observed ───────────────
    home, root = scenario("environment", includeGit=False, environment=ENVIRONMENT)
    _freeze(root)
    _register(home, "p1", root, name="Environment")

    # ── 12. an environment object that was never scanned ─────────────
    home, root = scenario("environment-unscanned", includeGit=False,
                          environment={"scannedAt": None, "nodes": [],
                                       "providedCapabilities": []})
    _freeze(root)
    _register(home, "p1", root, name="Unscanned")

    # ── 13. a git snapshot supplied by the caller ────────────────────
    home, root = scenario("git-supplied", git=SUPPLIED_GIT, environment=ENVIRONMENT)
    _freeze(root)
    _register(home, "p1", root, name="Supplied Git")

    # ── 14. a real repository, read live ─────────────────────────────
    home, root = scenario("git-live")
    _git_repo(root, dirty=True)
    _register(home, "p1", root, name="Live Git")

    # ── 15. a directory that is not a repository ─────────────────────
    home, root = scenario("git-absent")
    _freeze(root)
    _register(home, "p1", root, name="No Git")

    # ── 16. a version pointer past the end of the history ────────────
    home, root = scenario("version-out-of-range", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Bad Version")
    _write(home / "versions" / "p1.json",
           {"current": 9, "versions": [{"version": 1, "at": "2026-01-01T00:00:00.000Z"}]})

    # ── 17. corrupt artifacts must not become content ────────────────
    home, root = scenario("corrupt-artifacts", includeGit=False)
    _freeze(root)
    _register(home, "p1", root, name="Corrupt")
    for sub in ("identity", "summaries", "repo-profile", "health", "versions"):
        (home / sub).mkdir(parents=True, exist_ok=True)
        (home / sub / "p1.json").write_text("{ this is not json")
    (home / "changes").mkdir(parents=True, exist_ok=True)
    (home / "changes" / "log.json").write_text("also not json")

    # ── 18. an activity limit of zero ────────────────────────────────
    # `slice(-0)` is the whole array in JavaScript and `[-0:]` is the
    # whole list in Python. A limit of zero must therefore NOT mean
    # "nothing" for activity — while `slice(0, 0)` genuinely does for
    # missions. Two zeros, two different meanings, both pinned here.
    home, root = scenario("zero-limits", includeGit=False,
                          activityLimit=0, missionLimit=0)
    _freeze(root)
    _register(home, "p1", root, name="Zero")
    _write(home / "missions" / "p1" / "m0.json", _mission(0))

    return jobs
