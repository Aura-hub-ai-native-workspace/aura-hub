"""Task-aware Model Router — map task type to a capable private model.

AURA's sovereign runtime must select the right private model for each task
without sending the task to a cloud API.  This module provides:

  TaskClassifier  — identify what kind of task AURA needs to perform
  ModelRouter     — given task type + registry, select the best model record

The router NEVER selects a cloud endpoint.  If no suitable private model is
available it returns None and the caller is responsible for producing an
honest "no permitted model available" error — never a silent fallback.

Task types (open vocabulary — extensible without touching the registry):
  "planning"      — produce a structured plan from intent
  "coding"        — write, review, or debug code
  "summarisation" — condense a document, thread, or conversation
  "extraction"    — pull structured data from raw text/documents
  "qa"            — answer a direct question with a cited reference
  "embedding"     — produce a vector for retrieval
  "vision"        — analyse or describe an image

Each task type maps to a required capability frozenset; the router queries
the ModelRegistry with those capabilities and returns the best match.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Optional

from .candidate_policy import (
    CostState,
    Eligible,
    Exclusion,
    TaskRequest,
    candidate_from_record,
    filter_candidates,
)
from .model_registry import ModelRecord, ModelRegistry
from .policy import SovereignPolicy, load_sovereign_policy
from .policy_config import ModelPolicy, load_model_policy
from .usage_ledger import UsageLedger, spent_for_grants

#: Feature flag. Off by default; when off, routing is the legacy code path, unchanged.
POLICY_ROUTING_ENV = "AURA_MODEL_POLICY_ROUTING"
#: Output ceiling used to bound a call's cost. Matches the existing dispatch default.
POLICY_ROUTING_MAX_OUTPUT_TOKENS = 1024


def policy_routing_enabled(env=None) -> bool:
    """True only for an explicit 1/true/yes/on. Anything else, including unset, is off."""
    source = os.environ if env is None else env
    return str(source.get(POLICY_ROUTING_ENV, "")).strip().lower() in ("1", "true", "yes", "on")

# ---------------------------------------------------------------------------
# Capability requirements per task type
# ---------------------------------------------------------------------------

TASK_CAPABILITY_MAP: Dict[str, FrozenSet[str]] = {
    "planning":      frozenset({"text-generation", "json-mode"}),
    "coding":        frozenset({"code-generation"}),
    "summarisation": frozenset({"text-generation"}),
    "extraction":    frozenset({"text-generation", "json-mode"}),
    "qa":            frozenset({"text-generation"}),
    "embedding":     frozenset({"embedding"}),
    "vision":        frozenset({"vision", "text-generation"}),
    # Fallback bucket for unrecognised task types
    "general":       frozenset({"text-generation"}),
}

# Network classes the sovereign router will draw from.  Cloud is intentionally
# absent: sovereign routing only touches endpoints the operator controls.
SOVEREIGN_NETWORK_CLASSES = frozenset({"local", "private"})


@dataclass(frozen=True)
class RoutingDecision:
    """Outcome of a routing request.

    If ``record`` is None the router found no suitable private model and
    ``reason`` explains why.  The caller MUST NOT silently fall back to a
    cloud endpoint — it should surface an honest error.
    """

    task_type: str
    required_caps: FrozenSet[str]
    record: Optional[ModelRecord]
    reason: str              # human-readable, no secrets
    candidates_seen: int     # how many registry entries were considered
    #: Stable exclusion reasons from the policy filter. Empty on the legacy path.
    exclusions: tuple = field(default=())


class TaskClassifier:
    """Classify a natural-language task description into a task type.

    This is a lightweight keyword heuristic, intentionally simple.  It runs
    locally with no model call.  The intent pipeline uses this to pick the
    right capability bucket BEFORE committing to a model inference call.

    For production use the operator can swap in a model-backed classifier
    by subclassing and overriding ``classify()``.
    """

    # (pattern, task_type) — first match wins
    _RULES: list[tuple[re.Pattern, str]] = [
        (re.compile(
            r"\b(plan|outline|roadmap|schedule|breakdown|structure)\b",
            re.I), "planning"),
        (re.compile(
            r"\b(code|implement|function|class|bug|fix|refactor|test|"
            r"unit test|script|program|write.*\.py|write.*\.ts)\b",
            re.I), "coding"),
        (re.compile(
            r"\b(summarise|summarize|summary|tldr|recap|condense|brief)\b",
            re.I), "summarisation"),
        (re.compile(
            r"\b(extract|parse|pull out|identify all|list all|"
            r"find all|structured data)\b",
            re.I), "extraction"),
        (re.compile(
            r"\b(embed|embedding|vector|similarity|nearest|semantic search)\b",
            re.I), "embedding"),
        (re.compile(
            r"\b(image|photo|diagram|screenshot|visual|describe.*image|"
            r"what.*picture|analyse.*image)\b",
            re.I), "vision"),
        (re.compile(
            r"\b(what|who|when|where|why|how|answer|explain|describe)\b",
            re.I), "qa"),
    ]

    def classify(self, task_description: str) -> str:
        """Return the task type best matching ``task_description``.

        Falls back to ``"general"`` when no rule matches, ensuring a model
        candidate is always sought.
        """
        for pattern, task_type in self._RULES:
            if pattern.search(task_description):
                return task_type
        return "general"

    def required_capabilities(self, task_type: str) -> FrozenSet[str]:
        """Capability frozenset for a given task type."""
        return TASK_CAPABILITY_MAP.get(task_type,
                                       TASK_CAPABILITY_MAP["general"])


class ModelRouter:
    """Route a task to the best available private model.

    Usage:
        router = ModelRouter(registry)
        decision = router.route("Write a Python function to parse invoices")
        if decision.record is None:
            raise RuntimeError(f"No permitted model: {decision.reason}")
        # Use decision.record.model_name and decision.record.base_url
    """

    def __init__(self, registry: ModelRegistry,
                 classifier: TaskClassifier | None = None, *,
                 policy: ModelPolicy | None = None,
                 sovereign: SovereignPolicy | None = None,
                 ledger: UsageLedger | None = None) -> None:
        self._registry = registry
        self._classifier = classifier or TaskClassifier()
        # Used only when the policy flag is on. None means load from AURA_HOME.
        self._policy = policy
        self._sovereign = sovereign
        self._ledger = ledger

    def route(self, task_description: str,
              task_type: str | None = None,
              network_classes: frozenset | None = None) -> RoutingDecision:
        """Select the best model for the task.

        With the policy feature flag off (the default) this is exactly the legacy
        routing. With it on, candidates pass through the policy filter first.
        """
        if policy_routing_enabled():
            return self._route_with_policy(task_description, task_type, network_classes)
        return self._route_legacy(task_description, task_type, network_classes)

    def _route_with_policy(self, task_description: str, task_type: str | None,
                           network_classes: frozenset | None) -> RoutingDecision:
        """Policy-gated routing. Any failure in policy, accounting or filtering fails closed."""
        if task_type is None:
            task_type = self._classifier.classify(task_description)
        required_caps = self._classifier.required_capabilities(task_type)

        def closed(reason: str, seen: int = 0, excluded=()) -> RoutingDecision:
            return RoutingDecision(task_type=task_type, required_caps=required_caps,
                                   record=None, reason=reason, candidates_seen=seen,
                                   exclusions=tuple(excluded))

        try:
            policy: ModelPolicy = self._policy if self._policy is not None else load_model_policy()
            sovereign: SovereignPolicy = (self._sovereign if self._sovereign is not None
                                          else load_sovereign_policy())
            ledger = self._ledger
            if ledger is None:
                from aura.config import aura_path
                ledger = UsageLedger(aura_path("agent", "usage.sqlite3"))
            spent = spent_for_grants(ledger, policy.grants)
        except Exception as exc:
            return closed(f"Model policy unavailable; routing fails closed: "
                          f"{type(exc).__name__}: {exc}")

        nc = network_classes if network_classes is not None else SOVEREIGN_NETWORK_CLASSES
        records = self._registry.query(required_caps=required_caps, network_classes=nc,
                                       healthy_only=False)
        by_key = {(r.endpoint_id, r.model_name): r for r in records}
        request = TaskRequest(required_tags=required_caps,
                              max_output_tokens=POLICY_ROUTING_MAX_OUTPUT_TOKENS,
                              spent_by_grant=spent)
        try:
            result = filter_candidates([candidate_from_record(r) for r in records],
                                       request, sovereign, policy.endpoints, policy.grants)
        except Exception as exc:
            return closed(f"Policy evaluation failed; routing fails closed: "
                          f"{type(exc).__name__}: {exc}", seen=len(records))

        exclusions = [Exclusion(e.endpoint_id, e.model_name, e.reason, e.detail)
                      for e in result.excluded]
        # Paid dispatch is not metered: the worker's own CLI makes the model call and
        # AURA never sees its usage, so a paid candidate cannot be reserved or settled.
        # Until dispatch-time metering exists, a paid candidate is never selected here.
        usable: list[Eligible] = []
        for item in result.eligible:
            if item.cost_state is CostState.PAID:
                exclusions.append(Exclusion(item.endpoint_id, item.model_name,
                                            "paid-dispatch-not-metered",
                                            "paid use needs dispatch-time metering"))
            else:
                usable.append(item)

        if usable:
            best = by_key[(usable[0].endpoint_id, usable[0].model_name)]
            return RoutingDecision(
                task_type=task_type, required_caps=required_caps, record=best,
                reason=(f"Routed to {best.id!r} by policy filter "
                        f"(caps={sorted(best.capabilities)}, network={best.network_class})"),
                candidates_seen=len(records), exclusions=tuple(exclusions))

        reasons = sorted({e.reason for e in exclusions})
        hint = ""
        if "cost-unknown" in reasons:
            hint = (" Declare each private endpoint's cost ('free' or 'paid') in "
                    "model_policy.json; undeclared endpoints are not treated as free.")
        return closed(
            f"No eligible model for task_type={task_type!r}: "
            f"{', '.join(reasons) or 'no candidates'}.{hint}",
            seen=len(records), excluded=exclusions)

    def _route_legacy(self, task_description: str, task_type: str | None,
                      network_classes: frozenset | None) -> RoutingDecision:
        """Select the best model for the task.

        Args:
            task_description: natural-language description of the task.
            task_type: explicit task type override; if None, the classifier
                decides.
            network_classes: restrict to these network classes (default:
                all sovereign classes — "local" and "private").

        Returns a RoutingDecision.  If no model is available,
        ``decision.record`` is None and ``decision.reason`` explains why.
        """
        if task_type is None:
            task_type = self._classifier.classify(task_description)

        required_caps = self._classifier.required_capabilities(task_type)
        nc = network_classes if network_classes is not None else SOVEREIGN_NETWORK_CLASSES

        candidates = self._registry.query(
            required_caps=required_caps,
            network_classes=nc,
            healthy_only=True,
        )

        if not candidates:
            # Try without health filter to distinguish "no model at all" from
            # "models exist but are currently unhealthy"
            unhealthy = self._registry.query(
                required_caps=required_caps,
                network_classes=nc,
                healthy_only=False,
            )
            if unhealthy:
                reason = (
                    f"No healthy private model for task_type={task_type!r}"
                    f" (caps={sorted(required_caps)}). "
                    f"{len(unhealthy)} model(s) are configured but unhealthy — "
                    f"check Ollama / private server connectivity."
                )
            else:
                reason = (
                    f"No private model registered for task_type={task_type!r}"
                    f" (caps={sorted(required_caps)}). "
                    "Connect an Ollama server or add models via the model manifest."
                )
            return RoutingDecision(
                task_type=task_type,
                required_caps=required_caps,
                record=None,
                reason=reason,
                candidates_seen=len(unhealthy),
            )

        # Pick best candidate: already sorted by health + parameter size
        best = candidates[0]
        return RoutingDecision(
            task_type=task_type,
            required_caps=required_caps,
            record=best,
            reason=(
                f"Routed to {best.id!r} "
                f"(caps={sorted(best.capabilities)}, "
                f"size={best.parameter_size or 'unknown'}, "
                f"network={best.network_class})"
            ),
            candidates_seen=len(candidates),
        )

    def route_for_capability(
            self, required_caps: frozenset,
            network_classes: frozenset | None = None) -> RoutingDecision:
        """Low-level routing by capability set rather than task description."""
        nc = network_classes if network_classes is not None else SOVEREIGN_NETWORK_CLASSES
        candidates = self._registry.query(
            required_caps=required_caps,
            network_classes=nc,
            healthy_only=True,
        )
        if not candidates:
            return RoutingDecision(
                task_type="direct",
                required_caps=required_caps,
                record=None,
                reason=(
                    f"No private model for caps={sorted(required_caps)}."
                ),
                candidates_seen=0,
            )
        best = candidates[0]
        return RoutingDecision(
            task_type="direct",
            required_caps=required_caps,
            record=best,
            reason=f"Matched {best.id!r} for {sorted(required_caps)}",
            candidates_seen=len(candidates),
        )
