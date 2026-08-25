"""AgentBounds — port of workflow/agent/{types,bounds}.ts (security clamp).

Nothing in a definition, model output, tool output or MCP payload may WIDEN
a bound. resolveTools narrows to the workflow envelope; permanent refusals
are evaluated before fixable ones so authors get the honest answer.
"""
from __future__ import annotations

from collections.abc import Callable

AGENT_CEILINGS = {"maxIterations": 25, "timeoutMs": 600_000,
                  "maxTokens": 200_000, "maxConsecutiveFailures": 5}
AGENT_DEFAULTS = {"maxIterations": 10, "timeoutMs": 60_000,
                  "maxTokens": 10_000, "maxConsecutiveFailures": 3}

HUMAN_ONLY_SCOPES = ("account.authorize", "resource.destroy", "system.modify")

REFUSAL_CODES = ("unknown-capability", "unsupported-capability",
                 "agent-unsafe-irreversible", "agent-unsafe-human-only",
                 "outside-envelope")


def _clamp(value, fallback, ceiling):
    try:
        n = float(value) if value is not None else float("nan")
    except (TypeError, ValueError):
        n = float("nan")
    if n != n or n <= 0:
        return fallback
    return min(int(n // 1), ceiling)


def resolve_bounds(config: dict) -> dict:
    return {
        "maxIterations": _clamp(config.get("maxIterations"), AGENT_DEFAULTS["maxIterations"], AGENT_CEILINGS["maxIterations"]),
        "timeoutMs": _clamp(config.get("timeoutMs"), AGENT_DEFAULTS["timeoutMs"], AGENT_CEILINGS["timeoutMs"]),
        "maxTokens": _clamp(config.get("maxTokens"), AGENT_DEFAULTS["maxTokens"], AGENT_CEILINGS["maxTokens"]),
        "maxConsecutiveFailures": _clamp(config.get("maxConsecutiveFailures"), AGENT_DEFAULTS["maxConsecutiveFailures"], AGENT_CEILINGS["maxConsecutiveFailures"]),
        "tools": [t for t in (config.get("tools") or []) if isinstance(t, str) and t],
    }


def resolve_tools(requested: list[str], envelope_capabilities: list[dict],
                  supported: Callable | None = None):
    """bounds.ts:105-191 — four rules, permanent exclusions FIRST."""
    in_envelope = {c["capabilityId"] for c in envelope_capabilities}
    from ...fabric import describe_capability

    allowed, refused = [], []
    for capability_id in sorted(set(requested)):
        # manifest lookup is supplied by caller via supported() presence +
        # envelope; unknown ids refuse permanently
        if capability_id not in in_envelope and supported is None:
            refused.append({"capabilityId": capability_id, "code": "unknown-capability",
                            "reason": "No such capability exists in AURA's manifest.",
                            "permanent": True})
            continue
        descriptor = None
        if supported is not None:
            descriptor = supported(capability_id)
        if descriptor is None and capability_id not in in_envelope:
            continue
        d = describe_capability(capability_id)
        if d is None:
            refused.append({"capabilityId": capability_id, "code": "unknown-capability",
                            "reason": "No such capability exists in AURA’s manifest.",
                            "permanent": True})
            continue
        if d.get("irreversible"):
            name = d["name"]
            refused.append({"capabilityId": capability_id,
                            "code": "agent-unsafe-irreversible",
                            "reason": f"{name} cannot be undone by AURA, so it is never offered to an agent in any workflow. Put it in an explicit node a person can see before it runs.",
                            "permanent": True})
            continue
        human_only = next((p for p in d.get("permissions") or []
                           if p in HUMAN_ONLY_SCOPES), None)
        if human_only:
            refused.append({"capabilityId": capability_id,
                            "code": "agent-unsafe-human-only",
                            "reason": f"{d['name']} needs {human_only}, which only a person can satisfy, so it is never offered to an agent in any workflow.",
                            "permanent": True})
            continue
        if supported is not None and not supported(capability_id):
            refused.append({"capabilityId": capability_id,
                            "code": "unsupported-capability",
                            "reason": f"{d['name']} is declared but nothing on this machine can perform it yet, so it cannot be given to an agent.",
                            "permanent": False})
            continue
        if capability_id not in in_envelope:
            refused.append({"capabilityId": capability_id,
                            "code": "outside-envelope",
                            "reason": f"This workflow's authority does not include {d['name'].lower()}. Add it to this agent's tools, or to a node in the workflow, and it becomes available.",
                            "permanent": False})
            continue
        allowed.append(capability_id)
    return {"allowed": sorted(allowed), "refused": refused}


