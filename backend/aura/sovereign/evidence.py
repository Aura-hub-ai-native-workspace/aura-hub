"""Evidence freshness: one place that decides whether an observation still counts.

Two independent kinds of evidence are tracked for each registry record:

  reachability   a health probe of the endpoint (GET /api/tags)
  metadata       a server-reported description of a model (POST /api/show)

Each has its own last-success and last-failure time. The state is derived from those times
at read time, so nothing is "fresh" because it was once true:

  unknown   never observed
  fresh     the last success is within its TTL, and no later failure exists
  stale     the last success is older than its TTL, and no later failure exists
  failed    the most recent attempt failed. An older success never overrides a newer failure.

Discovery and name hints are not reachability or metadata evidence at all. A failed refresh
therefore cannot leave an old success looking fresh: the newer failure wins.

The TTLs are starting values, not measured requirements. They live here so that they are
tuned in one place.
"""

from __future__ import annotations

from dataclasses import dataclass

FRESH = "fresh"
STALE = "stale"
FAILED = "failed"
UNKNOWN = "unknown"
STATES = (FRESH, STALE, FAILED, UNKNOWN)


@dataclass(frozen=True)
class FreshnessPolicy:
    """Initial values, centralised. Changing one changes every consumer."""

    reachability_ttl_s: float = 90.0
    metadata_ttl_s: float = 600.0
    #: Bounds for an on-demand refresh. Conservative defaults.
    probe_timeout_s: float = 3.0
    metadata_timeout_s: float = 3.0
    max_concurrent_refreshes: int = 2
    acquire_wait_s: float = 5.0
    backoff_base_s: float = 30.0
    backoff_max_s: float = 600.0


DEFAULT_POLICY = FreshnessPolicy()


def classify(last_success: float | None, last_failure: float | None,
             now: float, ttl_s: float) -> str:
    """Freshness state from the two times. All times are on the same monotonic clock."""
    if last_success is None and last_failure is None:
        return UNKNOWN
    if last_failure is not None and (last_success is None or last_failure >= last_success):
        return FAILED
    return FRESH if (now - last_success) <= ttl_s else STALE


def probe_times(record) -> tuple[float | None, float | None, str]:
    """(last successful probe, last failed probe, failure category) for a record.

    Falls back to the legacy ``healthy``/``last_checked`` pair for records that were made
    before the explicit fields existed, so older registries keep their meaning.
    """
    success = getattr(record, "probe_success_at", None)
    failure = getattr(record, "probe_failure_at", None)
    category = getattr(record, "probe_failure_category", "") or ""
    if success is None and failure is None and record.last_checked:
        if record.healthy is True:
            success = record.last_checked
        elif record.healthy is False:
            failure = record.last_checked
            category = category or getattr(record, "last_error_category", "") or "probe-failed"
    return success, failure, category


def metadata_times(record) -> tuple[float | None, float | None, str]:
    """(last successful metadata read, last failed read, failure category) for a record."""
    success = getattr(record, "metadata_success_at", None)
    failure = getattr(record, "metadata_failure_at", None)
    category = getattr(record, "metadata_failure_category", "") or ""
    if success is None and failure is None and record.metadata_checked:
        success = record.metadata_checked
    return success, failure, category


def age(at: float | None, now: float) -> float | None:
    """Seconds since ``at``, rounded, or None when there was never such an observation."""
    if at is None:
        return None
    return round(max(0.0, now - at), 3)
