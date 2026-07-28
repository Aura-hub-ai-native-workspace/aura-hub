/**
 * Starter templates — real, runnable engineering workflows.
 * ==================================================================
 * Every template executes against the currently open project using the
 * frozen Coding + FullStack engines, Project Memory and Groq. No demo
 * nodes: instantiating a template gives a working graph immediately.
 */

import type { WfEdge, WfNode, WfNodeType, Workflow } from './types';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  nodes: WfNode[];
  edges: WfEdge[];
}

const N = (id: string, type: WfNodeType, x: number, y: number, config: Record<string, unknown> = {}): WfNode => ({ id, type, x, y, config });
const E = (from: string, to: string, fromPort = 'out'): WfEdge => ({ id: `e-${from}-${fromPort}-${to}`, from, fromPort, to });

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'architecture-review',
    name: 'Architecture Review',
    description: 'Profiles the project, pulls the system graph and key code, and writes a structured architecture review into memory.',
    category: 'Review',
    nodes: [
      N('proj', 'current-project', 40, 160),
      N('fs', 'fullstack-engine', 320, 60, { query: 'architecture layers services endpoints database' }),
      N('code', 'coding-engine', 320, 260, { query: 'entry point main module architecture' }),
      N('md', 'generate-markdown', 620, 160, { instruction: 'Write an architecture review of this project: layering, boundaries, coupling, risks, and 3 concrete improvements.' }),
      N('mem', 'save-memory', 920, 60, { kind: 'decision', title: 'Architecture review' }),
      N('out', 'output', 920, 260, { title: 'Architecture review' }),
    ],
    edges: [E('proj', 'fs'), E('proj', 'code'), E('fs', 'md'), E('code', 'md'), E('md', 'mem'), E('md', 'out')],
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Reviews the real uncommitted diff with related code context.',
    category: 'Review',
    nodes: [
      N('diff', 'git-diff', 40, 60),
      N('code', 'coding-engine', 40, 260, { query: 'related modules of the changed code' }),
      N('md', 'generate-markdown', 360, 160, { instruction: 'Review this diff like a senior engineer: correctness, naming, edge cases, and anything risky. Cite files and lines.' }),
      N('out', 'output', 680, 160, { title: 'Code review' }),
    ],
    edges: [E('diff', 'md'), E('code', 'md'), E('md', 'out')],
  },
  {
    id: 'bug-investigation',
    name: 'Bug Investigation',
    description: 'Describe a bug; the engines gather suspect code and system paths, Groq proposes root causes.',
    category: 'Debug',
    nodes: [
      N('ask', 'user-input', 40, 160, { prompt: 'Describe the bug', default: '' }),
      N('code', 'coding-engine', 320, 60),
      N('fs', 'fullstack-engine', 320, 260),
      N('prompt', 'prompt', 620, 160, { template: 'Bug report: {{input}}\n\nInvestigate: likely root causes ranked, the exact code paths involved, and how to verify each hypothesis.' }),
      N('ai', 'groq', 900, 160),
      N('mem', 'save-memory', 1180, 60, { kind: 'learning', title: 'Bug investigation' }),
      N('out', 'output', 1180, 260, { title: 'Investigation' }),
    ],
    edges: [E('ask', 'code'), E('ask', 'fs'), E('code', 'prompt'), E('fs', 'prompt'), E('prompt', 'ai'), E('ai', 'mem'), E('ai', 'out')],
  },
  {
    id: 'generate-documentation',
    name: 'Generate Documentation',
    description: 'Generates real documentation from the project profile and code, saved as a note.',
    category: 'Docs',
    nodes: [
      N('proj', 'current-project', 40, 160),
      N('code', 'coding-engine', 320, 160, { query: 'public API exported functions modules usage' }),
      N('md', 'generate-markdown', 620, 160, { instruction: 'Write developer documentation: what this project does, how it is structured, and how to use its main modules.' }),
      N('note', 'create-note', 920, 60, { title: 'Generated documentation' }),
      N('out', 'output', 920, 260, { title: 'Documentation' }),
    ],
    edges: [E('proj', 'code'), E('code', 'md'), E('md', 'note'), E('md', 'out')],
  },
  {
    id: 'refactor-module',
    name: 'Refactor Module',
    description: 'Name a module; get a refactor plan with concrete code from its real source.',
    category: 'Engineering',
    nodes: [
      N('ask', 'user-input', 40, 160, { prompt: 'Which module should be refactored?' }),
      N('code', 'coding-engine', 320, 160, { limit: 8 }),
      N('gen', 'generate-code', 620, 160, { instruction: 'Propose a refactor of this module: name the smells, then show the refactored code.' }),
      N('out', 'output', 920, 160, { title: 'Refactor plan' }),
    ],
    edges: [E('ask', 'code'), E('code', 'gen'), E('gen', 'out')],
  },
  {
    id: 'generate-unit-tests',
    name: 'Generate Unit Tests',
    description: 'Generates unit tests for a module from its real source code.',
    category: 'Engineering',
    nodes: [
      N('ask', 'user-input', 40, 160, { prompt: 'Which module/file needs tests?' }),
      N('code', 'coding-engine', 320, 160, { limit: 8 }),
      N('gen', 'generate-code', 620, 160, { instruction: 'Write thorough unit tests for the code below: happy paths, edge cases, and failure modes.' }),
      N('out', 'output', 920, 160, { title: 'Unit tests' }),
    ],
    edges: [E('ask', 'code'), E('code', 'gen'), E('gen', 'out')],
  },
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Audits auth, secrets and input handling; critical findings are saved to memory.',
    category: 'Review',
    nodes: [
      N('code', 'coding-engine', 40, 60, { query: 'auth token secret password env validation input sanitize' }),
      N('fs', 'fullstack-engine', 40, 260, { query: 'auth guard endpoint middleware database' }),
      N('md', 'generate-markdown', 340, 160, { instruction: 'Security audit: secrets handling, authentication/authorization, input validation, injection risks. Mark each finding LOW/MEDIUM/HIGH/CRITICAL.' }),
      N('cond', 'condition', 640, 160, { check: 'matches-regex', value: 'HIGH|CRITICAL' }),
      N('mem', 'save-memory', 920, 60, { kind: 'decision', title: 'Security findings' }),
      N('out', 'output', 920, 260, { title: 'Security audit' }),
    ],
    edges: [E('code', 'md'), E('fs', 'md'), E('md', 'cond'), E('cond', 'mem', 'true'), E('cond', 'out', 'true'), E('cond', 'out', 'false')],
  },
  {
    id: 'dependency-analysis',
    name: 'Dependency Analysis',
    description: 'Reads the real manifest and produces a structured JSON dependency assessment.',
    category: 'Engineering',
    nodes: [
      N('files', 'selected-files', 40, 160, { paths: 'package.json' }),
      N('json', 'generate-json', 340, 160, { instruction: 'Assess the dependencies: {"dependencies":[{"name":"...","purpose":"...","risk":"low|medium|high","note":"..."}]}' }),
      N('out', 'output', 640, 160, { title: 'Dependency analysis' }),
    ],
    edges: [E('files', 'json'), E('json', 'out')],
  },
  {
    id: 'explain-project',
    name: 'Explain Project',
    description: 'The canonical chain: Project → Memory → Coding KE → FullStack KE → Groq → saved answer.',
    category: 'Docs',
    nodes: [
      N('proj', 'current-project', 40, 160),
      N('mem', 'project-memory', 320, 40),
      N('code', 'coding-engine', 320, 160),
      N('fs', 'fullstack-engine', 320, 280),
      N('prompt', 'prompt', 620, 160, { template: 'Explain this project to a new engineer: what it is, how it works, and where to start reading.\n\n{{input}}' }),
      N('ai', 'groq', 900, 160),
      N('save', 'save-memory', 1180, 60, { kind: 'learning', title: 'Project explanation' }),
      N('out', 'output', 1180, 260, { title: 'Project explanation' }),
    ],
    edges: [E('proj', 'mem'), E('proj', 'code'), E('proj', 'fs'), E('mem', 'prompt'), E('code', 'prompt'), E('fs', 'prompt'), E('prompt', 'ai'), E('ai', 'save'), E('ai', 'out')],
  },
  {
    id: 'release-notes',
    name: 'Release Notes',
    description: 'Turns the real recent git history into human release notes.',
    category: 'Docs',
    nodes: [
      N('log', 'shell-command', 40, 160, { command: 'git log --oneline -n 25' }),
      N('md', 'generate-markdown', 340, 160, { instruction: 'Turn this commit history into release notes: group by theme, highlight breaking changes, plain language.' }),
      N('note', 'create-note', 640, 60, { title: 'Release notes' }),
      N('out', 'output', 640, 260, { title: 'Release notes' }),
    ],
    edges: [E('log', 'md'), E('md', 'note'), E('md', 'out')],
  },
];

export function instantiateTemplate(id: string): Partial<Workflow> | null {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  return {
    name: t.name,
    description: t.description,
    category: t.category,
    nodes: t.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: t.edges.map((e) => ({ ...e })),
  };
}
