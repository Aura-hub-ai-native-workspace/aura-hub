"""On-demand, bounded refresh of reachability and metadata evidence.

This is the only code that performs a probe or a metadata read after startup. It runs only
when a caller asks for it. There is no background polling, and nothing runs at import.

Guarantees:
  * Only records already in the registry are refreshed. Discovery is the only path that adds
    a record, and discovery is driven by configuration. A refresh never adds an endpoint.
  * Only local and private endpoints are contacted. A cloud record is refused.
  * Concurrent requests for one endpoint share one probe. The others wait for its result,
    bounded by the policy, and never probe the same endpoint again.
  * At most ``max_concurrent_refreshes`` probes run at once. A caller that cannot get a slot
    within ``acquire_wait_s`` is told so, and nothing is probed on its behalf.
  * After a failed probe, that endpoint is not probed again until a backoff passes. The
    backoff doubles each failure, up to a cap. Any success clears it.
  * A failure is recorded as a failure. It is never recorded as a success, and an older
    success does not hide it.
  * Results carry stable categories and freshness states. They never carry an address, a
    header, a key, or the text of an exception.
"""

from __future__ import annotations

import threading
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable

from aura.agent_runtime.model_metadata import fetch_ollama_metadata
from aura.sovereign.evidence import (
    DEFAULT_POLICY,
    FreshnessPolicy,
    classify,
    metadata_times,
    probe_times,
)
from aura.sovereign.model_registry import (
    _infer_capabilities,
    probe_error_category,
    reconcile_capabilities,
    verified_absent_tags,
)

REFRESH_AUTHORISED_CLASSES = frozenset({"local", "private"})

# Outcomes of one refresh request.
REFRESHED = "refreshed"            # probe succeeded
PROBE_FAILED = "probe-failed"      # probe failed; failure recorded
BACKOFF = "backoff"                # not probed: an earlier failure is still backing off
BUSY = "busy"                      # no concurrency slot within the wait bound
COALESCED = "coalesced"            # shared a probe already in flight for this endpoint
NOT_REGISTERED = "not-registered"  # the record is not in the registry; nothing was probed
REFUSED = "refused"                # the endpoint's class is not authorised for refresh


@dataclass(frozen=True)
class RefreshResult:
    endpoint_id: str
    model_name: str
    outcome: str
    reachability: str        # fresh | stale | failed | unknown, after this request
    metadata: str            # fresh | stale | failed | unknown, after this request
    category: str = ""       # a stable failure category, or ""


def _default_probe(base_url: str, timeout_s: float) -> tuple[bool, str]:
    """GET /api/tags on the server root. Returns (ok, category). Never returns exception text."""
    try:
        req = urllib.request.Request(base_url + "/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=timeout_s):
            pass
        return True, ""
    except Exception as exc:  # noqa: BLE001
        return False, probe_error_category(exc)


class EvidenceRefresher:
    def __init__(self, registry, policy: FreshnessPolicy = DEFAULT_POLICY, *,
                 probe: Callable[[str, float], tuple[bool, str]] | None = None,
                 metadata: Callable | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time) -> None:
        self._registry = registry
        self._policy = policy
        self._probe = probe or _default_probe
        self._metadata = metadata or fetch_ollama_metadata
        self._clock = clock
        self._wall = wall
        self._slots = threading.BoundedSemaphore(policy.max_concurrent_refreshes)
        self._lock = threading.Lock()
        self._inflight: dict[str, threading.Event] = {}
        self._shared: dict[str, RefreshResult] = {}
        self._failures: dict[str, int] = {}
        self._retry_at: dict[str, float] = {}

    # ── public ──────────────────────────────────────────────────────────

    def refresh(self, record, *, want_metadata: bool = True) -> RefreshResult:
        endpoint = record.endpoint_id
        if self._registry._records.get(record.id) is not record:
            return self._result(record, NOT_REGISTERED, "not-registered")
        if record.network_class not in REFRESH_AUTHORISED_CLASSES:
            return self._result(record, REFUSED, "network-class-not-authorised")

        with self._lock:
            event = self._inflight.get(endpoint)
            if event is None:
                retry_at = self._retry_at.get(endpoint)
                if retry_at is not None and self._clock() < retry_at:
                    return self._result(record, BACKOFF, "backing-off")
                event = threading.Event()
                self._inflight[endpoint] = event
                owner = True
            else:
                owner = False

        if not owner:
            bound = self._policy.probe_timeout_s * 2 + self._policy.acquire_wait_s
            event.wait(timeout=bound)
            with self._lock:
                shared = self._shared.get(endpoint)
            if shared is not None:
                return RefreshResult(shared.endpoint_id, record.model_name, COALESCED,
                                     *self._states(record), category=shared.category)
            return self._result(record, COALESCED, "shared-probe-did-not-finish")

        outcome: RefreshResult | None = None
        try:
            if not self._slots.acquire(timeout=self._policy.acquire_wait_s):
                outcome = self._result(record, BUSY, "no-refresh-slot-available")
                return outcome
            try:
                outcome = self._do_refresh(record, want_metadata)
            finally:
                self._slots.release()
            return outcome
        finally:
            # Waiting callers always receive a definite result, even if the probe raised.
            with self._lock:
                self._shared[endpoint] = outcome if outcome is not None else \
                    self._result(record, PROBE_FAILED, "internal-error")
                self._inflight.pop(endpoint, None)
            event.set()

    # ── internals ───────────────────────────────────────────────────────

    def _do_refresh(self, record, want_metadata: bool) -> RefreshResult:
        now = self._clock()
        ok, category = self._probe(record.base_url, self._policy.probe_timeout_s)
        if ok:
            record.healthy = True
            record.probe_success_at = now
            record.probe_success_wall = self._wall()
            record.probe_failure_at = None
            record.probe_failure_category = ""
            record.last_checked = now
            record.last_error = ""
            record.last_error_category = ""
            self._clear_backoff(record.endpoint_id)
            if want_metadata:
                self._refresh_metadata(record, now)
            return self._result(record, REFRESHED, "")

        record.healthy = False
        record.probe_failure_at = now
        record.probe_failure_category = category or "probe-failed"
        record.last_error = record.probe_failure_category
        record.last_error_category = record.probe_failure_category
        record.last_checked = now
        self._schedule_backoff(record.endpoint_id, now)
        return self._result(record, PROBE_FAILED, record.probe_failure_category)

    def _refresh_metadata(self, record, now: float) -> None:
        meta = self._metadata(record.base_url, record.model_name,
                              timeout_s=self._policy.metadata_timeout_s)
        if meta.status not in ("verified", "empty"):
            record.metadata_failure_at = now
            record.metadata_failure_category = meta.status
            return
        if meta.status == "verified":
            hints = _infer_capabilities(record.model_name, 0)
            tags, sources, context = reconcile_capabilities(hints, meta)
            record.capabilities = tags
            record.capability_sources = sources
            record.context_length = context
            record.verified_absent = verified_absent_tags(meta)
        record.metadata_success_at = now
        record.metadata_checked = now
        record.metadata_failure_at = None
        record.metadata_failure_category = ""

    def _schedule_backoff(self, endpoint: str, now: float) -> None:
        with self._lock:
            count = self._failures.get(endpoint, 0) + 1
            self._failures[endpoint] = count
            delay = min(self._policy.backoff_base_s * (2 ** (count - 1)),
                        self._policy.backoff_max_s)
            self._retry_at[endpoint] = now + delay

    def _clear_backoff(self, endpoint: str) -> None:
        with self._lock:
            self._failures.pop(endpoint, None)
            self._retry_at.pop(endpoint, None)

    def _states(self, record) -> tuple[str, str]:
        now = self._clock()
        p_ok, p_fail, _ = probe_times(record)
        m_ok, m_fail, _ = metadata_times(record)
        return (classify(p_ok, p_fail, now, self._policy.reachability_ttl_s),
                classify(m_ok, m_fail, now, self._policy.metadata_ttl_s))

    def _result(self, record, outcome: str, category: str) -> RefreshResult:
        reach, meta = self._states(record)
        return RefreshResult(record.endpoint_id, record.model_name, outcome, reach, meta, category)
