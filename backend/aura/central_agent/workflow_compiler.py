"""Workflow compiler — TaskPlan → candidate workflow definition.

The compiler emits graphs restricted to the frozen node vocabulary
(aura.contracts.workflow_def validates every node type at construction —
an unknown type is a compile error, not a runtime surprise). Structural
validation (unique ids, resolvable edges, valid ports, reachability,
acyclicity) runs here; once the Python workflow engine lands (P6), its own
validation re-judges the same artifact before any run. The compiler never
executes and never grants authority: a compiled graph is INERT DATA until
a governed path decides otherwise.
"""

from __future__ import annotations

import re
import uuid

from pydantic import ValidationError

from ..canonical import graph_hash
from ..contracts import AgentIntent, CompiledWorkflowRef, TaskPlan
from ..contracts.workflow_def import WfEdge, WfNode

VALID_PORTS = {"out", "true", "false", "each", "done"}


class CompilationError(Exception):
    pass


def _node(nid: str, ntype: str, x: float, y: float, config: dict | None = None) -> WfNode:
    try:
        return WfNode(id=nid, type=ntype, x=x, y=y, config=config or {})  # type: ignore[arg-type]
    except ValidationError as exc:
        raise CompilationError(f"node {nid!r}: unknown or invalid node type {ntype!r}") from exc


def _edge(src: str, dst: str, port: str = "out") -> WfEdge:
    if port not in VALID_PORTS:
        raise CompilationError(f"invalid port {port!r}")
    return WfEdge(id=f"e-{uuid.uuid4().hex[:8]}", **{"from": src}, fromPort=port, to=dst)


def compile_graph_for_intent(intent: AgentIntent) -> tuple[list[WfNode], list[WfEdge]]:
    """Deterministic template graphs keyed on goal text.

    Pure/read-only nodes by default; a recognized write clause adds ONE
    governed export-file node whose effect still passes policy + approval
    at run time. Compilation never executes anything.
    """
    text = f"{intent.goal} {intent.surface}".lower()
    nodes: list[WfNode] = []
    edges: list[WfEdge] = []

    wants_git = any(w in text for w in ("git", "commit", "branch", "status"))
    write = _extract_write_clause(intent.goal)

    entry = _node("src", "current-project", 0, 0, {})
    nodes.append(entry)
    last = entry.id
    if wants_git:
        git = _node("git", "git-status", 220, 0, {})
        nodes.append(git)
        edges.append(_edge(last, git.id))
        last = git.id
    if write is not None:
        path, content = write
        writer = _node("writer", "export-file", 330, 0,
                       {"path": path, "content": content})
        nodes.append(writer)
        edges.append(_edge(last, writer.id))
        last = writer.id
    out = _node("out", "output", 440, 0,
                {"text": intent.expectedOutcome or "Status collected."})
    nodes.append(out)
    edges.append(_edge(last, out.id))
    return nodes, edges


_WRITE_RE = re.compile(
    r"\b(?:write|writes|writing|save|saves|store|stores)\s+(?:a\s+)?(?:file\s+)?"
    r"(?:called\s+|named\s+)?['\"]?(.+?)['\"]?\s+(?:to|into|in)\s+"
    r"(?:a\s+file\s+)?(?:called\s+|named\s+)?['\"]?([\w][\w ./-]*?)['\"]?\s*$",
    re.IGNORECASE)


def _extract_write_clause(goal: str) -> tuple[str, str] | None:
    """'write hello to demo.txt' → ('demo.txt', 'hello'). Bounded and literal."""
    match = _WRITE_RE.search(goal)
    if not match:
        return None
    content, path = match.group(1).strip(), match.group(2).strip()
    if not path or not content or len(content) > 4096 or ".." in path:
        return None
    return path, content


def statusish(text: str) -> bool:
    return any(w in text for w in ("status", "state", "health", "overview"))


def validate_graph(nodes: list[WfNode], edges: list[WfEdge]) -> None:
    ids = [n.id for n in nodes]
    if len(set(ids)) != len(ids):
        raise CompilationError("duplicate node ids")
    known = set(ids)
    for e in edges:
        if e.from_ not in known:
            raise CompilationError(f"edge source {e.from_!r} does not exist")
        if e.to not in known:
            raise CompilationError(f"edge target {e.to!r} does not exist")
        if e.fromPort not in VALID_PORTS:
            raise CompilationError(f"edge port {e.fromPort!r} is not a valid port")
    # connectivity — the graph must be ONE component. Direction-blind on
    # purpose: a node that neither feeds nor follows anything else is an
    # orphan even though a naive forward walk would call it a second root.
    if nodes:
        adjacency: dict[str, set[str]] = {nid: set() for nid in ids}
        for e in edges:
            adjacency[e.from_].add(e.to)
            adjacency[e.to].add(e.from_)
        seen: set[str] = set()
        stack = [ids[0]]
        while stack:
            nid = stack.pop()
            if nid in seen:
                continue
            seen.add(nid)
            stack.extend(adjacency[nid] - seen)
        orphans = [nid for nid in ids if nid not in seen]
        if orphans:
            raise CompilationError(f"disconnected nodes: {orphans}")
    # acyclicity
    WHITE, GREY, BLACK = 0, 1, 2
    color = {nid: WHITE for nid in ids}

    def dfs(nid: str) -> None:
        color[nid] = GREY
        for e in edges:
            if e.from_ != nid:
                continue
            match color[e.to]:
                case 1:
                    raise CompilationError(f"cycle through {e.to}")
                case 0:
                    dfs(e.to)
        color[nid] = BLACK

    for nid in ids:
        if color[nid] == WHITE:
            dfs(nid)


class WorkflowCompiler:
    def compile(self, plan: TaskPlan) -> CompiledWorkflowRef:
        tasks = [t for t in plan.tasks if t.inputFrom == "compiled-workflow"]
        if not tasks:
            raise CompilationError("plan does not declare a compiled-workflow input")
        nodes, edges = compile_graph_for_intent(plan.intent)
        validate_graph(nodes, edges)
        wid = f"wfc-{uuid.uuid4().hex[:12]}"
        return CompiledWorkflowRef(
            workflowId=wid,
            name=_derive_name(plan),
            description=f"Authored by AURA central agent for session "
                        f"{plan.sessionId} (plan {plan.planId}).",
            nodes=[n.model_dump() for n in nodes],
            edges=[e.wire() for e in edges],
            graphHash=graph_hash([n.model_dump() for n in nodes],
                                 [e.wire() for e in edges]),
        )


def _derive_name(plan: TaskPlan) -> str:
    goal = plan.intent.goal.strip()
    # An explicit "named X" wins; clause starters and qualifiers are not
    # part of the name ("named repo-check that shows git status" → repo-check).
    named = re.search(r"\bnamed\s+(.+?)\s*$", goal, re.IGNORECASE)
    if named:
        candidate = re.split(
            r"\s+that\s+|\s+which\s+|\s+showing\s+|\s+with\s+|\s+for\s+|\s+to\s+",
            named.group(1).strip(), maxsplit=1, flags=re.IGNORECASE)[0].strip()
        candidate = candidate.strip("'\"")
        if candidate:
            return candidate[:60]
    for prefix in ("Author a workflow:", "Create workflow:", "Build workflow:",
                   "create a workflow", "Author a workflow"):
        if goal.lower().startswith(prefix.lower()):
            goal = goal[len(prefix):].strip()
    name = goal[:60] or "Agent-authored workflow"
    return name[0].upper() + name[1:]
