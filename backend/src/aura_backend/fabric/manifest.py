"""One capability namespace for AURA and the outside world.

A port of packages/capability-fabric/src/manifest.ts.

`project.create` and `terminal.execute` are described in exactly the same
shape and invoked through exactly the same path, differing only in
surface, permission and risk. That flattening is the point: an agent must
not need one mechanism for AURA's own systems and another for external
tools.

Scope discipline: every entry here is either backed by a real executor,
or is an explicitly-justified extension point. There are no speculative
capabilities. A capability with no registered executor reports
`unsupported` at call time rather than pretending.
"""

from __future__ import annotations

from ..policy.types import PermissionScope as P
from ..policy.types import RiskLevel as R
from .types import CapabilityDescriptor, CapabilityField, FieldType


def _f(name: str, type_: FieldType, required: bool, description: str) -> CapabilityField:
    return CapabilityField(name=name, type=type_, required=required, description=description)


# ══════════════════════════════════════════════════════════════════
#  AURA internal — reached through the workspace manager
# ══════════════════════════════════════════════════════════════════

_INTERNAL: list[CapabilityDescriptor] = [
    CapabilityDescriptor(
        id="project.list", name="List projects", category="project", surface="aura-internal",
        description="Every project registered in this AURA installation.",
        risk=R.LOW, permissions=(P.AURA_READ,), output="ProjectRecord[]", verify=None,
    ),
    CapabilityDescriptor(
        id="project.create", name="Create project", category="project", surface="aura-internal",
        description=(
            "Creates a project directory and registers it. Reuses the existing project "
            "service — there is no second implementation."
        ),
        risk=R.MEDIUM, permissions=(P.AURA_WRITE, P.PROJECT_WRITE),
        input=(
            _f("name", "string", True, "Project name"),
            _f("parentPath", "string", False, "Directory to create it in"),
        ),
        output="ProjectRecord", verify="read-back",
    ),
    CapabilityDescriptor(
        id="project.open", name="Open project", category="project", surface="aura-internal",
        description="Makes a project the active workspace context.",
        risk=R.LOW, permissions=(P.AURA_WRITE,),
        input=(_f("projectId", "string", True, "Project id"),),
        output="ProjectRecord", verify="read-back",
    ),
    CapabilityDescriptor(
        id="project.inspect", name="Inspect project", category="project", surface="aura-internal",
        description="The generated profile: languages, frameworks, structure, entry points.",
        risk=R.LOW, permissions=(P.AURA_READ, P.PROJECT_READ),
        input=(_f("projectId", "string", True, "Project id"),),
        output="ProjectProfile", verify=None,
    ),
    CapabilityDescriptor(
        id="mission.create", name="Create mission", category="mission", surface="aura-internal",
        description=(
            "Runs Mission Control v3 planning on a free-text objective. The ONLY way the "
            "Fabric creates missions — it owns no mission model of its own."
        ),
        risk=R.LOW, permissions=(P.AURA_WRITE,),
        input=(
            _f("projectId", "string", True, "Project id"),
            _f("text", "string", True, "What the mission should achieve"),
        ),
        output="MissionRecord", verify="read-back",
    ),
    CapabilityDescriptor(
        id="mission.approve", name="Approve mission plan", category="mission",
        surface="aura-internal",
        description=(
            "Passes the planning checkpoint. A human gate by design — never auto-executed."
        ),
        risk=R.MEDIUM, permissions=(P.AURA_WRITE,),
        input=(
            _f("projectId", "string", True, "Project id"),
            _f("missionId", "string", True, "Mission id"),
        ),
        output="MissionRecord", verify="read-back",
    ),
    CapabilityDescriptor(
        id="mission.start", name="Start mission execution", category="mission",
        surface="aura-internal",
        description=(
            "Begins the approved plan. Per-task human accept still applies inside the engine."
        ),
        risk=R.MEDIUM, permissions=(P.AURA_WRITE,),
        input=(
            _f("projectId", "string", True, "Project id"),
            _f("missionId", "string", True, "Mission id"),
        ),
        output="MissionExecution", verify="read-back",
    ),
    CapabilityDescriptor(
        id="mission.inspect", name="Inspect mission", category="mission", surface="aura-internal",
        description=(
            "The authoritative MissionRecord: plan, DAG, checkpoints, timeline, metrics."
        ),
        risk=R.LOW, permissions=(P.AURA_READ,),
        input=(
            _f("projectId", "string", True, "Project id"),
            _f("missionId", "string", True, "Mission id"),
        ),
        output="MissionRecord", verify=None,
    ),
    CapabilityDescriptor(
        id="knowledge.graph", name="Read knowledge graph", category="knowledge",
        surface="aura-internal",
        description="Structural graph of the open project.",
        risk=R.LOW, permissions=(P.AURA_READ, P.PROJECT_READ),
        input=(_f("projectId", "string", True, "Project id"),),
        output="KnowledgeGraph", verify=None,
    ),
    CapabilityDescriptor(
        id="memory.search", name="Search engineering memory", category="memory",
        surface="aura-internal",
        description="Why past decisions were made, and what came of them.",
        risk=R.LOW, permissions=(P.AURA_READ,),
        input=(
            _f("projectId", "string", True, "Project id"),
            _f("query", "string", False, "Free-text query"),
        ),
        output="MemoryRecord[]", verify=None,
    ),
    CapabilityDescriptor(
        id="diagnosis.run", name="Run diagnosis", category="quality", surface="aura-internal",
        description="Finds and explains defects. Patches remain human-gated inside the engine.",
        risk=R.LOW, permissions=(P.AURA_WRITE, P.PROJECT_READ),
        input=(_f("projectId", "string", True, "Project id"),),
        output="DiagnosisRecord", verify=None,
    ),
    CapabilityDescriptor(
        id="governance.audit", name="Run governance audit", category="quality",
        surface="aura-internal",
        description="Health scorecard, risk, release readiness.",
        risk=R.LOW, permissions=(P.AURA_READ, P.PROJECT_READ),
        input=(_f("projectId", "string", True, "Project id"),),
        output="Scorecard", verify=None,
    ),
    CapabilityDescriptor(
        id="workflow.run", name="Run workflow", category="automation", surface="aura-internal",
        description=(
            "Executes an existing workflow through the Workflow Engine. The Fabric "
            "delegates — it does not re-implement workflow execution."
        ),
        risk=R.MEDIUM, permissions=(P.AURA_WRITE, P.PROCESS_EXECUTE),
        input=(
            _f("projectId", "string", True, "Project id"),
            _f("workflowId", "string", True, "Workflow id"),
        ),
        output="Run result", verify="read-back",
    ),
    CapabilityDescriptor(
        id="provider.connect", name="Connect AI provider", category="settings",
        surface="aura-internal",
        description=(
            "Registers a model provider key. Touches credentials, so it is always an "
            "explicit human authorization."
        ),
        risk=R.HIGH, permissions=(P.ACCOUNT_AUTHORIZE,),
        input=(
            _f("providerId", "string", True, "Provider id"),
            _f("apiKey", "string", True, "API key"),
        ),
        output="Connection status", verify="read-back", irreversible=False,
    ),
]

# ══════════════════════════════════════════════════════════════════
#  Local machine — through the allow-listed spawn primitives
# ══════════════════════════════════════════════════════════════════

_LOCAL: list[CapabilityDescriptor] = [
    CapabilityDescriptor(
        id="filesystem.list", name="List files", category="filesystem", surface="local-process",
        description="Directory listing inside the project root.",
        risk=R.LOW, permissions=(P.PROJECT_READ,),
        input=(_f("path", "string", False, "Relative path, defaults to project root"),),
        output="Entry names", verify=None,
    ),
    CapabilityDescriptor(
        id="filesystem.read", name="Read file", category="filesystem", surface="local-process",
        description="Reads a UTF-8 file inside the project root.",
        risk=R.LOW, permissions=(P.PROJECT_READ,),
        input=(_f("path", "string", True, "Relative path inside the project"),),
        output="File contents", verify=None,
    ),
    CapabilityDescriptor(
        id="filesystem.write", name="Write file", category="filesystem", surface="local-process",
        description="Creates or replaces a file inside the project root.",
        risk=R.MEDIUM, permissions=(P.PROJECT_WRITE,),
        input=(
            _f("path", "string", True, "Relative path inside the project"),
            _f("content", "string", True, "Full file contents"),
        ),
        output="Bytes written", verify="read-back",
    ),
    CapabilityDescriptor(
        id="terminal.execute", name="Run command", category="terminal", surface="local-process",
        description=(
            "Runs an allow-listed binary with plain arguments in the project root. "
            "No shell, no operators."
        ),
        risk=R.MEDIUM, permissions=(P.PROCESS_EXECUTE, P.PROJECT_READ),
        input=(_f("command", "string", True, 'Command line, e.g. "npm test"'),),
        output="stdout + stderr, exit code", verify="exit-code",
        requires_node_capability="terminal",
    ),
    CapabilityDescriptor(
        id="agent.delegate", name="Delegate to coding agent", category="agent",
        surface="local-process",
        description=(
            "Hands a task to a coding agent installed on this machine, which reads and "
            "edits files in the project root on its own. Broad by nature: the agent "
            "decides which files to touch, so this is never auto-executed."
        ),
        # High is the honest reading: the blast radius is "whatever the
        # agent decides to change".
        risk=R.HIGH,
        permissions=(P.PROJECT_READ, P.PROJECT_WRITE, P.PROCESS_EXECUTE, P.NETWORK_OUTBOUND),
        input=(
            _f("task", "string", True, "What the agent should do, in plain language"),
            _f("model", "string", False,
               'Optional provider/model override, e.g. "anthropic/claude-sonnet-4"'),
            # Supplied BY THE CALLER, from the Context Fabric. The executor
            # never assembles this itself: composing context inside the
            # executor would put a second understanding of the project
            # beside Repository Intelligence, and the two would drift.
            _f("context", "string", False,
               "AURA context contract to orient the agent, composed by the caller"),
        ),
        output="stdout + stderr, exit code", verify="exit-code",
        requires_node_capability="coding-agent",
        # Irreversible BY THE FABRIC, which is the precise claim this flag
        # makes. `filesystem.write` touches one path the Fabric could read
        # back and restore; an agent decides its own edit set across files
        # nobody named in advance, so there is nothing here to undo it
        # with. This also puts it behind the irreversible floor, which no
        # policy configuration can lower.
        irreversible=True,
    ),
    CapabilityDescriptor(
        id="system.install", name="Install a tool", category="system", surface="local-process",
        description=(
            "Installs a catalogued tool that is missing from this machine, using the "
            "package manager that tool declares. The caller names a NODE, never a "
            "command: the package and arguments come from the catalogue, so this can "
            "never be turned into \"run anything\". Installs that need administrator "
            "rights are not performed — AURA hands you the exact verified command instead."
        ),
        # `system.modify` is what makes this ungated-proof. `risk: high`
        # alone resolves to require-approval only under the DEFAULT policy;
        # a machine with byRisk.high = auto-execute would install software
        # silently. This scope triggers the non-configurable system floor,
        # and no node permission flag can ever grant it.
        risk=R.HIGH, permissions=(P.PROCESS_EXECUTE, P.SYSTEM_MODIFY),
        input=(_f("nodeId", "string", True, 'Catalogue id of the node to install, e.g. "pnpm"'),),
        output="InstallResult — installOutcome, privilege, command, probe",
        # `read-back`, not `exit-code`, and the distinction is the point.
        # An installer exiting 0 is a claim, not evidence.
        verify="read-back",
        # Deliberately no requires_node_capability. Installing is how a
        # node comes to exist, so demanding one already be present would
        # make this capability unreachable in precisely the case it exists
        # for. The consequence is intended: no acting node is resolved,
        # `executedNodeId` stays empty, and the node being installed
        # travels in the result payload — because it is the OBJECT of the
        # work, not the actor performing it.
        #
        # Not irreversible: adding a package is undone by removing it, and
        # the gate already comes from `risk: high`. Claiming the
        # irreversible floor here would devalue the flag where it applies.
        irreversible=False,
    ),
    CapabilityDescriptor(
        id="git.status", name="Git status", category="git", surface="local-process",
        description="Working tree status of the project.",
        risk=R.LOW, permissions=(P.PROJECT_READ,),
        output="Porcelain status", verify=None, requires_node_capability="source-control",
    ),
    CapabilityDescriptor(
        id="git.diff", name="Git diff", category="git", surface="local-process",
        description="Uncommitted changes.",
        risk=R.LOW, permissions=(P.PROJECT_READ,),
        input=(_f("staged", "boolean", False, "Staged changes only"),),
        output="Unified diff", verify=None, requires_node_capability="source-control",
    ),
    CapabilityDescriptor(
        id="git.branch", name="Create or switch branch", category="git", surface="local-process",
        description="Shows the current branch, or creates/switches when a name is given.",
        risk=R.MEDIUM, permissions=(P.PROJECT_WRITE,),
        input=(_f("name", "string", False, "Branch to create or switch to"),),
        output="Branch name", verify="read-back", requires_node_capability="source-control",
    ),
    CapabilityDescriptor(
        id="git.commit", name="Commit changes", category="git", surface="local-process",
        description="Stages everything and commits with the given message.",
        risk=R.MEDIUM, permissions=(P.PROJECT_WRITE,),
        input=(_f("message", "string", True, "Commit message"),),
        output="Commit summary", verify="read-back", requires_node_capability="source-control",
    ),
    CapabilityDescriptor(
        id="git.push", name="Push to remote", category="git", surface="local-process",
        description=(
            "Publishes commits to the remote. Visible to other people and not undoable "
            "by the Fabric."
        ),
        risk=R.HIGH, permissions=(P.PROJECT_WRITE, P.NETWORK_OUTBOUND),
        input=(
            _f("remote", "string", False, "Remote name, defaults to origin"),
            _f("branch", "string", False, "Branch, defaults to current"),
        ),
        output="Push summary", verify="exit-code", irreversible=True,
        requires_node_capability="source-control",
    ),
    CapabilityDescriptor(
        id="http.request", name="Call an HTTP API", category="network", surface="http",
        description="Bounded outbound request. Used for deployment checks and API calls.",
        risk=R.MEDIUM, permissions=(P.NETWORK_OUTBOUND,),
        input=(
            _f("url", "string", True, "Absolute http(s) URL"),
            _f("method", "string", False, "HTTP method, defaults to GET"),
            _f("body", "string", False, "Request body"),
        ),
        output="Status and bounded response text", verify="http-status",
        requires_node_capability="http-client",
    ),
]

# ══════════════════════════════════════════════════════════════════
#  Extension points — declared, deliberately not yet executable
# ══════════════════════════════════════════════════════════════════
#  These exist because the Fabric must be able to PLAN AROUND them and
#  report honestly that it cannot yet perform them. None has an executor,
#  so each resolves to `unsupported` at call time rather than pretending.

_EXTENSION_POINTS: list[CapabilityDescriptor] = [
    CapabilityDescriptor(
        id="github.create_repository", name="Create GitHub repository", category="code-hosting",
        surface="local-process",
        description=(
            "Creates a remote repository. Implementation path: `gh repo create` through "
            "the existing allow-listed spawn primitive."
        ),
        risk=R.MEDIUM, permissions=(P.NETWORK_OUTBOUND, P.ACCOUNT_AUTHORIZE),
        input=(
            _f("name", "string", True, "Repository name"),
            _f("private", "boolean", False, "Create it private"),
        ),
        output="Repository URL", verify="read-back", requires_node_capability="code-hosting",
    ),
    CapabilityDescriptor(
        id="github.create_pr", name="Open a pull request", category="code-hosting",
        surface="local-process",
        description="Opens a PR for the current branch. Implementation path: `gh pr create`.",
        risk=R.MEDIUM, permissions=(P.NETWORK_OUTBOUND, P.ACCOUNT_AUTHORIZE),
        input=(
            _f("title", "string", True, "PR title"),
            _f("body", "string", False, "PR description"),
        ),
        output="Pull request URL", verify="read-back", requires_node_capability="code-hosting",
    ),
    CapabilityDescriptor(
        id="browser.navigate", name="Open a page", category="browser", surface="browser",
        description=(
            "Loads a URL in a driven browser session. Implementation path: "
            "Playwright, per §9."
        ),
        risk=R.LOW, permissions=(P.NETWORK_OUTBOUND,),
        input=(_f("url", "string", True, "Absolute URL"),),
        output="Page title and final URL", verify="read-back",
        requires_node_capability="browser-automation",
    ),
    CapabilityDescriptor(
        id="browser.read", name="Read the page", category="browser", surface="browser",
        description="Extracts visible text and console errors from the current page.",
        risk=R.LOW, permissions=(P.NETWORK_OUTBOUND,),
        output="Text content and console errors", verify=None,
        requires_node_capability="browser-automation",
    ),
    CapabilityDescriptor(
        id="browser.click", name="Click an element", category="browser", surface="browser",
        description="Clicks the element matching a selector.",
        risk=R.MEDIUM, permissions=(P.NETWORK_OUTBOUND,),
        input=(_f("selector", "string", True, "CSS or text selector"),),
        output="Resulting URL", verify=None, requires_node_capability="browser-automation",
    ),
    CapabilityDescriptor(
        id="browser.type", name="Fill a field", category="browser", surface="browser",
        description="Types into the element matching a selector.",
        risk=R.MEDIUM, permissions=(P.NETWORK_OUTBOUND,),
        input=(
            _f("selector", "string", True, "CSS selector"),
            _f("text", "string", True, "Text to enter"),
        ),
        output="Field value", verify=None, requires_node_capability="browser-automation",
    ),
    CapabilityDescriptor(
        id="browser.screenshot", name="Capture the page", category="browser", surface="browser",
        description="Screenshots the current page for visual verification.",
        risk=R.LOW, permissions=(P.NETWORK_OUTBOUND,),
        output="Image path", verify=None, requires_node_capability="browser-automation",
    ),
]

CAPABILITY_MANIFEST: list[CapabilityDescriptor] = [*_INTERNAL, *_LOCAL, *_EXTENSION_POINTS]

_BY_ID = {c.id: c for c in CAPABILITY_MANIFEST}


def describe_fabric_capability(capability_id: str) -> CapabilityDescriptor | None:
    return _BY_ID.get(capability_id)
