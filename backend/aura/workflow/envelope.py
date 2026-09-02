"""Editor authority envelope — port of workflow/envelope.ts.

Answers "what is this graph permitted to do?" from THIS backend's own
capability manifest and node bindings. The renderer never derives risk.
An agent node contributes the tools it declares, filtered by the SAME
four safety rules the runtime applies — a definition can never widen its
own envelope.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

SCOPE_ORDER = [
    "project.read", "project.write", "process.execute", "network.outbound",
    "aura.read", "aura.write", "account.authorize", "resource.destroy",
    "system.modify",
]

SCOPE_LABEL = {
    "project.read": "read this project",
    "project.write": "write to this project",
    "process.execute": "run commands",
    "network.outbound": "reach the network",
    "aura.read": "read AURA's own state",
    "aura.write": "change AURA's own state",
    "account.authorize": "act against your accounts",
    "resource.destroy": "destroy resources",
    "system.modify": "install or change software on this machine",
}

NODE_CLASS: dict[str, str] = {
    "current-project": "pure", "selected-files": "pure",
    "changed-files": "governed", "current-conversation": "pure",
    "project-memory": "pure", "engineering-memory": "pure",
    "coding-engine": "intelligence", "fullstack-engine": "intelligence",
    "research-engine": "intelligence", "intent-classifier": "intelligence",
    "prompt-enhancer": "intelligence",
    # The agent NODE causes no effect; each tool call it makes is its own
    # governed invocation evaluated on its own terms.
    "agent": "intelligence",
    "prompt": "pure", "groq": "intelligence", "generate-markdown": "intelligence",
    "generate-code": "intelligence", "generate-json": "intelligence",
    "condition": "control", "loop": "control", "delay": "control",
    "variables": "control", "user-input": "control",
    "save-memory": "aura-internal", "create-note": "aura-internal",
    "export-file": "governed", "shell-command": "governed",
    "git-status": "governed", "git-diff": "governed", "git-commit": "governed",
    "git-branch": "governed", "http-request": "governed", "slack-notify": "governed",
    "output": "pure",
}

NEEDS_NETWORK = {"http-request": True, "slack-notify": True}


def capability_for_node(node_type: str) -> str | None:
    return {
        "shell-command": "terminal.execute",
        "export-file": "filesystem.write",
        "git-status": "git.status",
        "changed-files": "git.status",
        "git-diff": "git.diff",
        "git-commit": "git.commit",
        "git-branch": "git.branch",
        "http-request": "http.request",
        "slack-notify": "http.request",
    }.get(node_type)


RISK_RANK = {"low": 0, "medium": 1, "high": 2}


def _stricter(a: str, b: str) -> str:
    return a if RISK_RANK[a] >= RISK_RANK[b] else b


def _agent_tools_of(node: dict) -> list[str]:
    raw = (node.get("config") or {}).get("tools")
    if isinstance(raw, list):
        return [t for t in raw if isinstance(t, str) and t.strip()]
    if isinstance(raw, str):
        return [t.strip() for t in re.split(r"[\n,]", raw) if t.strip()]
    return []


def _host_of(raw: Any) -> dict:
    if not isinstance(raw, str) or not raw.strip():
        return {"host": None, "dynamic": False}
    if "{{" in raw:
        return {"host": None, "dynamic": True}
    try:
        parts = urlparse(raw)
        if not parts.netloc:
            return {"host": None, "dynamic": True}
        return {"host": parts.netloc, "dynamic": False}
    except ValueError:
        return {"host": None, "dynamic": True}


def _descriptor(capability_id: str) -> dict | None:
    from ..fabric.manifest import describe_capability

    d = describe_capability(capability_id)
    if d is None:
        return None
    return {
        "id": d.id, "name": d.name, "risk": d.risk,
        "permissions": list(d.permissions),
        "irreversible": bool(getattr(d, "irreversible", False)),
    }


def _admissible_agent_tool(descriptor: dict) -> bool:
    """The SAME four safety rules bounds.ts applies to agent tools."""
    if descriptor["irreversible"]:
        return False
    banned = {"account.authorize", "resource.destroy", "system.modify"}
    return not (set(descriptor["permissions"]) & banned)


def compute_editor_envelope(nodes: list[dict]) -> dict:
    by_capability: dict[str, dict] = {}
    aura_internal_effects: list[dict] = []
    unknown_nodes: list[str] = []
    hosts: set[str] = set()
    dynamic_host = False
    needs_network = False

    for node in nodes:
        ntype = node.get("type") or ""
        klass = NODE_CLASS.get(ntype)
        if klass is None:
            unknown_nodes.append(node["id"])
            continue
        if klass == "aura-internal":
            aura_internal_effects.append({"nodeId": node["id"], "type": ntype})
        if NEEDS_NETWORK.get(ntype):
            needs_network = True

        if ntype == "agent":
            for requested in _agent_tools_of(node):
                descriptor = _descriptor(requested)
                if descriptor is None or not _admissible_agent_tool(descriptor):
                    continue
                existing = by_capability.get(requested)
                if existing:
                    if node["id"] not in existing["nodeIds"]:
                        existing["nodeIds"].append(node["id"])
                    continue
                by_capability[requested] = {
                    "capabilityId": requested,
                    "name": descriptor["name"],
                    "risk": descriptor["risk"],
                    "irreversible": False,
                    "permissions": list(descriptor["permissions"]),
                    "nodeIds": [node["id"]],
                    "viaAgent": True,
                }
            continue

        capability_id = capability_for_node(ntype)
        if not capability_id:
            continue
        descriptor = _descriptor(capability_id)
        if descriptor is None:
            # A binding pointing at an unknown capability stays visible.
            unknown_nodes.append(node["id"])
            continue
        existing = by_capability.get(capability_id)
        if existing:
            if node["id"] not in existing["nodeIds"]:
                existing["nodeIds"].append(node["id"])
        else:
            by_capability[capability_id] = {
                "capabilityId": capability_id,
                "name": descriptor["name"],
                "risk": descriptor["risk"],
                "irreversible": descriptor["irreversible"],
                "permissions": list(descriptor["permissions"]),
                "nodeIds": [node["id"]],
            }

        if ntype in ("http-request", "slack-notify"):
            cfg_key = "url" if ntype == "http-request" else "webhookUrl"
            found = _host_of((node.get("config") or {}).get(cfg_key))
            if found["host"]:
                hosts.add(found["host"])
            if found["dynamic"]:
                dynamic_host = True

    capabilities = sorted(
        by_capability.values(),
        key=lambda c: (-RISK_RANK[c["risk"]], c["capabilityId"]))

    scope_map: dict[str, dict] = {}
    for cap in capabilities:
        for scope in cap["permissions"]:
            entry = scope_map.get(scope)
            if entry is not None:
                entry["capabilityIds"].append(cap["capabilityId"])
                for nid in cap["nodeIds"]:
                    if nid not in entry["nodeIds"]:
                        entry["nodeIds"].append(nid)
                entry["risk"] = _stricter(entry["risk"], cap["risk"])
            else:
                scope_map[scope] = {
                    "scope": scope,
                    "label": SCOPE_LABEL[scope],
                    "capabilityIds": [cap["capabilityId"]],
                    "nodeIds": list(cap["nodeIds"]),
                    "risk": cap["risk"],
                }
    scopes = [scope_map[s] for s in SCOPE_ORDER if s in scope_map]

    # An agent holding a network capability reaches the network. Derived
    # from ADMITTED capabilities — never from raw config.
    if "network.outbound" in scope_map:
        needs_network = True
    not_requested = [s for s in SCOPE_ORDER if s not in scope_map]

    cannot_parts: list[str] = []
    if "system.modify" in not_requested:
        cannot_parts.append("install or change software on this machine")
    if "resource.destroy" in not_requested:
        cannot_parts.append("destroy anything")
    if "account.authorize" in not_requested:
        cannot_parts.append("act against your accounts")
    if "process.execute" in not_requested:
        cannot_parts.append("run commands")
    if "project.write" in not_requested:
        cannot_parts.append("write to this project")
    if "network.outbound" in not_requested:
        cannot_parts.append("reach the network")
    elif hosts and not dynamic_host:
        cannot_parts.append(f"reach any host other than {', '.join(sorted(hosts))}")

    cannot = (f"This workflow cannot {', '.join(cannot_parts)}."
              if cannot_parts else
              "This workflow requests every permission AURA can grant.")

    highest = None
    for cap in capabilities:
        highest = cap["risk"] if highest is None else _stricter(highest, cap["risk"])

    return {
        "capabilities": capabilities,
        "scopes": scopes,
        "notRequested": not_requested,
        "cannot": cannot,
        "hasIrreversible": any(c["irreversible"] for c in capabilities),
        "highestRisk": highest,
        "hosts": {"known": sorted(hosts), "dynamic": dynamic_host},
        "offlineCapable": not needs_network,
        "auraInternalEffects": aura_internal_effects,
        "unknownNodes": unknown_nodes,
    }


def diff_envelopes(before: dict, after: dict) -> dict:
    before_scopes = {s["scope"] for s in before.get("scopes") or []}
    after_scopes = {s["scope"] for s in after.get("scopes") or []}
    before_caps = {c["capabilityId"] for c in before.get("capabilities") or []}
    after_caps = {c["capabilityId"] for c in after.get("capabilities") or []}

    added_scopes = sorted(after_scopes - before_scopes)
    removed_scopes = sorted(before_scopes - after_scopes)
    added_caps = sorted(after_caps - before_caps)
    removed_caps = sorted(before_caps - after_caps)
    newly_irreversible = (
        not any(c.get("irreversible") for c in before.get("capabilities") or [])
        and any(c.get("irreversible") for c in after.get("capabilities") or []))
    widened = bool(added_scopes or added_caps)

    if widened and newly_irreversible:
        summary = "This version adds authority, including an irreversible action."
    elif widened:
        summary = "This version asks for more authority than the one before it."
    elif newly_irreversible:
        summary = "This version introduces an irreversible action."
    elif removed_scopes or removed_caps:
        summary = "This version narrows what the workflow may do."
    else:
        summary = None

    return {
        "widened": widened,
        "addedScopes": added_scopes,
        "removedScopes": removed_scopes,
        "addedCapabilities": added_caps,
        "removedCapabilities": removed_caps,
        "newlyIrreversible": newly_irreversible,
        "summary": summary,
    }
