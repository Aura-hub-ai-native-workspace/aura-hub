"""dryrun — what WOULD happen, computed without anything happening.

Port of workflow/dryrun.ts. Static graph walk + Fabric.evaluate only.
Never calls a node runner, never invokes a capability, never resolves a
secret value, never touches approvals or audit.
"""
from __future__ import annotations

from typing import Any, Callable

from ..secrets import SecretStore
from .nodes_core import bindings, interpolate

BRANCHING_PORTS = {"true", "false", "each"}
MAX_LOOP = 20

NODE_CLASS: dict[str, str] = {
    "current-project": "pure", "selected-files": "pure", "changed-files": "governed",
    "current-conversation": "pure", "project-memory": "pure", "engineering-memory": "pure",
    "coding-engine": "intelligence", "fullstack-engine": "intelligence",
    "research-engine": "intelligence", "intent-classifier": "intelligence",
    "prompt-enhancer": "intelligence", "agent": "intelligence",
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

CAPABILITY_FOR_NODE = {
    "shell-command": "terminal.execute", "export-file": "filesystem.write",
    "git-status": "git.status", "changed-files": "git.status",
    "git-diff": "git.diff", "git-commit": "git.commit",
    "git-branch": "git.branch", "http-request": "http.request",
    "slack-notify": "http.request",
}

# Node labels for the shared vocabulary (nodes.ts spec labels).
LABELS = {
    "current-project": "Current Project", "selected-files": "Selected Files",
    "changed-files": "Changed Files (Git)", "current-conversation": "Current Conversation",
    "project-memory": "Project Memory", "engineering-memory": "Engineering Memory",
    "coding-engine": "Coding Knowledge Engine", "fullstack-engine": "FullStack Knowledge Engine",
    "research-engine": "Research Engine", "intent-classifier": "Intent Classifier",
    "prompt-enhancer": "Prompt Enhancer", "prompt": "Prompt", "groq": "Groq",
    "generate-markdown": "Generate Markdown", "generate-code": "Generate Code",
    "generate-json": "Generate JSON", "condition": "Condition", "loop": "Loop",
    "delay": "Delay", "variables": "Variables", "user-input": "User Input",
    "save-memory": "Save Memory", "create-note": "Create Note",
    "export-file": "Export File", "shell-command": "Run Shell Command (safe)",
    "git-status": "Git Status", "git-diff": "Git Diff", "git-commit": "Git Commit",
    "git-branch": "Git Branch", "http-request": "HTTP Request",
    "slack-notify": "Slack Notify", "agent": "AI Agent (bounded)", "output": "Output",
}


def analyze_graph(nodes: list[dict], edges: list[dict]) -> dict[str, dict]:
    by_id = {n["id"]: n for n in nodes}
    out_edges: dict[str, list] = {}
    in_deg: dict[str, int] = {n["id"]: 0 for n in nodes}
    for e in edges:
        if e["from"] not in by_id or e["to"] not in by_id:
            continue
        out_edges.setdefault(e["from"], []).append(e)
        in_deg[e["to"]] = in_deg.get(e["to"], 0) + 1

    info = {n["id"]: {"depth": 0, "reach": "unreachable"} for n in nodes}
    queue = [{"id": n["id"], "depth": 0, "conditional": False}
             for n in nodes if in_deg.get(n["id"], 0) == 0]
    seen: set[str] = set()
    guard = 0
    while queue and guard < len(nodes) * 8:
        guard += 1
        cur = queue.pop(0)
        nid, depth, conditional = cur["id"], cur["depth"], cur["conditional"]
        state = info[nid]
        reach = "conditional" if conditional else "certain"
        if state["reach"] == "unreachable" or (state["reach"] == "conditional" and reach == "certain"):
            info[nid] = {"depth": max(state["depth"], depth), "reach": reach}
        key = f"{nid}:{conditional}"
        if key in seen:
            continue
        seen.add(key)
        for e in out_edges.get(nid) or []:
            queue.append({"id": e["to"], "depth": depth + 1,
                          "conditional": conditional or e["fromPort"] in BRANCHING_PORTS})
    return info


def _locale_sorted(items: list[str]) -> list[str]:
    import functools

    return items


def dry_run_workflow(input_: dict) -> dict:

    nodes, edges = input_["nodes"], input_["edges"]
    fabric = input_.get("fabric")
    secrets_store: SecretStore | None = input_.get("secrets")

    validation = _validate(nodes, edges, secrets_store)
    envelope = compute_envelope_public(nodes)
    graph = analyze_graph(nodes, edges)
    scopes = [s_["scope"] for s_ in (envelope.get("scopes") or [])]
    grants = _grants_for_scopes(scopes)

    context = {"actor": {"kind": "human", "id": "dry-run"},
               "projectId": input_["projectId"], "cwd": input_["projectPath"]}
    fake_ctx = {"projectId": input_["projectId"], "projectPath": input_["projectPath"],
                "projectName": input_.get("projectName"), "vars": {},
                "runInputs": input_.get("inputs") or {}}

    planners = bindings()
    plan: list[dict] = []
    approvals: list[dict] = []
    denials: list[dict] = []
    policy_evaluations = 0

    ordered = sorted(nodes, key=lambda n: (graph.get(n["id"], {"depth": 0})["depth"], n["id"]))
    for i, node in enumerate(ordered):
        ntype = node["type"]
        cfg = node.get("config") or {}
        info = graph.get(node["id"], {"depth": 0, "reach": "unreachable"})
        step: dict[str, Any] = {
            "order": i + 1, "nodeId": node["id"], "type": ntype,
            "label": LABELS.get(ntype, ntype),
            "nodeClass": NODE_CLASS.get(ntype, "pure"),
            "reachability": info["reach"], "depth": info["depth"],
            "needsNetwork": NEEDS_NETWORK.get(ntype, False),
        }
        if ntype == "loop":
            times = cfg.get("times")
            try:
                t = int(times) if times is not None else 3
            except (TypeError, ValueError):
                t = 3
            step["maxIterations"] = max(1, min(MAX_LOOP, t))

        cap_id = CAPABILITY_FOR_NODE.get(ntype)
        if cap_id:
            d = describe_capability_safe(cap_id)
            step["capabilityId"] = cap_id
            if d:
                step["capabilityName"] = d["name"]
                step["risk"] = d["risk"]
                step["irreversible"] = bool(d.get("irreversible"))

            planner = planners.get(ntype)
            if planner:
                try:
                    planned = planner(fake_ctx, {"text": ""},
                                      dict(cfg), lambda t: interpolate(t, fake_ctx, {"text": ""}))
                    if planned:
                        step["describes"] = planned.get("describe")
                        refs: set[str] = set()
                        for v in (planned.get("input") or {}).values():
                            vals = [v] if isinstance(v, str) else (
                                list(v.values()) if isinstance(v, dict) else [])
                            if isinstance(v, str):
                                vals = [v]
                            for hv in vals:
                                if isinstance(hv, str):
                                    refs.update(SecretStore.references_in(hv))
                        if refs:
                            step["secretsUsed"] = sorted(refs)
                except Exception as err:  # noqa: BLE001
                    step["planError"] = str(err)

            if fabric is not None:
                evaluation = fabric.evaluate(cap_id, context)
                policy_evaluations += 1
                if evaluation:
                    step["policy"] = evaluation
                    step["wouldAskHuman"] = evaluation["decision"] in ("ask-user", "require-approval")
                    step["wouldBeDenied"] = evaluation["decision"] == "deny"
                    if step["wouldBeDenied"]:
                        denials.append({"nodeId": node["id"], "capabilityId": cap_id,
                                        "reason": evaluation["reason"], "rule": evaluation["rule"]})
                    elif step["wouldAskHuman"]:
                        approvals.append({"nodeId": node["id"], "capabilityId": cap_id,
                                          "reason": evaluation["reason"], "rule": evaluation["rule"]})
        plan.append(step)

    valid = not any(f["level"] == "error" for f in validation.get("findings", []))
    return {
        "workflowId": input_["workflowId"], "workflowName": input_["workflowName"],
        "projectId": input_["projectId"], "at": _iso(),
        "validation": validation, "envelope": envelope, "plan": plan,
        "approvalsRequired": approvals, "denials": denials,
        "wouldRunUnattended": valid and not denials and not approvals,
        "offlineCapable": envelope.get("offlineCapable", True),
        "secretsRequired": validation.get("secretsReferenced") or [],
        "secretsMissing": validation.get("secretsMissing") or [],
        "grants": grants,
        "sideEffects": {"invocations": 0, "policyEvaluations": policy_evaluations,
                        "note": ("A dry run evaluates policy and never invokes a capability. "
                                 "Nothing was executed, written, spawned or sent.")},
    }


def describe_capability_safe(cap_id):
    try:
        from ..fabric import describe_capability as _dc

        return _dc(cap_id)
    except Exception:
        return None


SCOPE_LABEL = {
    "project.read": "read this project", "project.write": "write to this project",
    "process.execute": "run commands", "network.outbound": "reach the network",
    "aura.read": "read AURA's own state", "aura.write": "change AURA's own state",
    "account.authorize": "act against your accounts",
    "resource.destroy": "destroy resources",
    "system.modify": "install or change software on this machine",
}
RANK = {"low": 0, "medium": 1, "high": 2}
SCOPE_ORDER = ["project.read", "project.write", "process.execute", "network.outbound",
               "aura.read", "aura.write", "account.authorize", "resource.destroy",
               "system.modify"]


def _host_of(raw):
    from urllib.parse import urlparse

    if not isinstance(raw, str) or not raw.strip():
        return None, False
    if "{{" in raw:
        return None, True
    try:
        parsed = urlparse(raw)
        if parsed.netloc:
            return parsed.netloc, False
    except Exception:
        pass
    return None, True


def compute_envelope_public(nodes):
    """Full AuthorityEnvelope shape (envelope.ts) for the shared vocabulary."""
    manifest = {c["id"]: c for c in _manifest()}
    by_cap: dict[str, dict] = {}
    hosts: set[str] = set()
    dynamic_host = False
    aura_internal: list[dict] = []
    unknown_nodes: list[str] = []

    for n in nodes:
        cap_id = CAPABILITY_FOR_NODE.get(n["type"])
        if cap_id and n["type"] != "slack-notify":
            m = manifest.get(cap_id)
            if m:
                entry = by_cap.setdefault(cap_id, {
                    "capabilityId": cap_id,
                    "name": m["name"],
                    "permissions": list(m.get("permissions") or []),
                    "risk": m["risk"],
                    "irreversible": bool(m.get("irreversible")),
                    "nodeIds": []})
                if n["id"] not in entry["nodeIds"]:
                    entry["nodeIds"].append(n["id"])
        if n["type"] == "http-request":
            host, dyn = _host_of((n.get("config") or {}).get("url"))
            if host:
                hosts.add(host)
            if dyn:
                dynamic_host = True
        if n["type"] in ("save-memory", "create-note"):
            aura_internal.append({"nodeId": n["id"], "type": n["type"]})
        if n["type"] not in NODE_CLASS:
            unknown_nodes.append(n["id"])

    used_scopes: set[str] = set()
    highest: str | None = None
    rank = {"low": 0, "medium": 1, "high": 2}
    for e in by_cap.values():
        used_scopes.update(e["permissions"])
        if highest is None or rank.get(e["risk"], 0) > rank[highest]:
            highest = e["risk"]
    ordered_caps = sorted(by_cap.values(), key=lambda x: (rank.get(x["risk"], 0), x["capabilityId"]))
    not_requested = [s_ for s_ in SCOPE_ORDER if s_ not in used_scopes]

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

    envelope_scopes = []
    for s_ in SCOPE_ORDER:
        if s_ not in used_scopes:
            continue
        contributing = [cid for cid, e in by_cap.items() if s_ in e["permissions"]]
        risk = max((by_cap[cid]["risk"] for cid in contributing),
                   key=lambda r: RANK.get(r, 0), default="low")
        node_ids = sorted({nid for cid in contributing
                           for nid in by_cap[cid]["nodeIds"]})
        envelope_scopes.append({"scope": s_, "label": SCOPE_LABEL[s_],
                                "capabilityIds": contributing,
                                "nodeIds": node_ids, "risk": risk})

    offline = not any(NEEDS_NETWORK.get(n["type"]) for n in nodes)

    return {
        "capabilities": ordered_caps,
        "scopes": envelope_scopes,
        "notRequested": not_requested,
        "cannot": cannot,
        "hasIrreversible": any(e["irreversible"] for e in by_cap.values()),
        "highestRisk": highest,
        "hosts": {"known": sorted(hosts), "dynamic": dynamic_host},
        "offlineCapable": offline,
        "auraInternalEffects": aura_internal,
        "unknownNodes": unknown_nodes,
    }


def _cap_node_type(cap_id, nodes):
    rev = {v: k for k, v in CAPABILITY_FOR_NODE.items()}
    return rev.get(cap_id)


_MANIFEST_CACHE = None


def _manifest():
    global _MANIFEST_CACHE
    if _MANIFEST_CACHE is None:
        import json
        from pathlib import Path

        f = Path(__file__).parent.parent / "fabric" / "manifest.json"
        _MANIFEST_CACHE = json.loads(f.read_text())["capabilities"]
    return _MANIFEST_CACHE


def _grants_for_scopes(scopes):
    FLAG = {"project.read": "read", "aura.read": "read", "project.write": "write",
            "aura.write": "write", "process.execute": "execute",
            "network.outbound": "execute"}
    out = {"read": False, "write": False, "execute": False, "autonomous": False}
    for sc in scopes:
        flag = FLAG.get(sc)
        if flag:
            out[flag] = True
    return out


def _validate(nodes, edges, secrets_store):
    findings: list[dict] = []
    ids: set[str] = set()
    for n in nodes:
        if n["id"] in ids:
            findings.append({"level": "error", "layer": "schema",
                             "message": f'duplicate node id "{n["id"]}"', "nodeId": n["id"]})
        ids.add(n["id"])
        if n["type"] not in NODE_CLASS:
            findings.append({"level": "error", "layer": "schema",
                             "message": f'unknown node type "{n["type"]}"', "nodeId": n["id"]})
    known_ids = ids
    for e in edges:
        if e["from"] not in known_ids or e["to"] not in known_ids:
            findings.append({"level": "error", "layer": "graph",
                             "message": f"edge references a node that does not exist ({e['from']} → {e['to']})"})
    entry_exists = any(
        not any(e["to"] == n["id"] for e in edges) for n in nodes) if nodes else True
    if nodes and not entry_exists:
        findings.append({"level": "error", "layer": "graph",
                         "message": "no entry node — every node has an incoming edge, so nothing can start"})
    if nodes and not any(n["type"] == "output" for n in nodes):
        findings.append({"level": "warning", "layer": "graph",
                         "message": "no Output node, so this workflow produces no visible result"})

    # secrets — names only; has() consulted per frozen validate.ts contract
    referenced: set[str] = set()
    store = secrets_store or SecretStore()
    for n in nodes:
        for v in (n.get("config") or {}).values():
            if isinstance(v, str):
                referenced.update(SecretStore.references_in(v))
    missing = sorted(x for x in referenced if not store.has(x))
    for name in missing:
        findings.append({"level": "error", "layer": "secrets",
                         "message": f'this workflow references the secret "{name}", which is not stored'})
    envelope = compute_envelope_public(nodes)
    return {
        "valid": not any(f["level"] == "error" for f in findings),
        "requiresReview": bool(envelope.get("hasIrreversible")
                               or envelope.get("highestRisk") == "high"),
        "findings": findings,
        "secretsReferenced": sorted(referenced),
        "secretsMissing": missing,
        "envelope": envelope,
    }


def _iso():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
