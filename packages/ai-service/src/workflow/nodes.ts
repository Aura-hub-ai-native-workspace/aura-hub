/**
 * Node registry — every production node type and its real runtime.
 * ==================================================================
 * Nodes orchestrate the FROZEN systems through their public seams:
 * Coding KE / FullStack KE retrieval, Project Memory recall+save, the
 * Intent Classifier + Prompt Enhancer stages, and Groq via the frozen
 * ProviderAdapter (through PipelineManager.generate). No engine logic is
 * duplicated here — nodes only call and combine.
 *
 * Effects are sandboxed: notes are written under the AURA home, file
 * exports resolve inside the project root only, and the shell node runs
 * an allow-listed binary with plain args (no shell interpretation).
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KeywordIntentClassifier, TemplatePromptEnhancer, createRequest } from '@aura/intelligence';
import { engineeringMemory } from '@aura/engineering-memory';
import type { PipelineManager } from '../pipeline';
import { ProjectConversations } from '../conversations';
import { loadProfile } from '../profile';
import { homePath } from '../persist';
import type { FieldSpec, NodeCategory, NodeIO, NodeSpecInfo, WfNodeType } from './types';
import { git as sharedGit, safeShell as sharedSafeShell, type ProcessOutput } from '../exec/process';

export interface RunCtx {
  projectId: string;
  projectPath: string;
  projectName: string;
  pipeline: PipelineManager;
  vars: Record<string, string>;
  /** Values supplied for user-input nodes before the run. */
  runInputs: Record<string, string>;
  log: (level: 'info' | 'warn' | 'error', text: string) => void;
  signal?: AbortSignal;
}

export interface NodeResult extends NodeIO {
  /** Which output port fires (default 'out'). */
  port?: string;
  /** Short human summary shown on the node after completion. */
  summary?: string;
}

export interface NodeSpec extends NodeSpecInfo {
  run: (ctx: RunCtx, input: NodeIO, config: Record<string, unknown>) => Promise<NodeResult>;
}

/* ── helpers ───────────────────────────────────────────────────────── */

const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const clip = (t: string, max = 60) => (t.length > max ? t.slice(0, max - 1) + '…' : t);

/** {{input}}, {{project}}, and {{NAME}} (variables) interpolation. */
function interpolate(template: string, ctx: RunCtx, input: NodeIO): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    if (key === 'input') return input.text;
    if (key === 'project') return ctx.projectName;
    return ctx.vars[key] ?? '';
  });
}

/** Resolve a user path INSIDE the project root; rejects escapes. */
function insideProject(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes the project: ${rel}`);
  return abs;
}

/*
 * The spawn primitives moved to `../exec/process` so the Workflow Engine
 * and the Capability Fabric share ONE hardened path to a child process.
 * Behaviour is identical; these thin wrappers keep the call sites in this
 * file unchanged by adapting `RunCtx` to the shared options shape.
 */
function git(ctx: RunCtx, args: string[]): Promise<ProcessOutput> {
  return sharedGit(args, { cwd: ctx.projectPath, signal: ctx.signal });
}

function safeShell(ctx: RunCtx, command: string): Promise<string> {
  return sharedSafeShell(command, { cwd: ctx.projectPath, signal: ctx.signal });
}

export async function runGit(projectPath: string, args: string[], opts?: { signal?: AbortSignal }): Promise<ProcessOutput> {
  return sharedGit(args, { cwd: projectPath, signal: opts?.signal });
}

const MAX_HTTP_RESPONSE = 512 * 1024; // enough for a real API response, not enough to hang a run on a large download

/** Real outbound fetch, bounded by timeout and response size. AURA is a single-user local desktop app (no multi-tenant boundary), so the proportionate safety measure here is the same bounded-timeout/maxBuffer pattern already used for git/shell above — not an IP allow/deny list, which would be solving a threat model that doesn't apply. */
async function sandboxedFetch(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ status: number; text: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
  const timeout = Math.max(1000, Math.min(30_000, opts.timeoutMs ?? 10_000));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  const onOuterAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const res = await fetch(url, { method: opts.method ?? 'GET', headers: opts.headers, body: opts.body, signal: ac.signal });
    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf.slice(0, MAX_HTTP_RESPONSE)).toString('utf8');
    return { status: res.status, text };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`request timed out after ${timeout}ms`);
    throw err;
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** `Key: Value` per line — real HTTP header syntax, distinct from the `variables` node's `KEY=value` convention. */
function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const sep = t.indexOf(':');
    if (sep <= 0) continue;
    headers[t.slice(0, sep).trim()] = t.slice(sep + 1).trim();
  }
  return headers;
}

async function generate(ctx: RunCtx, system: string, user: string, opts: { json?: boolean } = {}): Promise<string> {
  const res = await ctx.pipeline.generate({ system, user, json: opts.json }, ctx.signal);
  if (!res.ok) throw new Error(`${res.error.type}: ${res.error.message}`);
  return res.text;
}

const field = (key: string, label: string, kind: FieldSpec['kind'], extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind, ...extra });

/* ── registry ──────────────────────────────────────────────────────── */

function spec(
  type: WfNodeType,
  label: string,
  category: NodeCategory,
  description: string,
  cfg: { inputs?: 0 | 1 | 'many'; outputs?: string[]; disabled?: boolean; fields?: FieldSpec[] },
  run: NodeSpec['run'],
): NodeSpec {
  return { type, label, category, description, inputs: cfg.inputs ?? 1, outputs: cfg.outputs ?? ['out'], disabled: cfg.disabled, fields: cfg.fields ?? [], run };
}

export const NODE_SPECS: Record<WfNodeType, NodeSpec> = {
  /* ── source ─────────────────────────────────────────────────────── */

  'current-project': spec('current-project', 'Current Project', 'source', 'The real profile of the currently open project.', { inputs: 0 }, async (ctx) => {
    const p = loadProfile(ctx.projectId);
    if (!p) throw new Error('no profile for the open project');
    const text = [
      `Project: ${ctx.projectName}`,
      p.purpose ? `Purpose: ${p.purpose}` : '',
      `Type: ${p.type} · Language: ${p.primaryLanguage}`,
      p.frameworks.length ? `Frameworks: ${p.frameworks.join(', ')}` : '',
      p.entryPoints.length ? `Entry points: ${p.entryPoints.join(', ')}` : '',
      `Summary: ${p.summary}`,
    ].filter(Boolean).join('\n');
    return { text, data: p, summary: `${p.type} · ${p.primaryLanguage}` };
  }),

  'selected-files': spec('selected-files', 'Selected Files', 'source', 'Reads specific project files (relative paths, one per line).', {
    inputs: 0,
    fields: [field('paths', 'File paths', 'textarea', { placeholder: 'src/index.ts\nREADME.md' })],
  }, async (ctx, _input, config) => {
    const rels = s(config.paths).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!rels.length) throw new Error('no file paths configured');
    const parts: string[] = [];
    const files: string[] = [];
    for (const rel of rels) {
      const abs = insideProject(ctx.projectPath, rel);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile()) { ctx.log('warn', `skipping missing file: ${rel}`); continue; }
      if (st.size > 256 * 1024) { ctx.log('warn', `skipping large file (>256KB): ${rel}`); continue; }
      files.push(rel);
      parts.push(`===== ${rel} =====\n${readFileSync(abs, 'utf8')}`);
    }
    if (!files.length) throw new Error('none of the configured files exist');
    return { text: parts.join('\n\n'), files, summary: `${files.length} file${files.length === 1 ? '' : 's'}` };
  }),

  'changed-files': spec('changed-files', 'Changed Files (Git)', 'source', 'Files with uncommitted changes, from real git status.', { inputs: 0 }, async (ctx) => {
    const { out } = await git(ctx, ['status', '--porcelain']);
    const files = out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
    const text = files.length ? `Changed files:\n${files.map((f) => `- ${f}`).join('\n')}` : 'No uncommitted changes.';
    return { text, files, data: files, summary: `${files.length} changed` };
  }),

  'current-conversation': spec('current-conversation', 'Current Conversation', 'source', "The open project's most recent conversation.", {
    inputs: 0,
    fields: [field('turns', 'Turns to include', 'number', { default: 8 })],
  }, async (ctx, _input, config) => {
    const conv = new ProjectConversations(ctx.projectId);
    const latest = conv.list()[0];
    if (!latest) return { text: 'No conversations yet in this project.', summary: 'empty' };
    const c = conv.get(latest.id);
    const turns = (c?.messages ?? []).slice(-Math.max(1, Math.min(24, n(config.turns, 8))));
    const text = `Conversation "${latest.title}":\n` + turns.map((m) => `${m.role === 'user' ? 'User' : 'AURA'}: ${m.content}`).join('\n');
    return { text, summary: clip(latest.title, 40) };
  }),

  'project-memory': spec('project-memory', 'Project Memory', 'source', "Recalls this project's real memory (keyword + pin ranked).", {
    inputs: 'many',
    fields: [field('query', 'Recall query (falls back to input)', 'text'), field('limit', 'Items', 'number', { default: 5 })],
  }, async (ctx, input, config) => {
    const memory = ctx.pipeline.memory;
    if (!memory) throw new Error('no project mounted');
    const q = s(config.query) || input.text || ctx.projectName;
    const items = memory.recall(q, Math.max(1, Math.min(12, n(config.limit, 5))));
    const text = items.length ? items.map((m) => `[${m.kind}] ${m.title}: ${m.body}`).join('\n') : 'No relevant memory.';
    return { text, data: items, summary: `${items.length} recalled` };
  }),

  'engineering-memory': spec('engineering-memory', 'Engineering Memory', 'source', "Queries this project's Engineering Memory platform (missions, diagnoses, decisions, patches — richer than Project Memory).", {
    inputs: 0,
    fields: [field('limit', 'Items', 'number', { default: 10 })],
  }, async (ctx, _input, config) => {
    const records = engineeringMemory.queryProject(ctx.projectId);
    const limit = Math.max(1, Math.min(50, n(config.limit, 10)));
    const items = [...records].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
    const text = items.length
      ? items.map((r) => `[${r.category}] ${r.summary}${r.detailedRecord ? ` — ${clip(r.detailedRecord, 120)}` : ''}`).join('\n')
      : 'No engineering memory recorded for this project yet.';
    return { text, data: items, summary: `${items.length} record${items.length === 1 ? '' : 's'}` };
  }),

  /* ── intelligence (frozen engines) ──────────────────────────────── */

  'coding-engine': spec('coding-engine', 'Coding Knowledge Engine', 'intelligence', 'Retrieves real code context from the frozen Coding KE.', {
    inputs: 'many',
    fields: [field('query', 'Query (falls back to input)', 'text'), field('limit', 'Sources', 'number', { default: 6 })],
  }, async (ctx, input, config) => {
    const coding = ctx.pipeline.coding;
    if (!coding) throw new Error('no project mounted');
    const q = s(config.query) || input.text || 'project overview architecture entry point';
    const c = coding.getContext({ text: q, limit: 24 }, { limit: Math.max(1, Math.min(12, n(config.limit, 6))), neighbors: 1, maxTokens: 3000 });
    const text = c.entries.map((e) => `----- ${e.source} -----\n${e.chunks.map((ch) => ch.chunk.text).join('\n')}`).join('\n\n');
    return { text: text || 'No matching code found.', files: c.entries.map((e) => e.source), summary: `${c.entries.length} sources · ${c.totalTokens} tok` };
  }),

  'fullstack-engine': spec('fullstack-engine', 'FullStack Knowledge Engine', 'intelligence', 'Cross-layer system entities + relationships from the frozen FullStack KE.', {
    inputs: 'many',
    fields: [field('query', 'Query (falls back to input)', 'text'), field('limit', 'Hits', 'number', { default: 8 })],
  }, async (ctx, input, config) => {
    const fullstack = ctx.pipeline.fullstack;
    if (!fullstack) throw new Error('no project mounted');
    const q = s(config.query) || input.text || 'system architecture services endpoints database';
    const a = fullstack.search({ text: q, limit: Math.max(1, Math.min(16, n(config.limit, 8))) });
    const hits = a.hits.map((h) => `${h.entity.kind} [${h.entity.layer}] ${h.entity.name} (${h.entity.relPath})${h.entity.summary ? ` — ${h.entity.summary}` : ''}`);
    const chains = a.paths.filter((p) => p.entities.length >= 2).slice(0, 6).map((p) => {
      let line = p.entities[0].name;
      for (let i = 0; i < p.relations.length; i++) line += ` --${p.relations[i].kind}--> ${p.entities[i + 1]?.name ?? '?'}`;
      return line;
    });
    const text = [hits.length ? `System entities:\n${hits.join('\n')}` : 'No entities matched.', chains.length ? `\nRelationships:\n${chains.join('\n')}` : ''].join('\n');
    return { text, summary: `${a.hits.length} entities · ${chains.length} chains` };
  }),

  'research-engine': spec('research-engine', 'Research Engine', 'intelligence', 'Future module — disabled until the Research Engine is implemented.', { disabled: true, inputs: 'many' }, async () => {
    throw new Error('the Research Engine is not implemented yet');
  }),

  'intent-classifier': spec('intent-classifier', 'Intent Classifier', 'intelligence', "Classifies the input's intent via the frozen KeywordIntentClassifier.", {}, async (_ctx, input) => {
    const intent = await new KeywordIntentClassifier().classify(createRequest(input.text));
    return { text: input.text, data: intent, summary: `${intent.type} (${Math.round(intent.confidence * 100)}%)` };
  }),

  'prompt-enhancer': spec('prompt-enhancer', 'Prompt Enhancer', 'intelligence', 'Enhances the input via the frozen TemplatePromptEnhancer.', {}, async (_ctx, input) => {
    const classifier = new KeywordIntentClassifier();
    const req = createRequest(input.text);
    const intent = await classifier.classify(req);
    const prompt = await new TemplatePromptEnhancer().enhance(req, intent);
    return { text: prompt.enhanced, data: prompt, summary: clip(prompt.enhanced, 46) };
  }),

  /* ── generate (Groq via the frozen provider seam) ───────────────── */

  prompt: spec('prompt', 'Prompt', 'generate', 'A prompt template. {{input}}, {{project}} and {{VARIABLE}} interpolate.', {
    inputs: 'many',
    fields: [field('template', 'Template', 'textarea', { placeholder: 'Review this code:\n\n{{input}}' })],
  }, async (ctx, input, config) => {
    const template = s(config.template);
    if (!template.trim()) throw new Error('empty prompt template');
    const text = interpolate(template, ctx, input);
    return { text, summary: clip(text, 46) };
  }),

  groq: spec('groq', 'Groq', 'generate', 'Sends the input to Groq through the frozen provider. Upstream text becomes context.', {
    inputs: 'many',
    fields: [field('instruction', 'Instruction (optional, prepended)', 'textarea'), field('system', 'System prompt (optional)', 'textarea')],
  }, async (ctx, input, config) => {
    const user = [interpolate(s(config.instruction), ctx, input), input.text].filter(Boolean).join('\n\n');
    if (!user.trim()) throw new Error('nothing to send — connect an upstream node or set an instruction');
    const text = await generate(ctx, s(config.system) || `You are AURA, the project intelligence for "${ctx.projectName}". Answer strictly from the provided project material.`, user);
    return { text, summary: clip(text, 46) };
  }),

  'generate-markdown': spec('generate-markdown', 'Generate Markdown', 'generate', 'Groq generation constrained to a well-structured Markdown document.', {
    inputs: 'many',
    fields: [field('instruction', 'What to produce', 'textarea', { placeholder: 'An architecture review of this project' })],
  }, async (ctx, input, config) => {
    const ask = interpolate(s(config.instruction), ctx, input) || 'A clear, well-structured document about the material below.';
    const text = await generate(ctx, `You produce clean Markdown documents (headings, lists, code fences). Project: "${ctx.projectName}". Use ONLY the provided material.`, `${ask}\n\nMaterial:\n${input.text}`);
    return { text, summary: clip(text.replace(/[#*`\n]+/g, ' ').trim(), 46) };
  }),

  'generate-code': spec('generate-code', 'Generate Code', 'generate', 'Groq generation constrained to code output.', {
    inputs: 'many',
    fields: [field('instruction', 'What to generate', 'textarea', { placeholder: 'Unit tests for the module below' }), field('language', 'Language hint', 'text', { placeholder: 'typescript' })],
  }, async (ctx, input, config) => {
    const lang = s(config.language, 'the project language');
    const ask = interpolate(s(config.instruction), ctx, input) || 'Generate the most useful code for the material below.';
    const text = await generate(ctx, `You write production-quality ${lang} code. Reply with code in fenced blocks plus brief notes. Project: "${ctx.projectName}".`, `${ask}\n\nMaterial:\n${input.text}`);
    return { text, summary: clip(text.replace(/\s+/g, ' ').trim(), 46) };
  }),

  'generate-json': spec('generate-json', 'Generate JSON', 'generate', 'Groq generation validated as parseable JSON.', {
    inputs: 'many',
    fields: [field('instruction', 'Shape / task', 'textarea', { placeholder: '{"issues": [{"file": "...", "severity": "...", "note": "..."}]}' })],
  }, async (ctx, input, config) => {
    const ask = interpolate(s(config.instruction), ctx, input) || 'Summarize the material below as JSON.';
    const raw = await generate(ctx, 'You output ONLY valid JSON. No prose, no code fences.', `${ask}\n\nMaterial:\n${input.text}`, { json: true });
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let data: unknown;
    try { data = JSON.parse(cleaned); } catch { throw new Error('model did not return valid JSON'); }
    return { text: JSON.stringify(data, null, 2), data, summary: 'valid JSON' };
  }),

  /* ── logic ──────────────────────────────────────────────────────── */

  condition: spec('condition', 'Condition', 'logic', 'Routes to true/false based on a real check of the input.', {
    outputs: ['true', 'false'],
    fields: [
      field('check', 'Check', 'select', { options: ['contains', 'not-contains', 'matches-regex', 'longer-than', 'is-empty'], default: 'contains' }),
      field('value', 'Value / pattern / length', 'text'),
    ],
  }, async (ctx, input, config) => {
    const check = s(config.check, 'contains');
    const value = interpolate(s(config.value), ctx, input);
    let pass: boolean;
    switch (check) {
      case 'contains': pass = input.text.toLowerCase().includes(value.toLowerCase()); break;
      case 'not-contains': pass = !input.text.toLowerCase().includes(value.toLowerCase()); break;
      case 'matches-regex': pass = new RegExp(value, 'i').test(input.text); break;
      case 'longer-than': pass = input.text.length > n(value, 0); break;
      case 'is-empty': pass = input.text.trim().length === 0; break;
      default: throw new Error(`unknown check: ${check}`);
    }
    return { ...input, port: pass ? 'true' : 'false', summary: `${check} → ${pass}` };
  }),

  loop: spec('loop', 'Loop', 'logic', 'Repeats the "each" branch N times or once per input line; then fires "done".', {
    outputs: ['each', 'done'],
    fields: [
      field('mode', 'Mode', 'select', { options: ['repeat', 'for-each-line'], default: 'repeat' }),
      field('times', 'Times (repeat mode)', 'number', { default: 3 }),
    ],
  }, async () => {
    // The executor drives loop iteration; this body never runs.
    throw new Error('loop is executed by the engine');
  }),

  delay: spec('delay', 'Delay', 'logic', 'Waits (shown as "waiting"), then passes the input through.', {
    fields: [field('ms', 'Milliseconds', 'number', { default: 1000 })],
  }, async (ctx, input, config) => {
    const ms = Math.max(0, Math.min(60_000, n(config.ms, 1000)));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      ctx.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
    return { ...input, summary: `${ms}ms` };
  }),

  variables: spec('variables', 'Variables', 'logic', 'Sets workflow variables (KEY=value per line) for {{KEY}} interpolation.', {
    inputs: 'many',
    fields: [field('pairs', 'Variables', 'textarea', { placeholder: 'AUDIENCE=new contributors\nTONE=concise' })],
  }, async (ctx, input, config) => {
    const lines = s(config.pairs).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let count = 0;
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      ctx.vars[line.slice(0, eq).trim()] = interpolate(line.slice(eq + 1).trim(), ctx, input);
      count++;
    }
    return { ...input, summary: `${count} set` };
  }),

  'user-input': spec('user-input', 'User Input', 'logic', 'A value the user provides when the run starts.', {
    inputs: 0,
    fields: [field('prompt', 'Ask the user for', 'text', { placeholder: 'Which module should be reviewed?' }), field('default', 'Default value', 'text')],
  }, async (ctx, _input, config, ) => {
    const nodeIdMarker = s(config.__nodeId); // engine injects the node id
    const value = ctx.runInputs[nodeIdMarker] ?? s(config.default);
    if (!value.trim()) throw new Error(`no value provided for "${s(config.prompt, 'user input')}"`);
    return { text: value, summary: clip(value, 40) };
  }),

  /* ── action (real effects) ──────────────────────────────────────── */

  'save-memory': spec('save-memory', 'Save Memory', 'action', "Saves the input into this project's persistent memory.", {
    fields: [
      field('kind', 'Kind', 'select', { options: ['learning', 'decision', 'code', 'conversation'], default: 'learning' }),
      field('title', 'Title', 'text', { placeholder: 'Workflow result' }),
    ],
  }, async (ctx, input, config) => {
    const memory = ctx.pipeline.memory;
    if (!memory) throw new Error('no project mounted');
    const kind = (['learning', 'decision', 'code', 'conversation'].includes(s(config.kind)) ? s(config.kind) : 'learning') as 'learning';
    const item = memory.add({ kind, title: interpolate(s(config.title), ctx, input) || `Workflow: ${clip(input.text, 40)}`, body: input.text.slice(0, 4000) });
    return { ...input, data: item, summary: `saved · ${item.id.slice(0, 8)}` };
  }),

  'create-note': spec('create-note', 'Create Note', 'action', 'Writes the input as a Markdown note under the AURA home (never the repo).', {
    fields: [field('title', 'Note title', 'text', { placeholder: 'Architecture review' })],
  }, async (ctx, input, config) => {
    const title = interpolate(s(config.title), ctx, input) || 'workflow-note';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note';
    const dir = homePath('notes', ctx.projectId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slug}-${Date.now().toString(36)}.md`);
    writeFileSync(file, `# ${title}\n\n${input.text}\n`);
    return { ...input, files: [file], summary: `${slug}.md` };
  }),

  'export-file': spec('export-file', 'Export File', 'action', 'Writes the input to a file inside the project root.', {
    fields: [field('path', 'Relative path', 'text', { placeholder: 'docs/REVIEW.md' })],
  }, async (ctx, input, config) => {
    const rel = s(config.path);
    if (!rel.trim()) throw new Error('no export path configured');
    const abs = insideProject(ctx.projectPath, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, input.text);
    return { ...input, files: [rel], summary: rel };
  }),

  'shell-command': spec('shell-command', 'Run Shell Command (safe)', 'action', 'Runs an allow-listed command with plain arguments in the project root.', {
    inputs: 'many',
    fields: [field('command', 'Command', 'text', { placeholder: 'npm test' })],
  }, async (ctx, input, config) => {
    const cmd = interpolate(s(config.command), ctx, input);
    const out = await safeShell(ctx, cmd);
    return { text: out || '(no output)', summary: clip(cmd, 40) };
  }),

  'git-status': spec('git-status', 'Git Status', 'action', 'Real `git status` of the project.', { inputs: 0 }, async (ctx) => {
    const { out } = await git(ctx, ['status', '--short', '--branch']);
    return { text: out || 'clean', summary: clip(out.split('\n')[0] ?? '', 40) };
  }),

  'git-diff': spec('git-diff', 'Git Diff', 'action', 'Real `git diff` (uncommitted changes).', {
    inputs: 0,
    fields: [field('staged', 'Staged only', 'boolean', { default: false })],
  }, async (ctx, _input, config) => {
    const args = ['diff', '--stat', '-p', '--no-color'];
    if (config.staged === true) args.splice(1, 0, '--cached');
    const { out } = await git(ctx, args);
    const text = out.length > 60_000 ? out.slice(0, 60_000) + '\n…(truncated)' : out;
    return { text: text || 'no changes', summary: text === 'no changes' || !out ? 'no changes' : clip(out.split('\n').pop() ?? '', 40) };
  }),

  'git-commit': spec('git-commit', 'Git Commit', 'action', 'Stages all changes and commits with the configured message.', {
    fields: [field('message', 'Commit message ({{input}} allowed)', 'text', { placeholder: 'chore: workflow commit' })],
  }, async (ctx, input, config) => {
    const message = interpolate(s(config.message), ctx, input).split('\n')[0].trim();
    if (!message) throw new Error('no commit message configured');
    const status = await git(ctx, ['status', '--porcelain']);
    if (!status.out) return { text: 'nothing to commit', summary: 'nothing to commit' };
    await git(ctx, ['add', '-A']);
    const res = await git(ctx, ['commit', '-m', message]);
    if (res.code !== 0) throw new Error(res.out || 'git commit failed');
    return { text: res.out, summary: clip(message, 40) };
  }),

  'git-branch': spec('git-branch', 'Git Branch', 'action', 'Shows the current branch, or creates/switches when a name is set.', {
    inputs: 0,
    fields: [field('name', 'Branch to create/switch to (optional)', 'text')],
  }, async (ctx, _input, config) => {
    const name = s(config.name).trim();
    if (name) {
      const res = await git(ctx, ['checkout', '-B', name]);
      if (res.code !== 0) throw new Error(res.out || 'git checkout failed');
      return { text: res.out || `on ${name}`, summary: name };
    }
    const { out } = await git(ctx, ['branch', '--show-current']);
    return { text: out || '(detached)', summary: out || '(detached)' };
  }),

  'http-request': spec('http-request', 'HTTP Request', 'action', 'Calls an external HTTP(S) URL. The input becomes the request body when no body template is set.', {
    inputs: 'many',
    fields: [
      field('method', 'Method', 'select', { options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' }),
      field('url', 'URL', 'text', { placeholder: 'https://api.example.com/endpoint' }),
      field('headers', 'Headers (Key: Value per line)', 'textarea', { placeholder: 'Content-Type: application/json' }),
      field('body', 'Body (optional — falls back to input)', 'textarea'),
      field('timeoutMs', 'Timeout (ms)', 'number', { default: 10_000 }),
    ],
  }, async (ctx, input, config) => {
    const url = interpolate(s(config.url), ctx, input);
    if (!url.trim()) throw new Error('no URL configured');
    const method = s(config.method, 'GET').toUpperCase();
    const headers = parseHeaderLines(interpolate(s(config.headers), ctx, input));
    const bodyTemplate = s(config.body);
    const body = method === 'GET' || method === 'DELETE' ? undefined : (bodyTemplate.trim() ? interpolate(bodyTemplate, ctx, input) : (input.text || undefined));
    const { status, text } = await sandboxedFetch(url, { method, headers, body, timeoutMs: n(config.timeoutMs, 10_000), signal: ctx.signal });
    if (status >= 400) throw new Error(`HTTP ${status}: ${clip(text, 200)}`);
    return { text, summary: `${status} · ${clip(url, 30)}` };
  }),

  'slack-notify': spec('slack-notify', 'Slack Notify', 'action', "Posts a message to a Slack Incoming Webhook URL — create one in Slack's own app settings, no AURA-side setup needed.", {
    inputs: 'many',
    fields: [
      field('webhookUrl', 'Slack Incoming Webhook URL', 'text', { placeholder: 'https://hooks.slack.com/services/...' }),
      field('message', 'Message (optional — falls back to input)', 'textarea'),
    ],
  }, async (ctx, input, config) => {
    const url = s(config.webhookUrl).trim();
    if (!url) throw new Error('no Slack webhook URL configured');
    const text = interpolate(s(config.message), ctx, input) || input.text;
    if (!text.trim()) throw new Error('nothing to send — connect an upstream node or set a message');
    const { status, text: respText } = await sandboxedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), timeoutMs: 10_000, signal: ctx.signal });
    if (status >= 400) throw new Error(`Slack webhook rejected the message (${status}): ${clip(respText, 200)}`);
    return { ...input, summary: 'sent to Slack' };
  }),

  /* ── io ─────────────────────────────────────────────────────────── */

  output: spec('output', 'Output', 'io', 'A workflow result, shown in the run panel.', {
    inputs: 'many',
    outputs: [],
    fields: [field('title', 'Title', 'text', { placeholder: 'Result' })],
  }, async (ctx, input, config) => {
    return { ...input, summary: clip(interpolate(s(config.title), ctx, input) || 'Result', 40) };
  }),
};

/** UI-safe registry (metadata only, no runtimes). */
export function nodeSpecInfos(): NodeSpecInfo[] {
  return Object.values(NODE_SPECS).map(({ type, label, category, description, inputs, outputs, disabled, fields }) => ({ type, label, category, description, inputs, outputs, disabled, fields }));
}
