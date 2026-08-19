/**
 * Workflow types — AI-native engineering automations.
 * ==================================================================
 * A workflow is a directed graph of production nodes executed by the
 * environment against the currently open REAL project, orchestrating the
 * frozen engines (Coding KE, FullStack KE, Memory, Intent, Enhancer,
 * Groq) through their public seams. Nothing here duplicates pipeline
 * logic — nodes call the same engines the AI workspace uses.
 */

export type NodeCategory = 'source' | 'intelligence' | 'generate' | 'logic' | 'action' | 'io';

export type WfNodeType =
  // source — real project data
  | 'current-project'
  | 'selected-files'
  | 'changed-files'
  | 'current-conversation'
  | 'project-memory'
  | 'engineering-memory'
  // intelligence — frozen engines
  | 'coding-engine'
  | 'fullstack-engine'
  | 'research-engine' // disabled until the Research Engine exists
  | 'intent-classifier'
  | 'prompt-enhancer'
  // generate — Groq through the frozen provider seam
  | 'prompt'
  | 'groq'
  | 'generate-markdown'
  | 'generate-code'
  | 'generate-json'
  // logic
  | 'condition'
  | 'loop'
  | 'delay'
  | 'variables'
  | 'user-input'
  // action — real effects
  | 'save-memory'
  | 'create-note'
  | 'export-file'
  | 'shell-command'
  | 'git-status'
  | 'git-diff'
  | 'git-commit'
  | 'git-branch'
  | 'http-request'
  | 'slack-notify'
  // io
  | 'output';

export interface WfNode {
  id: string;
  type: WfNodeType;
  x: number;
  y: number;
  /** Per-node settings, edited in the inspector. Shape per NodeSpec.fields. */
  config: Record<string, unknown>;
}

export interface WfEdge {
  id: string;
  from: string;
  /** Output port on the source node ('out' | 'true' | 'false' | 'each' | 'done'). */
  fromPort: string;
  to: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  category: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: WfNode[];
  edges: WfEdge[];
  /** Lazily generated on first request (see WorkflowStore.ensureWebhookToken) — lets an external system (e.g. GitHub's own webhook config) start a run without AURA needing an API client for that system. Never included in list responses. */
  webhookToken?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

/* ── execution ─────────────────────────────────────────────────────── */

export type NodeRunState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';

/** The value flowing along an edge. */
export interface NodeIO {
  text: string;
  data?: unknown;
  files?: string[];
}

export type RunEvent =
  | { type: 'start'; workflowId: string; at: string }
  | { type: 'node'; nodeId: string; status: NodeRunState; ms?: number; summary?: string; error?: string }
  | { type: 'log'; nodeId: string | null; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'output'; nodeId: string; title: string; text: string }
  | { type: 'done'; status: 'completed' | 'failed'; ms: number; error?: string };

/** The run summary returned to the caller (kept from the legacy engine so
 *  the bridge's SSE contract is unchanged). */
export interface RunResult {
  status: 'completed' | 'failed';
  ms: number;
  outputs: { nodeId: string; title: string; text: string }[];
  nodes: Record<string, { status: NodeRunState; ms: number }>;
  error?: string;
}

/** Field metadata so the inspector renders real controls per node type. */
export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'boolean';
  options?: string[];
  placeholder?: string;
  default?: unknown;
  help?: string;
}

/** UI-facing node spec (the runtime `run` stays server-side). */
export interface NodeSpecInfo {
  type: WfNodeType;
  label: string;
  category: NodeCategory;
  description: string;
  /** Input port count: 0 (entry), 1, or 'many' (merges upstream text). */
  inputs: 0 | 1 | 'many';
  /** Named output ports; [] for terminal nodes. */
  outputs: string[];
  disabled?: boolean;
  fields: FieldSpec[];
}

export const genId = (p = 'wf') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
