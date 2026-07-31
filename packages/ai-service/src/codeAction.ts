/**
 * Code actions — the Code Workspace's grounded, single-shot AI edits.
 * ------------------------------------------------------------------
 * Distinct from `ask()`/`streamEvents()` (which assemble conversational
 * repo-identity/chat context we don't want here): this is a focused call
 * over exactly the symbol, selection, and real dependency/reference data
 * the client already resolved from the knowledge graph — nothing is
 * looked up or invented server-side. Mirrors the `generate-json`
 * workflow node's JSON-only convention (see workflow/nodes.ts) exactly:
 * strip code fences, JSON.parse, hard-fail with no retry on malformed
 * output.
 */
import type { PipelineManager } from './pipeline';
import { mergeRisk, parseModelJson, type RiskLevel } from './jsonMode';

export type { RiskLevel };

export type ActionKind =
  | 'explain' | 'refactor' | 'optimize'
  | 'generate-tests' | 'add-docs' | 'review-security' | 'simplify'
  | 'convert' | 'rename' | 'custom';

export interface CodeRelationRef {
  id: string;
  name: string;
  kind: string;
  relPath: string;
}

export interface CodeActionRequest {
  projectId?: string;
  action: ActionKind;
  filePath: string;
  language: string;
  selectedCode: string;
  selectionRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
  surroundingContext: { before: string; after: string };
  symbol: { id: string; name: string; kind: string; line: number } | null;
  dependencies: CodeRelationRef[];
  dependents: CodeRelationRef[];
  dependentFileCount: number;
  customInstruction?: string;
  riskFloor: { level: RiskLevel; reasons: string[] };
}

export interface CodeActionFinding {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  line?: number;
}

export interface CodeActionResponse {
  ok: boolean;
  action: ActionKind;
  mode: 'diff' | 'findings' | 'new-file';
  explanation: string;
  newCode: string | null;
  newFilePath?: string;
  findings: CodeActionFinding[] | null;
  risk: { level: RiskLevel; reasons: string[] };
  error?: { type: string; message: string; retryable: boolean };
}

const READ_ONLY = new Set<ActionKind>(['explain', 'review-security']);

const MODE: Record<ActionKind, 'diff' | 'findings' | 'new-file'> = {
  explain: 'findings',
  'review-security': 'findings',
  refactor: 'diff',
  optimize: 'diff',
  simplify: 'diff',
  convert: 'diff',
  'add-docs': 'diff',
  rename: 'diff',
  custom: 'diff',
  'generate-tests': 'new-file',
};

const VERB: Record<ActionKind, string> = {
  explain: 'Explain what this code does and how it fits into the surrounding file.',
  refactor: 'Refactor this code for clarity and maintainability without changing its behavior.',
  optimize: 'Optimize this code for performance.',
  'generate-tests': 'Write tests for this code.',
  'add-docs': 'Add clear documentation comments to this code.',
  'review-security': 'Review this code for security vulnerabilities. Do not change it.',
  simplify: 'Simplify this code, removing unnecessary complexity.',
  convert: 'Convert this code as instructed.',
  rename: 'Rename the symbol as instructed, updating all of its uses within the given code.',
  custom: 'Follow the additional instruction exactly.',
};

function renderRefs(refs: CodeRelationRef[], limit = 10): string {
  if (!refs.length) return 'none detected';
  const shown = refs.slice(0, limit).map((r) => `${r.kind} ${r.name} (${r.relPath})`);
  const extra = refs.length > limit ? ` (+${refs.length - limit} more)` : '';
  return shown.join(', ') + extra;
}

function buildSystemPrompt(action: ActionKind): string {
  const base =
    'You output ONLY valid JSON, no prose, no code fences. The JSON object must have exactly these keys: ' +
    '"explanation" (string), "newCode" (string or null), "findings" (array or null), ' +
    '"risk" (object: "level" one of "safe"|"medium"|"high", "reasons" array of strings).';
  if (READ_ONLY.has(action)) {
    return `${base} This is a read-only analysis: set "newCode" to null. Populate "findings" as an array of ` +
      `{"severity":"info"|"warning"|"critical","title":string,"detail":string,"line"?:number}. "explanation" is a short overall summary.`;
  }
  if (action === 'generate-tests') {
    return `${base} Produce a complete new test file using the project's real language and testing conventions ` +
      `inferred from the file extension and surrounding code. Put its full contents in "newCode". "findings" must be null. ` +
      `"explanation" is a short summary of what the tests cover.`;
  }
  return `${base} Set "findings" to null. Put the complete rewritten code that should replace the selected code in "newCode", ` +
    `preserving exact indentation and surrounding style. "explanation" is a short human summary of what changed and why.`;
}

function buildUserPrompt(req: CodeActionRequest): string {
  const lines: string[] = [];
  lines.push(`Task: ${VERB[req.action]}`);
  if (req.customInstruction?.trim()) lines.push(`Additional instruction from the user: ${req.customInstruction.trim()}`);
  lines.push(`File: ${req.filePath}  Language: ${req.language}`);
  lines.push(
    req.symbol
      ? `Nearest symbol: ${req.symbol.kind} ${req.symbol.name} (near line ${req.symbol.line})`
      : 'Nearest symbol: none resolved',
  );
  lines.push('Selected code:');
  lines.push('```' + req.language);
  lines.push(req.selectedCode);
  lines.push('```');
  if (req.surroundingContext.before || req.surroundingContext.after) {
    lines.push('Surrounding context (reference only — do not modify, it is shown only so the rewritten code fits in):');
    lines.push('```' + req.language);
    lines.push(req.surroundingContext.before);
    lines.push('>>> SELECTION ABOVE <<<');
    lines.push(req.surroundingContext.after);
    lines.push('```');
  }
  lines.push('Real dependency data from the project knowledge graph — use only these numbers, do not invent others:');
  lines.push(`- Depends on: ${renderRefs(req.dependencies)}`);
  lines.push(`- Referenced by ${req.dependents.length} location(s) across ${req.dependentFileCount} file(s): ${renderRefs(req.dependents)}`);
  lines.push('Respond with ONLY the JSON object described in the system message.');
  return lines.join('\n');
}

function normalizeFindings(raw: unknown): CodeActionFinding[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CodeActionFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const severity = o.severity === 'critical' || o.severity === 'warning' ? o.severity : 'info';
    out.push({
      severity,
      title: typeof o.title === 'string' ? o.title : 'Finding',
      detail: typeof o.detail === 'string' ? o.detail : '',
      line: typeof o.line === 'number' ? o.line : undefined,
    });
  }
  return out;
}

function suggestTestFilePath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot) : '';
  const base = dot >= 0 ? filePath.slice(0, dot) : filePath;
  return `${base}.test${ext}`;
}

export async function handleCodeAction(
  pipeline: PipelineManager,
  req: CodeActionRequest,
  signal?: AbortSignal,
): Promise<CodeActionResponse> {
  const mode = MODE[req.action] ?? 'diff';
  const system = buildSystemPrompt(req.action);
  const user = buildUserPrompt(req);

  const res = await pipeline.generate({ system, user, json: true }, signal);
  if (!res.ok) {
    return { ok: false, action: req.action, mode, explanation: '', newCode: null, findings: null, risk: req.riskFloor, error: res.error };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(res.text);
  } catch (e) {
    return {
      ok: false,
      action: req.action,
      mode,
      explanation: '',
      newCode: null,
      findings: null,
      risk: req.riskFloor,
      error: { type: 'parse_error', message: (e as Error).message, retryable: true },
    };
  }

  return {
    ok: true,
    action: req.action,
    mode,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    newCode: typeof parsed.newCode === 'string' ? parsed.newCode : null,
    newFilePath: mode === 'new-file' ? suggestTestFilePath(req.filePath) : undefined,
    findings: normalizeFindings(parsed.findings),
    risk: mergeRisk(req.riskFloor, parsed.risk as { level?: unknown; reasons?: unknown } | undefined),
  };
}
