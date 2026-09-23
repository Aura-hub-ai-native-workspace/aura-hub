"""Capability registry — ONE measured view of what this machine can do.

The registry unites three things that already exist but never met:

- the environment catalog + probes (what is installed, measured),
- connected worker/node records (what AURA proved it can drive),
- the curated tool table (what each tool may do, and at what risk).

It adds no new probing machinery and no execution path: measurement
comes from ``environment.probe`` (injectable), authority stays with
the Fabric, and planning reads this instead of guessing. The cache is
memory-only with a TTL — a stale answer is never persisted as truth,
and ``refresh()`` re-measures on demand.

Fail-closed throughout: unknown capabilities, unknown actions, and
unmeasured tools resolve to ``unavailable`` with a reason, never to a
guessed command.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from .model import (
    Availability,
    Capability,
    CapabilityAction,
    Health,
    Resolution,
)
from .tools import (
    CAPABILITY_MACHINE_NEEDS,
    ROLE_TOOL_NEEDS,
    tool_spec,
)


def _default_scan():
    from ..environment.probe import scan_environment

    return scan_environment()


def _default_probe(node_id: str, refresh: bool = False):
    from ..environment.probe import probe_node

    return probe_node(node_id, refresh=refresh)


def _status_name(status: Any) -> str:
    """ProbeStatus is a str-Enum: ``str()`` yields 'ProbeStatus.VERIFIED',
    so read ``.value`` first. Anything else stringifies as-is."""
    value = getattr(status, "value", None)
    if isinstance(value, str):
        return value
    return str(status) if status is not None else "unsupported"


def _status_to_state(status: str, present: bool) -> tuple[Availability, Health, str]:
    """ProbeStatus → (availability, health). Timeouts never disprove
    presence; blocked/tampered tools are unusable and say so."""
    if status == "verified":
        return ("available", "healthy", "")
    if status == "internal":
        return ("available", "healthy", "Built into AURA Hub.")
    if status == "unverified":
        return ("available", "unchecked", "Ran, but reported no readable version.")
    if status == "timeout":
        return ("unknown", "unknown", "Version check timed out; presence unknown, not disproved.")
    if status == "not-found":
        return ("unavailable", "unknown", "No such executable on the effective PATH.")
    if status == "failed":
        return ("unavailable", "unknown", "The executable ran but its version check failed.")
    if status == "blocked":
        return ("unavailable", "unknown", "Found in a location AURA will not execute from.")
    if status == "tampered":
        return ("unavailable", "unknown", "Changed between vetting and execution; nothing ran.")
    if status == "needs-auth":
        return ("unavailable", "unknown", "Reachable only with operator credentials.")
    if status == "unsupported":
        return ("unknown", "unknown", "No dependable cross-platform detector.")
    return ("unknown", "unknown", f"Unrecognised probe status {status!r}.")


class CapabilityRegistry:
    """Measured machine capabilities with a bounded memory cache.

    All machine access flows through the injected callables, which is
    what makes this testable without touching the real machine: tests
    hand it fixture scan/probe functions, production hands it the real
    ones. The registry itself never spawns anything except through
    those callables (plus one bounded daemon check, same safety class
    as a version probe).
    """

    def __init__(
        self,
        scan_fn: Callable[[], Any] | None = None,
        probe_fn: Callable[[str, bool], Any] | None = None,
        connected_fn: Callable[[], set[str]] | None = None,
        clock: Callable[[], float] | None = None,
        ttl_s: float = 300.0,
        emit: Callable[[dict], None] | None = None,
    ) -> None:
        self._scan_fn = scan_fn or _default_scan
        self._probe_fn = probe_fn or _default_probe
        self._connected_fn = connected_fn or (lambda: set())
        self._clock = clock or time.monotonic
        self._ttl = ttl_s
        self._emit = emit
        self._built_at: float | None = None
        self._capabilities: list[Capability] = []

    # ── discovery ────────────────────────────────────────────────

    def discover(self, refresh: bool = False) -> list[Capability]:
        """The measured capabilities, cached for ``ttl_s``. ``refresh``
        re-measures now. Returns copies — callers never mutate the cache."""
        now = self._clock()
        if (not refresh and self._built_at is not None
                and now - self._built_at < self._ttl):
            return [c.model_copy(deep=True) for c in self._capabilities]
        scan = None
        try:
            scan = self._scan_fn()
        except Exception:
            scan = None
        try:
            connected = set(self._connected_fn() or set())
        except Exception:
            connected = set()
        results = getattr(scan, "results", None) or {}
        built: list[Capability] = []
        for cap_id in sorted(tool_spec_ids()):
            try:
                built.append(self._build_one(cap_id, results, connected))
            except Exception as exc:
                built.append(Capability(
                    id=cap_id, name=cap_id, availability="unknown",
                    health="unknown",
                    reason=f"Registry failed to build this entry: {exc!r}"[:200]))
        self._capabilities = built
        self._built_at = now
        if self._emit is not None:
            try:
                self._emit({"type": "capability.refresh.completed",
                            "capabilities": len(built),
                            "available": sum(1 for c in built
                                             if c.availability == "available"),
                            "fresh": True})
            except Exception:
                pass
        return [c.model_copy(deep=True) for c in built]

    def refresh(self) -> list[Capability]:
        """Re-measure now, bypassing the cache."""
        return self.discover(refresh=True)

    def _build_one(self, cap_id: str, results: dict, connected: set[str]) -> Capability:
        from .tools import TOOL_SPECS

        spec = TOOL_SPECS[cap_id]
        best: Any = None
        best_node = ""
        for node_id in spec["nodes"]:
            result = results.get(node_id)
            if result is None:
                try:
                    result = self._probe_fn(node_id, False)
                except Exception:
                    continue
            if result is None:
                continue
            status = _status_name(getattr(result, "status", "unsupported"))
            present = bool(getattr(result, "present", False))
            rank = {"verified": 0, "internal": 0, "unverified": 1}.get(status, 2)
            if best is None or rank < best[0]:
                best = (rank, result, node_id)
            if rank == 0:
                break
        actions = [CapabilityAction.model_validate(a) for a in spec["actions"]]
        if best is None:
            return Capability(
                id=cap_id, name=spec["name"], category=spec["category"],
                description=spec.get("description", ""),
                availability="unknown", health="unknown",
                reason="No measurement for any candidate detector.",
                actions=actions, requirements=list(spec.get("requirements", [])),
                install_hint=spec.get("install_hint"))
        _, result, node_id = best
        status = _status_name(getattr(result, "status", "unsupported"))
        present = bool(getattr(result, "present", False))
        availability, health, reason = _status_to_state(status, present)
        detail = str(getattr(result, "detail", "") or "")
        if detail and availability != "available":
            reason = f"{reason} {detail}"[:300] if reason else detail[:300]
        version = getattr(result, "version", None)
        version = str(version)[:64] if version else None
        exe_path = getattr(result, "executable", None)
        exe_path = str(exe_path)[:512] if exe_path else None
        exe_name = node_id_to_command(node_id, spec)
        metadata: dict[str, Any] = {"detector_node": node_id,
                                    "probe_status": status}
        if node_id in connected or cap_id in connected:
            metadata["connected"] = True
        # Service requirements: only the ones the registry knows how
        # to check are evaluated; the rest ride along unevaluated.
        req_status: dict[str, str] = {}
        for req in spec.get("requirements", []):
            req_status[req] = self._check_requirement(req, exe_path)
        if req_status:
            metadata["requirements"] = req_status
            if any(v == "unreachable" for v in req_status.values()):
                if availability == "available":
                    health = "unreachable"
                    reason = ("The executable is present but its service is "
                              "unreachable.") if not reason else reason
        return Capability(
            id=cap_id, name=spec["name"], category=spec["category"],
            description=spec.get("description", ""),
            executable=exe_name, executable_path=exe_path, version=version,
            availability=availability, health=health, reason=reason,
            actions=actions, requirements=list(spec.get("requirements", [])),
            install_hint=spec.get("install_hint"), metadata=metadata)

    def _check_requirement(self, requirement: str, exe_path: str | None) -> str:
        """Evaluate one service requirement. Returns ok/unreachable/
        unevaluated — never satisfied-by-default."""
        if requirement == "docker-daemon":
            if not exe_path:
                return "unevaluated"
            try:
                from ..environment.procexec import run_argv

                out = run_argv([exe_path, "info", "--format", "{{.ServerVersion}}"],
                               timeout_ms=5_000)
                if out.exit_code == 0 and (out.stdout or "").strip():
                    return "ok"
                return "unreachable"
            except Exception:
                return "unreachable"
        if requirement == "browser":
            try:
                sibling = self._build_one("chromium", {}, set())
                return "ok" if sibling.availability == "available" else "unreachable"
            except Exception:
                return "unevaluated"
        if requirement == "ollama-endpoint":
            # The ollama catalog node IS an endpoint liveness probe, so a
            # verified measurement already means the endpoint answered.
            return "unevaluated-endpoint-probe"
        return "unevaluated"

    # ── reads ────────────────────────────────────────────────────

    def _ensure(self) -> list[Capability]:
        if self._built_at is None:
            return self.discover()
        return self._capabilities

    def get(self, capability_id: str) -> Capability | None:
        """Full measured entry, or None for an id the table never knew.
        None is not failure — callers treat it as unknown and fail closed."""
        if not isinstance(capability_id, str):
            return None
        for cap in self._ensure():
            if cap.id == capability_id:
                return cap.model_copy(deep=True)
        return None

    def has(self, capability_id: str) -> bool:
        cap = self.get(capability_id)
        return cap is not None and cap.availability == "available"

    def find_by_category(self, category: str) -> list[Capability]:
        return [c.model_copy(deep=True) for c in self._ensure()
                if c.category == category]

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        """Targeted capability lookup for planning prompts. Bounded,
        slim (no absolute paths), and structured — never an inventory
        dump. Empty query matches nothing: a question is required."""
        words = [w.lower() for w in str(query or "").split() if len(w) > 1]
        if not words:
            return []
        scored: list[tuple[int, Capability]] = []
        for cap in self._ensure():
            score = 0
            name = cap.name.lower()
            desc = cap.description.lower()
            for w in words:
                if w == cap.id.lower():
                    score += 3
                if w in name:
                    score += 2
                if w in desc:
                    score += 1
                if w in cap.category:
                    score += 1
                for action in cap.actions:
                    if w in action.name.lower().replace("-", " "):
                        score += 1
                        break
            if score > 0:
                scored.append((score, cap))
        scored.sort(key=lambda row: (-row[0], row[1].id))
        out = []
        for _, cap in scored[:max(1, limit)]:
            out.append({
                "id": cap.id, "name": cap.name, "category": cap.category,
                "description": cap.description,
                "availability": cap.availability, "health": cap.health,
                "version": cap.version,
                "actions": [a.name for a in cap.actions],
            })
        return out

    def get_available_actions(self, capability_id: str) -> list[dict[str, Any]]:
        """The action table for one capability, or [] when unknown or
        unmeasured. Planning metadata, not an execution grant."""
        cap = self.get(capability_id)
        if cap is None or cap.availability != "available":
            return []
        return [{"name": a.name, "description": a.description,
                 "risk": a.risk, "requires_approval": a.requires_approval}
                for a in cap.actions]

    def resolve(self, capability_id: str, action_name: str) -> Resolution:
        """Which actual executable performs (capability, action)?

        Returns a measured path plus the action's FIXED argv template
        with ``{exe}`` substituted — or ``ok=False`` with the reason.
        Unknown ids, unknown actions, unavailable tools, and actions
        without a fixed template all refuse. Nothing here composes a
        command from caller input, and nothing here executes.
        """
        if not isinstance(capability_id, str) or not isinstance(action_name, str):
            return Resolution(ok=False, capability_id=str(capability_id),
                              action=str(action_name),
                              reason="Capability and action must name strings.")
        cap = self.get(capability_id)
        if cap is None:
            return Resolution(ok=False, capability_id=capability_id,
                              action=action_name,
                              reason=f"Unknown capability {capability_id!r}.")
        action = next((a for a in cap.actions if a.name == action_name), None)
        if action is None:
            return Resolution(ok=False, capability_id=capability_id,
                              action=action_name,
                              reason=f"Unknown action {action_name!r} for {capability_id!r}.")
        if cap.availability != "available" or not cap.executable_path:
            return Resolution(
                ok=False, capability_id=capability_id, action=action_name,
                reason=(cap.reason or f"{capability_id!r} is not available."))
        argv = _fixed_argv(action.argv)
        if argv is None:
            return Resolution(
                ok=False, capability_id=capability_id, action=action_name,
                reason=(f"Action {action_name!r} has no fixed command template; "
                        "its operands are composed by the governed executor."))
        resolved = [cap.executable_path if part == "{exe}" else part for part in argv]
        return Resolution(ok=True, capability_id=capability_id,
                          action=action_name, executable_path=cap.executable_path,
                          argv=resolved, version=cap.version, risk=action.risk)

    def health_check(self, capability_id: str) -> Capability | None:
        """Re-measure ONE capability now (bounded single probe, not a
        full scan) and update the cached entry. Unknown ids → None."""
        from .tools import TOOL_SPECS

        spec = TOOL_SPECS.get(capability_id)
        if spec is None:
            return None
        try:
            connected = set(self._connected_fn() or set())
        except Exception:
            connected = set()
        fresh = self._build_one(capability_id, {}, connected)
        self._ensure()
        for i, cap in enumerate(self._capabilities):
            if cap.id == capability_id:
                self._capabilities[i] = fresh
                break
        else:
            self._capabilities.append(fresh)
        return fresh.model_copy(deep=True)

    def machine_needs(self, capability_id: str) -> list[str]:
        """Machine capabilities a governed capability needs beneath it."""
        return list(CAPABILITY_MACHINE_NEEDS.get(capability_id, []))

    def unmet_tool_needs(self, role: str) -> list[str]:
        """Machine capabilities a worker role wants but the machine
        lacks. Reporting only — dispatch authority stays where it is."""
        needs = ROLE_TOOL_NEEDS.get(role)
        if not needs:
            return []
        return [need for need in needs if not self.has(need)]

    def summary(self, max_items: int = 10) -> list[str]:
        """Bounded machine lines for planning prompts. Versions and
        states only — no paths, no environment, no secrets, ever."""
        lines: list[str] = []
        for cap in self._ensure()[:max(1, max_items)]:
            if cap.availability == "available":
                bit = f"{cap.name} {cap.version or ''}".strip()
                if cap.health not in ("healthy", "unchecked"):
                    bit += f" ({cap.health})"
                lines.append(f"{bit}: available")
            elif cap.availability == "unavailable":
                lines.append(f"{cap.name}: unavailable ({cap.reason[:100]})".rstrip())
            else:
                lines.append(f"{cap.name}: unknown ({cap.reason[:100]})".rstrip())
        return [line[:160] for line in lines]


def tool_spec_ids() -> list[str]:
    from .tools import TOOL_SPECS

    return sorted(TOOL_SPECS)


def node_id_to_command(node_id: str, spec: dict) -> str | None:
    """Bare executable name for display. The measured PATH lives on
    the Capability; this is only the human-readable command word."""
    _ = spec
    return node_id.split("/")[-1] or None


def _fixed_argv(template: list[str]) -> list[str] | None:
    """A template is resolvable only when it is exactly [{exe}, *consts]
    with no other placeholders. Anything else is planning metadata."""
    if not template or template[0] != "{exe}":
        return None
    for part in template[1:]:
        if not isinstance(part, str) or "{" in part or "}" in part:
            return None
    return list(template)
