"""The one staleness rule.

A port of `isCacheStale` in packages/ai-service/src/intelligence/index.ts.

Exported and shared deliberately: the Context Fabric grades every cached
artifact with the SAME rule the intelligence engine uses to decide
whether to regenerate it. If the two ever disagreed, the Fabric could
call something fresh that the engine was about to throw away.
"""

from __future__ import annotations

from datetime import datetime

from ..core.node_time import mtime_ms

# An artifact older than an hour is stale regardless of the filesystem.
DEFAULT_MAX_AGE_MS = 3_600_000


def parse_iso_ms(value: str) -> float | None:
    """`new Date(x).getTime()`, returning None for what JS calls NaN."""
    try:
        return datetime.fromisoformat(value).timestamp() * 1000
    except (ValueError, AttributeError):
        return None


def is_cache_stale(
    generated_at: str, project_root: str, max_age_ms: int = DEFAULT_MAX_AGE_MS
) -> bool:
    generated = parse_iso_ms(generated_at)
    if generated is None:
        # `NaN` comparisons are false in JavaScript, so an unparseable
        # timestamp falls through to the mtime check there too.
        generated = float("nan")

    import time

    now = time.time() * 1000
    if now - generated > max_age_ms:
        return True

    try:
        # Node reports `mtimeMs` from nanoseconds; matching that keeps the
        # comparison against `generated` on the same footing.
        if mtime_ms(project_root) > generated:
            return True
    except OSError:
        pass
    return False


def project_root_mtime_ms(project_root: str) -> float | None:
    try:
        return mtime_ms(project_root)
    except OSError:
        return None
