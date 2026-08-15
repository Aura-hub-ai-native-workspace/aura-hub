/**
 * Node schema registry — the orchestration vocabulary.
 * ==================================================================
 * One static `NodeSchema` per `WorkflowNodeType`: category, label,
 * description, typed input/output ports (§9) and config field metadata
 * for the future inspector. This is metadata about KINDS of steps —
 * it is not a tool catalogue.
 *
 * The one TOOLS node (`capability`) is deliberately generic: which
 * capabilities are actually available comes from the Fabric manifest
 * (`CAPABILITY_MANIFEST` in @aura/capability-fabric), and which nodes
 * can serve them comes from the Connected Environment catalogue. No
 * tool list is hardcoded here, so this package can never drift from
 * what AURA can actually do. `knownCapabilities()` exists for the
 * validator; the host may pass a narrower set.
 */

import { CAPABILITY_MANIFEST } from '@aura/capability-fabric';
import type { ConfigFieldSpec, NodeSchema, PortSpec, WorkflowNodeType } from './types';

/* ── port helpers ─────────────────────────────────────────────────── */

const port = (id: string, label: string, type: PortSpec['type'], extra: Partial<PortSpec> = {}): PortSpec => ({ id, label, type, ...extra });
const input = (id = 'in', label = 'Input', type: PortSpec['type'] = 'any', extra: Partial<PortSpec> = {}): PortSpec => port(id, label, type, extra);
const output = (id = 'out', label = 'Output', type: PortSpec['type'] = 'any', extra: Partial<PortSpec> = {}): PortSpec => port(id, label, type, extra);

/* ── config field helpers ─────────────────────────────────────────── */

const field = (key: string, label: string, kind: ConfigFieldSpec['kind'], extra: Partial<ConfigFieldSpec> = {}): ConfigFieldSpec => ({ key, label, kind, ...extra });

const triggerOut = (): PortSpec[] => [output('out', 'Trigger payload', 'object', { description: 'The event that started the run' })];

const schema = (
  type: WorkflowNodeType,
  category: NodeSchema['category'],
  label: string,
  icon: string,
  description: string,
  cfg: {
    inputs?: PortSpec[];
    outputs?: PortSpec[];
    config?: ConfigFieldSpec[];
    defaultRisk?: NodeSchema['defaultRisk'];
  } = {},
): NodeSchema => ({
  type,
  category,
  label,
  icon,
  description,
  inputs: cfg.inputs ?? [],
  outputs: cfg.outputs ?? [],
  config: cfg.config ?? [],
  defaultRisk: cfg.defaultRisk,
});

/* ── the registry ─────────────────────────────────────────────────── */

export const NODE_SCHEMAS: Record<WorkflowNodeType, NodeSchema> = {
  /* ══ TRIGGERS ═══════════════════════════════════════════════════ */

  manual: schema('manual', 'trigger', 'Manual', '▸', 'Starts the run from the Run button.', {
    inputs: [],
    outputs: triggerOut(),
    config: [field('reason', 'Reason', 'text', { placeholder: 'e.g. Release check' })],
  }),

  schedule: schema('schedule', 'trigger', 'Schedule', '◷', 'Starts the run on a cron schedule.', {
    inputs: [],
    outputs: triggerOut(),
    config: [
      field('cron', 'Cron expression', 'text', { required: true, placeholder: '0 9 * * 1-5' }),
      field('timezone', 'Timezone (optional)', 'text', { placeholder: 'UTC' }),
    ],
  }),

  'git-event': schema('git-event', 'trigger', 'Git Event', '⑂', 'Starts when a git event happens in the project.', {
    inputs: [],
    outputs: triggerOut(),
    config: [
      field('events', 'Events', 'select', {
        required: true,
        options: ['push', 'commit', 'branch', 'merge', 'tag'],
        help: 'Multi-select in the inspector; at least one required',
      }),
      field('branch', 'Branch filter (optional)', 'text', { placeholder: 'main' }),
    ],
  }),

  'file-change': schema('file-change', 'trigger', 'File Change', '≋', 'Starts when files under the project change.', {
    inputs: [],
    outputs: triggerOut(),
    config: [
      field('paths', 'Paths', 'textarea', { placeholder: 'src/\npackage.json' }),
      field('match', 'Name pattern (optional)', 'text', { placeholder: '*.ts' }),
    ],
  }),

  'mission-event': schema('mission-event', 'trigger', 'Mission Event', '◆', 'Starts when a mission changes state.', {
    inputs: [],
    outputs: triggerOut(),
    config: [
      field('events', 'Events', 'select', {
        required: true,
        options: ['created', 'approved', 'started', 'completed', 'failed'],
      }),
      field('missionId', 'Mission id (optional)', 'text'),
    ],
  }),

  'agent-event': schema('agent-event', 'trigger', 'Agent Event', '⚙', 'Starts when a coding agent finishes (or fails).', {
    inputs: [],
    outputs: triggerOut(),
    config: [
      field('events', 'Events', 'select', {
        required: true,
        options: ['started', 'completed', 'failed'],
      }),
      field('agentId', 'Agent (optional)', 'text', { placeholder: 'opencode' }),
    ],
  }),

  'environment-event': schema('environment-event', 'trigger', 'Environment Event', '⌁', 'Starts when a connected node appears or disappears.', {
    inputs: [],
    outputs: triggerOut(),
    config: [
      field('events', 'Events', 'select', {
        required: true,
        options: ['connected', 'disconnected', 'changed'],
      }),
      field('nodeIds', 'Nodes', 'textarea', { placeholder: 'git\nnode' }),
    ],
  }),

  /* ══ AI ═════════════════════════════════════════════════════════ */

  'ask-aura': schema('ask-aura', 'ai', 'Ask AURA', '✦', 'A free-form AURA answer from the provider seam.', {
    inputs: [input()],
    outputs: [output('out', 'Answer', 'object')],
    config: [
      field('prompt', 'Prompt', 'textarea', { required: true, placeholder: 'Analyze the latest changes' }),
      field('providerId', 'Provider', 'text', { help: 'Optional; the active provider is used by default' }),
      field('model', 'Model', 'text'),
      field('temperature', 'Temperature', 'number', { default: 0.7 }),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 60_000 }),
    ],
    defaultRisk: 'low',
  }),

  agent: schema('agent', 'ai', 'AI Agent', '✧', 'Delegates a task to a coding agent through agent.delegate.', {
    inputs: [input()],
    outputs: [output('out', 'Agent report', 'object')],
    config: [
      field('task', 'Task', 'textarea', { required: true, placeholder: 'Fix the failing test in src/…' }),
      field('model', 'Model override (optional)', 'text'),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 300_000 }),
    ],
    defaultRisk: 'high',
  }),

  analyze: schema('analyze', 'ai', 'Analyze', '⋔', 'Structured analysis of the input (findings, risks, notes).', {
    inputs: [input()],
    outputs: [output('out', 'Analysis', 'object')],
    config: [
      field('prompt', 'What to look for', 'textarea', { placeholder: 'Correctness, naming, edge cases' }),
      field('providerId', 'Provider', 'text'),
      field('model', 'Model', 'text'),
      field('temperature', 'Temperature', 'number', { default: 0.3 }),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 60_000 }),
    ],
    defaultRisk: 'low',
  }),

  summarize: schema('summarize', 'ai', 'Summarize', '§', 'A concise summary of the input.', {
    inputs: [input()],
    outputs: [output('out', 'Summary', 'string')],
    config: [
      field('prompt', 'Angle (optional)', 'text', { placeholder: 'For a new contributor' }),
      field('providerId', 'Provider', 'text'),
      field('model', 'Model', 'text'),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 60_000 }),
    ],
    defaultRisk: 'low',
  }),

  generate: schema('generate', 'ai', 'Generate', '✎', 'Generated text, code or document from the input.', {
    inputs: [input()],
    outputs: [output('out', 'Generated', 'string')],
    config: [
      field('instruction', 'Instruction', 'textarea', { required: true, placeholder: 'Unit tests for the module below' }),
      field('format', 'Format', 'select', { options: ['text', 'markdown', 'code', 'json'], default: 'markdown' }),
      field('providerId', 'Provider', 'text'),
      field('model', 'Model', 'text'),
      field('temperature', 'Temperature', 'number', { default: 0.5 }),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 60_000 }),
    ],
    defaultRisk: 'low',
  }),

  classify: schema('classify', 'ai', 'Classify', '▦', 'Labels the input: { label, confidence }.', {
    inputs: [input()],
    outputs: [output('out', 'Classification', 'object')],
    config: [
      field('labels', 'Labels', 'textarea', { required: true, placeholder: 'bug\nfeature\nmaintenance' }),
      field('providerId', 'Provider', 'text'),
      field('model', 'Model', 'text'),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 60_000 }),
    ],
    defaultRisk: 'low',
  }),

  decide: schema('decide', 'ai', 'Decide', '◉', 'A recommendation with rationale: { decision, rationale }.', {
    inputs: [input()],
    outputs: [output('out', 'Decision', 'object')],
    config: [
      field('question', 'Question', 'textarea', { required: true, placeholder: 'Should we proceed with the release?' }),
      field('providerId', 'Provider', 'text'),
      field('model', 'Model', 'text'),
      field('temperature', 'Temperature', 'number', { default: 0.2 }),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 60_000 }),
    ],
    defaultRisk: 'low',
  }),

  /* ══ TOOLS ══════════════════════════════════════════════════════ */

  capability: schema('capability', 'tool', 'Capability', '⌘', 'Any Fabric capability — the manifest is the catalogue.', {
    inputs: [input()],
    outputs: [output('out', 'Result', 'any')],
    config: [
      field('capabilityId', 'Capability', 'text', { required: true, placeholder: 'terminal.execute' }),
      field('inputMap', 'Input mapping (expressions per field)', 'textarea', {
        placeholder: 'command: npm test\npath: {{trigger.branch}}',
        help: 'One "key: {{expression}}" per line',
      }),
      field('nodeId', 'Node (routing intent, optional)', 'text', { placeholder: 'git' }),
    ],
    defaultRisk: 'medium',
  }),

  /* ══ CONTROL ════════════════════════════════════════════════════ */

  condition: schema('condition', 'control', 'Condition', '◇', 'Routes to true/false from a real check of the input.', {
    inputs: [input()],
    outputs: [output('true', 'True', 'any'), output('false', 'False', 'any')],
    config: [
      field('op', 'Operator', 'select', {
        required: true,
        options: ['contains', 'not-contains', 'matches-regex', 'equals', 'not-equals', 'longer-than', 'is-empty', 'gt', 'lt'],
        default: 'contains',
      }),
      field('value', 'Value / pattern', 'expression', { placeholder: '{{nodes.risk.out.risk}}' }),
      field('field', 'Input path (optional)', 'expression', {
        placeholder: '{{nodes.ask-aura.out.summary}}',
        help: 'Defaults to the whole input',
      }),
    ],
    defaultRisk: 'low',
  }),

  branch: schema('branch', 'control', 'Branch', '⫸', 'Explicit two-way branch (same semantics as condition, no check).', {
    inputs: [input()],
    outputs: [output('true', 'Yes', 'any'), output('false', 'No', 'any')],
    config: [
      field('condition', 'Condition', 'expression', {
        required: true,
        placeholder: '{{nodes.analyze.out.risk}} == high',
        help: 'A constrained expression; see the expression reference',
      }),
    ],
    defaultRisk: 'low',
  }),

  switch: schema('switch', 'control', 'Switch', '⫪', 'Routes to case-N for the matching case, else default.', {
    inputs: [input()],
    outputs: [output('default', 'Default', 'any')],
    config: [
      field('field', 'Value path', 'expression', { required: true, placeholder: '{{nodes.classify.out.label}}' }),
      field('cases', 'Cases', 'textarea', { placeholder: 'bug\nfeature\nmaintenance' }),
    ],
    defaultRisk: 'low',
  }),

  loop: schema('loop', 'control', 'Loop', '↻', 'Repeats the each branch N times, then fires done.', {
    inputs: [input()],
    outputs: [output('each', 'Each iteration', 'any'), output('done', 'Done', 'any')],
    config: [field('times', 'Times', 'number', { default: 3 })],
    defaultRisk: 'low',
  }),

  'for-each': schema('for-each', 'control', 'For Each', '↺', 'Runs the each branch once per input item, then done.', {
    inputs: [input('in', 'Items', 'array')],
    outputs: [output('each', 'Each item', 'any'), output('done', 'Done', 'any')],
    config: [],
    defaultRisk: 'low',
  }),

  parallel: schema('parallel', 'control', 'Parallel', '⫴', 'Fires every branch-N in parallel; all fires when all finish.', {
    inputs: [input()],
    outputs: [output('all', 'All done', 'any')],
    config: [field('branchCount', 'Branches', 'number', { default: 2 })],
    defaultRisk: 'low',
  }),

  delay: schema('delay', 'control', 'Delay', '◔', 'Waits a bounded time, then passes the input through.', {
    inputs: [input()],
    outputs: [output()],
    config: [field('ms', 'Milliseconds', 'number', { default: 1000 })],
    defaultRisk: 'low',
  }),

  retry: schema('retry', 'control', 'Retry', '↻', 'Re-runs the retried branch on failure; failed fires when attempts are spent.', {
    inputs: [input()],
    outputs: [output('out', 'Retried', 'any'), output('failed', 'Failed', 'any')],
    config: [
      field('maxAttempts', 'Max attempts', 'number', { default: 3 }),
      field('delayMs', 'Retry delay (ms)', 'number', { default: 500 }),
      field('backoffFactor', 'Backoff factor', 'number', { default: 2 }),
    ],
    defaultRisk: 'low',
  }),

  timeout: schema('timeout', 'control', 'Timeout', '◷', 'Bounded execution; timed-out fires when the budget is spent.', {
    inputs: [input()],
    outputs: [output('out', 'Completed', 'any'), output('timed-out', 'Timed out', 'any')],
    config: [field('ms', 'Budget (ms)', 'number', { default: 30_000 })],
    defaultRisk: 'low',
  }),

  merge: schema('merge', 'control', 'Merge', '⫴', 'Joins several upstream values into one.', {
    inputs: [input('in', 'Input', 'any', { multiple: true })],
    outputs: [output()],
    config: [],
    defaultRisk: 'low',
  }),

  /* ══ MISSION ════════════════════════════════════════════════════ */

  'create-mission': schema('create-mission', 'mission', 'Create Mission', '◆', 'Plans a new mission from the input objective.', {
    inputs: [input()],
    outputs: [output('out', 'Mission', 'object')],
    config: [field('text', 'Objective (optional)', 'textarea', { placeholder: 'Falls back to the input' })],
    defaultRisk: 'low',
  }),

  'update-mission': schema('update-mission', 'mission', 'Update Mission', '✚', 'Updates a mission (notes, state).', {
    inputs: [input()],
    outputs: [output('out', 'Mission', 'object')],
    config: [field('missionId', 'Mission id', 'expression', { required: true, placeholder: '{{nodes.create-mission.out.id}}' })],
    defaultRisk: 'low',
  }),

  'run-mission': schema('run-mission', 'mission', 'Run Mission', '▶', 'Starts an approved mission execution.', {
    inputs: [input()],
    outputs: [output('out', 'Mission', 'object')],
    config: [field('missionId', 'Mission id', 'expression', { required: true, placeholder: '{{nodes.create-mission.out.id}}' })],
    defaultRisk: 'medium',
  }),

  'wait-mission': schema('wait-mission', 'mission', 'Wait for Mission', '◷', 'Pauses until a mission reaches a state.', {
    inputs: [input()],
    outputs: [output('out', 'Mission', 'object')],
    config: [
      field('missionId', 'Mission id', 'expression', { required: true }),
      field('until', 'Until', 'select', { required: true, options: ['completed', 'failed', 'approved', 'started'], default: 'completed' }),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 600_000 }),
    ],
    defaultRisk: 'low',
  }),

  'mission-approval': schema('mission-approval', 'mission', 'Mission Approval', '⚠', 'A human gate for a mission plan.', {
    inputs: [input()],
    outputs: [output('approved', 'Approved', 'any'), output('rejected', 'Rejected', 'any')],
    config: [field('missionId', 'Mission id', 'expression', { required: true })],
    defaultRisk: 'medium',
  }),

  /* ══ OUTPUT ═════════════════════════════════════════════════════ */

  notification: schema('notification', 'output', 'Notification', '◉', 'Surfaces a message to the user.', {
    inputs: [input()],
    outputs: [],
    config: [field('message', 'Message', 'expression', { required: true, placeholder: 'Deploy finished: {{nodes.deploy.out.status}}' })],
    defaultRisk: 'low',
  }),

  log: schema('log', 'output', 'Log', '≡', 'Writes to the run log and passes the input through.', {
    inputs: [input()],
    outputs: [output()],
    config: [field('message', 'Message', 'expression', { placeholder: 'Checkpoint reached' })],
    defaultRisk: 'low',
  }),

  result: schema('result', 'output', 'Result', '□', 'A workflow result, shown in the run panel.', {
    inputs: [input()],
    outputs: [],
    config: [field('title', 'Title', 'text', { default: 'Result' })],
    defaultRisk: 'low',
  }),

  export: schema('export', 'output', 'Export', '⇩', 'Writes the input to a file inside the project root.', {
    inputs: [input()],
    outputs: [],
    config: [
      field('path', 'Relative path', 'text', { required: true, placeholder: 'docs/REPORT.md' }),
      field('template', 'Content template (optional)', 'textarea', { placeholder: 'Falls back to the raw input' }),
    ],
    defaultRisk: 'medium',
  }),

  approval: schema('approval', 'output', 'Approval', '⚠', 'Pauses the run until a human approves or rejects.', {
    inputs: [input()],
    outputs: [output('approved', 'Approved', 'any'), output('rejected', 'Rejected', 'any')],
    config: [
      field('summary', 'What is being approved', 'expression', { required: true, placeholder: 'Delete 43 generated files' }),
      field('detail', 'Detail', 'expression'),
    ],
    defaultRisk: 'medium',
  }),
};

/** UI-safe metadata (no functions, no runtime). */
export function nodeSchemaInfos(): NodeSchema[] {
  return Object.values(NODE_SCHEMAS);
}

/** All manifest capability ids — the default tool catalogue. */
export function knownCapabilities(): Set<string> {
  return new Set(CAPABILITY_MANIFEST.map((c) => c.id));
}

export function schemaOf(type: WorkflowNodeType): NodeSchema | undefined {
  return NODE_SCHEMAS[type];
}