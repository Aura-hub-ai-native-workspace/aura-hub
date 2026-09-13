/**
 * manifest — one capability namespace for AURA and the outside world.
 * ==================================================================
 * §8.3 of the brief: the agent must not need one mechanism for AURA's own
 * systems and another for external tools. This file is where that
 * flattening happens — `project.create` and `terminal.execute` are
 * described in exactly the same shape and invoked through exactly the
 * same path, differing only in surface, permission and risk.
 *
 * Scope discipline (§33): every entry here is either backed by a real
 * executor today, or is an explicitly-justified extension point named in
 * the roadmap. There are no speculative capabilities. A capability with
 * no registered executor reports `unsupported` at call time rather than
 * pretending — see `fabric.ts`.
 *
 * Internal capabilities map onto `WorkspaceManager` methods that already
 * exist (`ai-service/src/workspace.ts`); nothing here reimplements them.
 */

import type { CapabilityDescriptor, CapabilityField } from './types';

const f = (
  name: string,
  type: CapabilityField['type'],
  required: boolean,
  description: string,
): CapabilityField => ({ name, type, required, description });

type Draft = Omit<CapabilityDescriptor, 'input' | 'permissions'> & {
  input?: CapabilityField[];
  permissions: CapabilityDescriptor['permissions'];
};

const cap = (d: Draft): CapabilityDescriptor => ({ ...d, input: d.input ?? [] });

/* ══════════════════════════════════════════════════════════════════
   AURA internal — reached through WorkspaceManager
   ══════════════════════════════════════════════════════════════════ */

const INTERNAL: CapabilityDescriptor[] = [
  cap({
    id: 'project.list', name: 'List projects', category: 'project', surface: 'aura-internal',
    description: 'Every project registered in this AURA installation.',
    risk: 'low', permissions: ['aura.read'], output: 'ProjectRecord[]', verify: null,
  }),
  cap({
    id: 'project.create', name: 'Create project', category: 'project', surface: 'aura-internal',
    description: 'Creates a project directory and registers it. Reuses the existing project service — there is no second implementation.',
    risk: 'medium', permissions: ['aura.write', 'project.write'],
    input: [f('name', 'string', true, 'Project name'), f('parentPath', 'string', false, 'Directory to create it in')],
    output: 'ProjectRecord', verify: 'read-back',
  }),
  cap({
    id: 'project.open', name: 'Open project', category: 'project', surface: 'aura-internal',
    description: 'Makes a project the active workspace context.',
    risk: 'low', permissions: ['aura.write'],
    input: [f('projectId', 'string', true, 'Project id')],
    output: 'ProjectRecord', verify: 'read-back',
  }),
  cap({
    id: 'project.inspect', name: 'Inspect project', category: 'project', surface: 'aura-internal',
    description: 'The generated profile: languages, frameworks, structure, entry points.',
    risk: 'low', permissions: ['aura.read', 'project.read'],
    input: [f('projectId', 'string', true, 'Project id')],
    output: 'ProjectProfile', verify: null,
  }),

  cap({
    id: 'mission.create', name: 'Create mission', category: 'mission', surface: 'aura-internal',
    description: 'Runs Mission Control v3 planning on a free-text objective. The ONLY way the Fabric creates missions — it owns no mission model of its own.',
    risk: 'low', permissions: ['aura.write'],
    input: [f('projectId', 'string', true, 'Project id'), f('text', 'string', true, 'What the mission should achieve')],
    output: 'MissionRecord', verify: 'read-back',
  }),
  cap({
    id: 'mission.approve', name: 'Approve mission plan', category: 'mission', surface: 'aura-internal',
    description: 'Passes the planning checkpoint. A human gate by design — never auto-executed.',
    risk: 'medium', permissions: ['aura.write'],
    input: [f('projectId', 'string', true, 'Project id'), f('missionId', 'string', true, 'Mission id')],
    output: 'MissionRecord', verify: 'read-back',
  }),
  cap({
    id: 'mission.start', name: 'Start mission execution', category: 'mission', surface: 'aura-internal',
    description: 'Begins the approved plan. Per-task human accept still applies inside the engine.',
    risk: 'medium', permissions: ['aura.write'],
    input: [f('projectId', 'string', true, 'Project id'), f('missionId', 'string', true, 'Mission id')],
    output: 'MissionExecution', verify: 'read-back',
  }),
  cap({
    id: 'mission.inspect', name: 'Inspect mission', category: 'mission', surface: 'aura-internal',
    description: 'The authoritative MissionRecord: plan, DAG, checkpoints, timeline, metrics.',
    risk: 'low', permissions: ['aura.read'],
    input: [f('projectId', 'string', true, 'Project id'), f('missionId', 'string', true, 'Mission id')],
    output: 'MissionRecord', verify: null,
  }),

  cap({
    id: 'knowledge.graph', name: 'Read knowledge graph', category: 'knowledge', surface: 'aura-internal',
    description: 'Structural graph of the open project.',
    risk: 'low', permissions: ['aura.read', 'project.read'],
    input: [f('projectId', 'string', true, 'Project id')],
    output: 'KnowledgeGraph', verify: null,
  }),
  cap({
    id: 'memory.search', name: 'Search engineering memory', category: 'memory', surface: 'aura-internal',
    description: 'Why past decisions were made, and what came of them.',
    risk: 'low', permissions: ['aura.read'],
    input: [f('projectId', 'string', true, 'Project id'), f('query', 'string', false, 'Free-text query')],
    output: 'MemoryRecord[]', verify: null,
  }),
  cap({
    id: 'diagnosis.run', name: 'Run diagnosis', category: 'quality', surface: 'aura-internal',
    description: 'Finds and explains defects. Patches remain human-gated inside the engine.',
    risk: 'low', permissions: ['aura.write', 'project.read'],
    input: [f('projectId', 'string', true, 'Project id')],
    output: 'DiagnosisRecord', verify: null,
  }),
  cap({
    id: 'governance.audit', name: 'Run governance audit', category: 'quality', surface: 'local-process',
    description: 'Runs the engineering audit and health scorecard over the project: overall health and grade, top risks, new debt, architecture and security findings, and recommendations. Reads the repository and its git history; does NOT run a package-manager audit, so the result never depends on the network.',
    risk: 'low', permissions: ['aura.read', 'project.read'],
    input: [
      f('projectId', 'string', true, 'Project id'),
      f('scope', 'string', false, 'One of: daily, weekly, release, architecture. Defaults to daily.'),
    ],
    output: 'Engineering audit report and health scorecard', verify: null,
  }),
  cap({
    id: 'workflow.run', name: 'Run workflow', category: 'automation', surface: 'aura-internal',
    description: 'Executes an existing workflow through the Workflow Engine. The Fabric delegates — it does not re-implement workflow execution.',
    risk: 'medium', permissions: ['aura.write', 'process.execute'],
    input: [f('projectId', 'string', true, 'Project id'), f('workflowId', 'string', true, 'Workflow id')],
    output: 'Run result', verify: 'read-back',
  }),
  cap({
    id: 'provider.connect', name: 'Connect AI provider', category: 'settings', surface: 'aura-internal',
    description: 'Registers a model provider key. Touches credentials, so it is always an explicit human authorization.',
    risk: 'high', permissions: ['account.authorize'],
    input: [f('providerId', 'string', true, 'Provider id'), f('apiKey', 'string', true, 'API key')],
    output: 'Connection status', verify: 'read-back', irreversible: false,
  }),
];

/* ══════════════════════════════════════════════════════════════════
   Local machine — through the existing allow-listed spawn primitives
   ══════════════════════════════════════════════════════════════════ */

const LOCAL: CapabilityDescriptor[] = [
  cap({
    id: 'filesystem.list', name: 'List files', category: 'filesystem', surface: 'local-process',
    description: 'Directory listing inside the project root.',
    risk: 'low', permissions: ['project.read'],
    input: [f('path', 'string', false, 'Relative path, defaults to project root')],
    output: 'Entry names', verify: null,
  }),
  cap({
    id: 'filesystem.read', name: 'Read file', category: 'filesystem', surface: 'local-process',
    description: 'Reads a UTF-8 file inside the project root.',
    risk: 'low', permissions: ['project.read'],
    input: [f('path', 'string', true, 'Relative path inside the project')],
    output: 'File contents', verify: null,
  }),
  cap({
    id: 'filesystem.write', name: 'Write file', category: 'filesystem', surface: 'local-process',
    description: 'Creates or replaces a file inside the project root.',
    risk: 'medium', permissions: ['project.write'],
    input: [f('path', 'string', true, 'Relative path inside the project'), f('content', 'string', true, 'Full file contents')],
    output: 'Bytes written', verify: 'read-back',
  }),
  cap({
    id: 'terminal.execute', name: 'Run command', category: 'terminal', surface: 'local-process',
    description: 'Runs an allow-listed binary with plain arguments in the project root. No shell, no operators.',
    risk: 'medium', permissions: ['process.execute', 'project.read'],
    input: [f('command', 'string', true, 'Command line, e.g. "npm test"')],
    output: 'stdout + stderr, exit code', verify: 'exit-code',
    requiresNodeCapability: 'terminal',
  }),

  cap({
    id: 'agent.delegate', name: 'Delegate to coding agent', category: 'agent', surface: 'local-process',
    description:
      'Hands a task to a coding agent installed on this machine, which reads and edits files in the project root on its own. '
      + 'Broad by nature: the agent decides which files to touch, so this is never auto-executed.',
    // High is the honest reading: the blast radius is "whatever the agent
    // decides to change". The default policy maps high → require-approval,
    // so this needs no override to be gated.
    risk: 'high', permissions: ['project.read', 'project.write', 'process.execute', 'network.outbound'],
    input: [
      f('task', 'string', true, 'What the agent should do, in plain language'),
      f('model', 'string', false, 'Optional provider/model override, e.g. "anthropic/claude-sonnet-4"'),
      // Supplied BY THE CALLER, from the AURA Context Fabric. The executor
      // never assembles this itself: composing context inside the executor
      // would put a second understanding of the project beside Repository
      // Intelligence, and the two would drift. An agent that receives it
      // starts oriented instead of re-scanning the repository.
      f('context', 'string', false, 'AURA context contract to orient the agent, composed by the caller'),
      f('scopePaths', 'string[]', false, 'Optional task-contract scope: repo-relative paths the worker may change. Changed files outside the scope park the run for a decision instead of reporting success.'),
      // `nodeId` is deliberately NOT an input any more. Which node runs an
      // action is routing, not an argument, and it now lives on
      // `InvocationContext.nodeId` (§22.2). The transport still accepts it
      // in the input position as a compatibility alias — honoured as
      // routing intent, never ignored — so an older caller naming a bad
      // node is refused rather than quietly served by a different one.
    ],
    output: 'stdout + stderr, exit code',
    verify: 'exit-code',
    // The only real link to a node. Provided by cursor, claude-code,
    // codex-cli, gemini-cli, qwen-cli and opencode — and by nothing else,
    // which is what keeps activity attributable to the agent that ran.
    requiresNodeCapability: 'coding-agent',
    /**
     * Irreversible *by the Fabric*, which is the precise claim this flag
     * makes. `filesystem.write` touches one path the Fabric could read
     * back and restore; an agent decides its own edit set across files
     * nobody named in advance, so there is nothing here to undo it with.
     *
     * This also puts it behind the `irreversible-floor`, which no policy
     * configuration can lower — so delegation stays gated even on a
     * machine whose operator has set high risk to auto-execute.
     */
    irreversible: true,
  }),

  cap({
    id: 'system.install', name: 'Install a tool', category: 'system', surface: 'local-process',
    description:
      'Installs a catalogued tool that is missing from this machine, using the package manager that tool '
      + 'declares. The caller names a NODE, never a command: the package and arguments come from the '
      + 'catalogue, so this can never be turned into "run anything". Installs that need administrator '
      + 'rights are not performed — AURA hands you the exact verified command instead.',
    // High is the honest reading: this changes software on the machine
    // itself, outside any project root. `DEFAULT_POLICY.byRisk.high`
    // resolves to require-approval, so it is gated with no override.
    // `system.modify` is what makes this ungated-proof. `risk: high` alone
    // resolves to require-approval only under the DEFAULT policy — a
    // machine with `byRisk.high = auto-execute` would install software
    // silently. This scope triggers the non-configurable `system-floor`,
    // and no node permission flag can ever grant it.
    risk: 'high', permissions: ['process.execute', 'system.modify'],
    input: [
      f('nodeId', 'string', true, 'Catalogue id of the node to install, e.g. "pnpm"'),
    ],
    output: 'InstallResult — installOutcome, privilege, command, probe',
    /**
     * `read-back`, not `exit-code`, and the distinction is the point.
     *
     * An installer exiting 0 is a claim, not evidence. Verification
     * re-probes through the existing environment scanner and passes only
     * when a real version comes back — so a node reaching `available` by
     * installation has met exactly the same bar as one that was always
     * there (§25.5).
     */
    verify: 'read-back',
    /**
     * Deliberately no `requiresNodeCapability`. Installing is how a node
     * comes to exist, so demanding one already be present would make this
     * capability unreachable in precisely the case it exists for.
     *
     * The consequence is intended (§25.2 C4): the Fabric resolves no
     * acting node, `executedNodeId` stays empty, and the node being
     * installed travels in the result payload — because it is the OBJECT
     * of the work, not the actor performing it.
     */
    /**
     * Not irreversible: adding a package is undone by removing it, and the
     * `require-approval` gate already comes from `risk: high`. Claiming the
     * irreversible floor here would be dishonest about what an install is,
     * and would devalue the flag where it genuinely applies.
     */
    irreversible: false,
  }),

  cap({
    id: 'system.uninstall', name: 'Remove a tool', category: 'system', surface: 'local-process',
    description:
      'Removes a catalogued tool from this machine, using the package manager that tool '
      + 'declares. The caller names a NODE, never a command: the package and arguments come from the '
      + 'catalogue, so this can never be turned into "run anything". Removals that need administrator '
      + 'rights are not performed — AURA hands you the exact verified command instead.',
    risk: 'high', permissions: ['process.execute', 'system.modify'],
    input: [
      f('nodeId', 'string', true, 'Catalogue id of the node to remove, e.g. "pnpm"'),
    ],
    output: 'UninstallResult — uninstallOutcome, privilege, command, probe',
    verify: 'read-back',
    irreversible: false,
  }),

  cap({
    id: 'git.status', name: 'Git status', category: 'git', surface: 'local-process',
    description: 'Working tree status of the project.',
    risk: 'low', permissions: ['project.read'],
    output: 'Porcelain status', verify: null, requiresNodeCapability: 'source-control',
  }),
  cap({
    id: 'git.diff', name: 'Git diff', category: 'git', surface: 'local-process',
    description: 'Uncommitted changes.',
    risk: 'low', permissions: ['project.read'],
    input: [f('staged', 'boolean', false, 'Staged changes only')],
    output: 'Unified diff', verify: null, requiresNodeCapability: 'source-control',
  }),
  cap({
    id: 'git.branch', name: 'Create or switch branch', category: 'git', surface: 'local-process',
    description: 'Shows the current branch, or creates/switches when a name is given.',
    risk: 'medium', permissions: ['project.write'],
    input: [f('name', 'string', false, 'Branch to create or switch to')],
    output: 'Branch name', verify: 'read-back', requiresNodeCapability: 'source-control',
  }),
  cap({
    id: 'git.commit', name: 'Commit changes', category: 'git', surface: 'local-process',
    description: 'Stages everything and commits with the given message.',
    risk: 'medium', permissions: ['project.write'],
    input: [f('message', 'string', true, 'Commit message')],
    output: 'Commit summary', verify: 'read-back', requiresNodeCapability: 'source-control',
  }),
  cap({
    id: 'git.push', name: 'Push to remote', category: 'git', surface: 'local-process',
    description: 'Publishes commits to the remote. Visible to other people and not undoable by the Fabric.',
    risk: 'high', permissions: ['project.write', 'network.outbound'],
    input: [f('remote', 'string', false, 'Remote name, defaults to origin'), f('branch', 'string', false, 'Branch, defaults to current')],
    output: 'Push summary', verify: 'exit-code', irreversible: true,
    requiresNodeCapability: 'source-control',
  }),

  cap({
    id: 'http.request', name: 'Call an HTTP API', category: 'network', surface: 'http',
    description: 'Bounded outbound request. Used for deployment checks and API calls.',
    risk: 'medium', permissions: ['network.outbound'],
    input: [
      f('url', 'string', true, 'Absolute http(s) URL'),
      f('method', 'string', false, 'HTTP method, defaults to GET'),
      f('body', 'string', false, 'Request body'),
    ],
    output: 'Status and bounded response text', verify: 'http-status',
    requiresNodeCapability: 'http-client',
  }),
];

/* ══════════════════════════════════════════════════════════════════
   Extension points — declared, deliberately not yet executable
   ══════════════════════════════════════════════════════════════════
   These exist because the Fabric must be able to *plan around* them and
   report honestly that it cannot yet perform them (§26). Each has a named
   implementation path in the roadmap. None has an executor, so each
   resolves to `unsupported` at call time rather than pretending.
   ══════════════════════════════════════════════════════════════════ */

const EXTENSION_POINTS: CapabilityDescriptor[] = [
  cap({
    id: 'github.create_repository', name: 'Create GitHub repository', category: 'code-hosting', surface: 'local-process',
    description: 'Creates a remote repository. Implementation path: `gh repo create` through the existing allow-listed spawn primitive.',
    risk: 'medium', permissions: ['network.outbound', 'account.authorize'],
    input: [f('name', 'string', true, 'Repository name'), f('private', 'boolean', false, 'Create it private')],
    output: 'Repository URL', verify: 'read-back', requiresNodeCapability: 'code-hosting',
  }),
  cap({
    id: 'github.create_pr', name: 'Open a pull request', category: 'code-hosting', surface: 'local-process',
    description: 'Opens a PR for the current branch. Implementation path: `gh pr create`.',
    risk: 'medium', permissions: ['network.outbound', 'account.authorize'],
    input: [f('title', 'string', true, 'PR title'), f('body', 'string', false, 'PR description')],
    output: 'Pull request URL', verify: 'read-back', requiresNodeCapability: 'code-hosting',
  }),

  cap({
    id: 'browser.navigate', name: 'Open a page', category: 'browser', surface: 'browser',
    description: 'Loads a URL in a driven browser session. Implementation path: Playwright, per §9.',
    risk: 'low', permissions: ['network.outbound'],
    input: [f('url', 'string', true, 'Absolute URL')],
    output: 'Page title and final URL', verify: 'read-back', requiresNodeCapability: 'browser-automation',
  }),
  cap({
    id: 'browser.read', name: 'Read the page', category: 'browser', surface: 'browser',
    description: 'Extracts visible text and console errors from the current page.',
    risk: 'low', permissions: ['network.outbound'],
    output: 'Text content and console errors', verify: null, requiresNodeCapability: 'browser-automation',
  }),
  cap({
    id: 'browser.click', name: 'Click an element', category: 'browser', surface: 'browser',
    description: 'Clicks the element matching a selector.',
    risk: 'medium', permissions: ['network.outbound'],
    input: [f('selector', 'string', true, 'CSS or text selector')],
    output: 'Resulting URL', verify: null, requiresNodeCapability: 'browser-automation',
  }),
  cap({
    id: 'browser.type', name: 'Fill a field', category: 'browser', surface: 'browser',
    description: 'Types into the element matching a selector.',
    risk: 'medium', permissions: ['network.outbound'],
    input: [f('selector', 'string', true, 'CSS selector'), f('text', 'string', true, 'Text to enter')],
    output: 'Field value', verify: null, requiresNodeCapability: 'browser-automation',
  }),
  cap({
    id: 'browser.screenshot', name: 'Capture the page', category: 'browser', surface: 'browser',
    description: 'Screenshots the current page for visual verification.',
    risk: 'low', permissions: ['network.outbound'],
    output: 'Image path', verify: null, requiresNodeCapability: 'browser-automation',
  }),
];

/* ══════════════════════════════════════════════════════════════════ */

export const CAPABILITY_MANIFEST: CapabilityDescriptor[] = [
  ...INTERNAL,
  ...LOCAL,
  ...EXTENSION_POINTS,
];

const BY_ID = new Map(CAPABILITY_MANIFEST.map((c) => [c.id, c]));

export function describeFabricCapability(id: string): CapabilityDescriptor | undefined {
  return BY_ID.get(id);
}
