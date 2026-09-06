"""Worker supervision helpers — deterministic boundaries, no planning.

The supervisor enforces what can be decided WITHOUT model judgment:

- scope paths must be well-formed before anything runs;
- after a worker runs, the changed files (via `git status`) must fall
  inside the declared scope, or the run is reported as a scope
  deviation — stopped and parked, never silently accepted, never
  silently reverted.

Interpretation of a deviation (what it means, what to do next) belongs
to the Central Agent behind an approval; enforcement belongs here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

MAX_SCOPE_PATHS = 32
MAX_SCOPE_PATH_CHARS = 256


def _normalize_scope_path(raw: object) -> str | None:
    """Return the canonical form of one scope entry, or None if invalid.

    Canonical form: forward slashes, no leading/trailing slashes, no
    trailing glob (`/**` or `/*` are accepted as spelling and stripped —
    a scope is always a directory subtree or a single file).
    """
    if not isinstance(raw, str):
        return None
    if "\\" in raw:
        # Never silently rewrite separators: a scope entry must already be
        # repo-relative with forward slashes (git reports them that way).
        return None
    text = raw.strip()
    while text.startswith("/"):
        # Absolute paths are refused below; strip nothing silently — but a
        # single leading slash is almost always a typo for a repo-relative
        # path, and refusing it outright would be noise. The absolute check
        # below still rejects anything that escapes via `..`.
        text = text[1:]
        break
    if not text or len(text) > MAX_SCOPE_PATH_CHARS:
        return None
    if text.endswith("/**"):
        text = text[: -len("/**")]
    elif text.endswith("/*"):
        text = text[: -len("/*")]
    text = text.strip("/")
    if not text:
        return None
    parts = text.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    if any("\\" in p for p in parts):
        return None
    return text


def validate_scope_paths(raw: object) -> tuple[bool, list[str], str]:
    """Validate a contract's scopePaths value.

    Returns (ok, canonical_paths, reason). Absent (None) means "no scope
    contract was given" and is valid — the caller simply skips
    scope verification. Anything present-but-malformed is a refusal.
    """
    if raw is None:
        return True, [], ""
    if not isinstance(raw, list):
        return False, [], "scopePaths must be a list of repo-relative paths."
    if len(raw) > MAX_SCOPE_PATHS:
        return False, [], (
            f"scopePaths lists {len(raw)} paths; at most {MAX_SCOPE_PATHS} "
            "are allowed."
        )
    canonical: list[str] = []
    for entry in raw:
        norm = _normalize_scope_path(entry)
        if norm is None:
            return False, [], (
                "scopePaths must be repo-relative paths without '.', '..', "
                "backslashes or empties; "
                f"rejected {str(entry)[:80]!r}."
            )
        if norm not in canonical:
            canonical.append(norm)
    if not canonical:
        return False, [], "scopePaths is empty; omit it instead."
    return True, canonical, ""


def _in_scope(path: str, scope: list[str]) -> bool:
    """True when a repo-relative file path falls inside any scope entry.

    A scope entry covers itself (single file) and everything beneath it
    (directory subtree), on `/` boundaries only — `src/auth` never covers
    `src/authx`.
    """
    for prefix in scope:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


@dataclass
class ScopeCheck:
    """Outcome of comparing changed files against a scope contract."""

    supported: bool = True
    allowed: bool = True
    changed: list[str] = field(default_factory=list)
    outside: list[str] = field(default_factory=list)
    detail: str = ""


def parse_porcelain_status(output: str) -> list[str]:
    """Repo-relative changed paths from `git status --porcelain=v1 -z`.

    Covers staged, unstaged and untracked entries, including renames
    (the post-rename path is what matters). NUL-separated; falls back to
    newline splitting for tolerant parsing. Quoted paths (core.quotepath)
    are unquoted when possible.
    """
    paths: list[str] = []
    if "\x00" in output:
        chunks = output.split("\x00")
    else:
        chunks = output.splitlines()
    i = 0
    while i < len(chunks):
        # Do NOT strip the chunk first: the two-character XY status field
        # is positionally significant, and stripping a leading space would
        # shift the path slice by one (e.g. " M src/a.py" -> "rc/a.py").
        chunk = chunks[i].rstrip("\r\n")
        i += 1
        if len(chunk) < 4:
            continue
        entry = chunk[3:].strip()
        if not entry:
            continue
        # Rename/copy entries: "R  old -> new".
        if " -> " in entry:
            entry = entry.split(" -> ", 1)[1].strip()
        entry = entry.strip().strip('"')
        if entry:
            paths.append(entry)
    # De-duplicate, keep order.
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def check_scope_paths(changed: list[str], scope: list[str]) -> ScopeCheck:
    """Partition already-known changed paths against a scope contract."""
    outside = [p for p in changed if not _in_scope(p, scope)]
    if outside:
        shown = ", ".join(outside[:8])
        more = f" (+{len(outside) - 8} more)" if len(outside) > 8 else ""
        return ScopeCheck(
            supported=True,
            allowed=False,
            changed=list(changed),
            outside=outside,
            detail=f"{len(outside)} changed file(s) fall outside the declared scope: {shown}{more}.",
        )
    return ScopeCheck(
        supported=True,
        allowed=True,
        changed=list(changed),
        outside=[],
        detail=f"All {len(changed)} changed file(s) fall inside the declared scope.",
    )


async def check_worker_scope(cwd: str, scope: list[str],
                             timeout_ms: int | None = None) -> ScopeCheck:
    """Run `git status` in the worker cwd and check it against the scope.

    Non-git directories are NOT failures: scope cannot be evidenced there,
    so the check reports supported=False and the caller records that
    honestly instead of claiming verification it never performed.

    Note: this compares the WHOLE tree. For sequential legs in one
    repository (multi-worker workflows), prefer snapshot/delta below so
    earlier legs' uncommitted work does not pollute later checks.
    """
    from ..exec_ import git as run_git

    try:
        res = await run_git(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            cwd, timeout_ms)
    except Exception as exc:  # noqa: BLE001 — git missing is an answer, not a crash
        return ScopeCheck(
            supported=False, allowed=True, changed=[], outside=[],
            detail=f"Scope could not be evidenced here: {exc}")
    if res.code != 0:
        # Not a repository (or git cannot read it): same honest answer.
        return ScopeCheck(
            supported=False, allowed=True, changed=[], outside=[],
            detail="Scope could not be evidenced here: not a git working tree.")
    changed = parse_porcelain_status(res.out)
    return check_scope_paths(changed, scope)


#: Snapshot cap: repositories dirtier than this at task start grandfather
#: their pre-existing paths (documented in the check detail) rather than
#: paying unbounded hashing. Pathological dirt is itself evidence.
SNAPSHOT_PATH_CAP = 1000


@dataclass
class WorktreeSnapshot:
    """Content hashes of dirty paths at task start, for delta checks."""

    hashes: dict[str, str] = field(default_factory=dict)
    capped: bool = False


def _safe_join(cwd: str, rel: str) -> str | None:
    """Join a status-reported path under cwd, refusing escapes.

    `git status` paths are repo-relative by construction, but the delta
    feeds them to the filesystem — so confinement is checked, not assumed.
    """
    import os

    if not rel or rel.startswith("/") or "\x00" in rel:
        return None
    joined = os.path.realpath(os.path.join(cwd, rel))
    root = os.path.realpath(cwd)
    if joined != root and not joined.startswith(root + os.sep):
        return None
    return joined


async def snapshot_worktree(cwd: str,
                            timeout_ms: int | None = None) -> WorktreeSnapshot | None:
    """Hash every dirty path in the working tree. None if not a git repo.

    Only paths that exist on disk are hashed (one batched call — a single
    missing file must not poison the whole batch). Missing-at-snapshot
    paths stay absent from hashes and therefore count as changed in the
    delta (fail-closed toward verification).
    """
    import os

    from ..exec_ import git as run_git

    try:
        res = await run_git(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            cwd, timeout_ms)
    except Exception:  # noqa: BLE001
        return None
    if res.code != 0:
        return None
    paths = [p for p in parse_porcelain_status(res.out) if "\n" not in p]
    snapshot = WorktreeSnapshot()
    if len(paths) > SNAPSHOT_PATH_CAP:
        snapshot.capped = True
        return snapshot
    existing = [p for p in paths
                if _safe_join(cwd, p) is not None
                and os.path.lexists(os.path.join(cwd, p))]
    if not existing:
        return snapshot
    try:
        out = await run_git(["hash-object", "--"] + existing, cwd, timeout_ms)
    except Exception:  # noqa: BLE001
        return snapshot
    if out.code != 0:
        return snapshot
    for path, digest in zip(existing, out.out.split()):
        snapshot.hashes[path] = digest
    # Paths git could not hash stay absent from hashes and therefore count
    # as changed in the delta.
    return snapshot


async def hash_paths(cwd: str, paths: list[str],
                     timeout_ms: int | None = None) -> dict[str, str]:
    """Content hashes for repo-relative paths, one batched git call.

    Missing or escaping paths are skipped (the delta counts them as
    changed) so one bad entry cannot poison the batch.
    """
    import os

    from ..exec_ import git as run_git

    clean = [p for p in paths
             if "\n" not in p
             and _safe_join(cwd, p) is not None
             and os.path.lexists(os.path.join(cwd, p))]
    if not clean:
        return {}
    try:
        out = await run_git(["hash-object", "--"] + clean, cwd, timeout_ms)
    except Exception:  # noqa: BLE001
        return {}
    if out.code != 0:
        return {}
    return {p: h for p, h in zip(clean, out.out.split())}


def delta_since(before: WorktreeSnapshot,
                after_changed: list[str],
                after_hashes: dict[str, str]) -> list[str]:
    """Paths the worker itself dirtied since the snapshot.

    - Absent from the snapshot → new dirt (or unhashable at snapshot
      time): counted, unless the snapshot hit its cap, in which case
      unknown paths could pre-date the task and are grandfathered
      (documented in the check detail by the caller).
    - Present with a different hash afterwards (or unhashable now) →
      the worker touched it: counted.
    - Present with the same hash → grandfathered (an earlier leg).
    - Newline-bearing paths can never be hashed: counted (fail-closed).
    """
    delta: list[str] = []
    for path in after_changed:
        if "\n" in path:
            delta.append(path)
            continue
        if path not in before.hashes:
            if not before.capped:
                delta.append(path)
            continue
        if after_hashes.get(path) != before.hashes[path]:
            delta.append(path)
    return delta
