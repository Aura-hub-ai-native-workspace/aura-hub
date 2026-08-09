/**
 * AuraBug — scan pipeline (frontend-only).
 * ------------------------------------------------------------------
 * Analysis sources, in the order the feature spec allows:
 *   1. The existing AI integration (aiClient.codeAction — used only when
 *      the local AI service is reachable AND a provider key is set).
 *   2. Monaco's own language-service diagnostics (model markers) — the
 *      built-in TS/JS/JSON/CSS/HTML analyzers, read from the live model.
 *   3. Light, honest static heuristics on the current file text
 *      (unused imports, debugger statements, empty catch blocks,
 *      TODO/FIXME comments) — clearly labeled, never fabricated.
 *
 * Nothing here calls or modifies the backend. Every issue is produced by
 * real analysis of the current editor content.
 */
import * as monaco from 'monaco-editor';
import { aiClient, type CodeActionFinding, type GraphView } from '../../ai/aiClient';
import { contextForSelection, riskFloor } from '../aiContext';
import { splicePatch, type OpenFile } from '../editorTypes';
import type { AuraBugAiStatus, AuraBugIssue, AuraBugSeverity } from './types';

/* ── Marker collection: wait for the language service to settle ────── */

const SETTLE_MS = 350;
const MAX_WAIT_MS = 5000;

/**
 * Returns the live markers for `uri`, waiting for diagnostic activity to
 * quiet down (so a just-loaded TS file's worker diagnostics are included)
 * with a hard cap so a silent file never hangs the scan.
 */
export function collectModelMarkers(uri: monaco.Uri, settleMs = SETTLE_MS, maxWaitMs = MAX_WAIT_MS): Promise<monaco.editor.IMarker[]> {
  return new Promise((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout>;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      listener.dispose();
      resolve(monaco.editor.getModelMarkers({ resource: uri }));
    };
    const restart = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settleMs);
    };
    const listener = monaco.editor.onDidChangeMarkers((uris) => {
      if (uris.some((u) => u.toString() === uri.toString())) restart();
    });

    hardTimer = setTimeout(finish, maxWaitMs);
    restart();
  });
}

/* ── Markers → AuraBug issues ─────────────────────────────────────── */

/** Compiler diagnostics that specifically indicate a runtime-access risk. */
const BUG_PATTERNS =
  /possibly '(?:null|undefined)'|is possibly (?:null|undefined)|Object is possibly|may be undefined|Cannot read properties of|is not a function/i;

function severityFromMarker(marker: monaco.editor.IMarker): AuraBugSeverity {
  if (marker.severity === monaco.MarkerSeverity.Error) {
    return BUG_PATTERNS.test(marker.message) ? 'bug' : 'error';
  }
  return 'warning';
}

export function markersToIssues(markers: monaco.editor.IMarker[], file: OpenFile): AuraBugIssue[] {
  return markers.map((m, i) => {
    const code = typeof m.code === 'string' ? m.code : m.code?.value;
    const sourceLabel = m.source ?? 'language service';
    const codeNote = code ? ` (${code})` : '';
    return {
      id: `marker-${file.path}-${m.startLineNumber}-${m.startColumn}-${i}`,
      severity: severityFromMarker(m),
      title: m.message,
      explanation: `Reported by the editor's built-in ${sourceLabel} analysis${codeNote} while checking the current file.`,
      filePath: file.path,
      fileName: file.name,
      line: m.startLineNumber,
      column: m.startColumn,
      code,
      source: 'language-service',
    };
  });
}

/* ── Static heuristics on the current text ────────────────────────── */

interface ImportBinding {
  name: string;
  kind: 'default' | 'namespace' | 'named';
}
interface ImportStatement {
  startLine: number;
  endLine: number;
  text: string;
  specifier: string;
  quote: string;
  bindings: ImportBinding[];
  isTypeOnly: boolean;
  hasSemicolon: boolean;
}

const IMPORT_START = /^\s*import\s+(?!\()(?!\.)/;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isNameUsedOutside(content: string, startLine: number, endLine: number, name: string): boolean {
  const lines = content.split('\n');
  const before = lines.slice(0, startLine - 1).join('\n');
  const after = lines.slice(endLine).join('\n');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(`${before}\n${after}`);
}

function parseImportStatement(text: string, startLine: number, endLine: number): ImportStatement | null {
  const trimmed = text.trim();
  if (/^import\s+['"]/.test(trimmed)) return null; // side-effect import, nothing to check
  const specMatch = trimmed.match(/from\s+(['"])([^'"]+)\1\s*;?\s*$/);
  if (!specMatch) return null;

  const isTypeOnly = /^import\s+type\s+/.test(trimmed);
  let body = trimmed
    .replace(/^import\s+/, '')
    .replace(/\s+from\s+(['"])[^'"]+\1\s*;?\s*$/, '')
    .trim();
  if (isTypeOnly) body = body.replace(/^type\s+/, '');

  const bindings: ImportBinding[] = [];

  const nsMatch = body.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (nsMatch) bindings.push({ name: nsMatch[1], kind: 'namespace' });

  const braceMatch = body.match(/\{\s*([\s\S]*?)\s*\}/);
  if (braceMatch) {
    for (const raw of braceMatch[1].split(',')) {
      let name = raw.trim();
      if (!name) continue;
      name = name.replace(/^(?:type|typeof)\s+/, '');
      if (/\s+as\s+/.test(name)) name = name.split(/\s+as\s+/).pop() as string;
      name = name.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bindings.push({ name, kind: 'named' });
    }
  }

  const noBrace = body.replace(/\{\s*[\s\S]*?\s*\}/, '').replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, '');
  const defMatch = noBrace.match(/^\s*([A-Za-z_$][\w$]*)\b/);
  if (defMatch) bindings.push({ name: defMatch[1], kind: 'default' });

  if (!bindings.length) return null;
  return {
    startLine,
    endLine,
    text: trimmed,
    specifier: specMatch[2],
    quote: specMatch[1],
    bindings,
    isTypeOnly,
    hasSemicolon: /;\s*$/.test(trimmed),
  };
}

function findImportStatements(content: string): ImportStatement[] {
  const lines = content.split('\n');
  const out: ImportStatement[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORT_START.test(lines[i])) continue;
    let buf = lines[i];
    let j = i;
    const complete = (b: string) => /;\s*$/.test(b.trimEnd()) || (/\bfrom\s+['"]/.test(b) && /['"]\s*;?\s*$/.test(b.trimEnd()));
    while (!complete(buf) && j < lines.length - 1) {
      j += 1;
      buf += '\n' + lines[j];
    }
    const stmt = parseImportStatement(buf, i + 1, j + 1);
    if (stmt) out.push(stmt);
    i = j;
  }
  return out;
}

function unusedImportIssues(content: string, file: OpenFile): AuraBugIssue[] {
  const out: AuraBugIssue[] = [];
  for (const stmt of findImportStatements(content)) {
    const unused = stmt.bindings.filter((b) => !isNameUsedOutside(content, stmt.startLine, stmt.endLine, b.name));
    if (!unused.length) continue;
    const allUnused = unused.length === stmt.bindings.length;
    const names = unused.map((b) => b.name);
    const plural = names.length > 1 ? 's' : '';
    const nameList = names.map((n) => `\`${n}\``).join(', ');
    out.push({
      id: `unused-import-${file.path}-${stmt.startLine}`,
      severity: 'warning',
      title: allUnused ? `Unused import from '${stmt.specifier}'` : `Unused import${plural}: ${nameList}`,
      explanation: allUnused
        ? `The import from '${stmt.specifier}' on line ${stmt.startLine} is not referenced anywhere else in this file.`
        : `The binding${plural} ${nameList} from '${stmt.specifier}' ${plural ? 'are' : 'is'} not referenced anywhere else in this file.`,
      filePath: file.path,
      fileName: file.name,
      line: stmt.startLine,
      source: 'heuristic',
      suggestedFix: allUnused
        ? `Remove the unused import statement on line ${stmt.startLine}.`
        : `Remove ${nameList} from the import on line ${stmt.startLine}.`,
      fix: {
        startLine: stmt.startLine,
        endLine: stmt.endLine,
        newText: rebuildImport(stmt, unused),
      },
    });
  }
  return out;
}

function rebuildImport(stmt: ImportStatement, unused: ImportBinding[]): string {
  const allUnused = unused.length === stmt.bindings.length;
  if (allUnused) return '';
  const used = stmt.bindings.filter((b) => !unused.some((u) => u.name === b.name));
  const parts: string[] = [];
  const def = used.find((b) => b.kind === 'default');
  const ns = used.find((b) => b.kind === 'namespace');
  const named = used.filter((b) => b.kind === 'named');
  if (def) parts.push(def.name);
  if (ns) parts.push(`* as ${ns.name}`);
  if (named.length) parts.push(`{ ${named.map((b) => b.name).join(', ')} }`);
  if (!parts.length) return '';
  const prefix = stmt.isTypeOnly ? 'import type' : 'import';
  const semi = stmt.hasSemicolon ? ';' : '';
  return `${prefix} ${parts.join(', ')} from ${stmt.quote}${stmt.specifier}${stmt.quote}${semi}`;
}

function debuggerIssues(content: string, file: OpenFile): AuraBugIssue[] {
  const out: AuraBugIssue[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*debugger\s*;?\s*(?:\/\/[^\n]*)?$/.test(lines[i])) {
      out.push({
        id: `debugger-${file.path}-${i + 1}`,
        severity: 'warning',
        title: 'Debugger statement left in code',
        explanation: `A \`debugger\` statement on line ${i + 1} pauses execution whenever a debugger is attached; it should not ship.`,
        filePath: file.path,
        fileName: file.name,
        line: i + 1,
        source: 'heuristic',
        suggestedFix: 'Remove the debugger statement.',
        fix: { startLine: i + 1, endLine: i + 1, newText: '' },
      });
    }
  }
  return out;
}

function emptyCatchIssues(content: string, file: OpenFile): AuraBugIssue[] {
  const out: AuraBugIssue[] = [];
  const re = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n[\s]*|\/\*[\s\S]*?\*\/[\s]*)*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const line = lineAt(content, m.index);
    out.push({
      id: `empty-catch-${file.path}-${line}`,
      severity: 'warning',
      title: 'Empty catch block swallows errors',
      explanation: `The catch block at line ${line} handles nothing — a thrown error would be silently dropped.`,
      filePath: file.path,
      fileName: file.name,
      line,
      source: 'heuristic',
      suggestedFix: 'Handle the error (log it, fall back, or rethrow) instead of swallowing it.',
    });
  }
  return out;
}

function todoCommentIssues(content: string, file: OpenFile): AuraBugIssue[] {
  const out: AuraBugIssue[] = [];
  const re = /(?:\/\/|\/\*|\*)\s*(TODO|FIXME|HACK|XXX)\b[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const line = lineAt(content, m.index);
    const kind = m[1];
    out.push({
      id: `todo-${file.path}-${line}`,
      severity: 'warning',
      title: `${kind} comment marks unfinished work`,
      explanation: `The ${kind} comment on line ${line} marks code that is intentionally unfinished or under suspicion.`,
      filePath: file.path,
      fileName: file.name,
      line,
      source: 'heuristic',
      suggestedFix: `Review and resolve the ${kind} before considering this code complete.`,
    });
  }
  return out;
}

const JS_TS_LANGUAGE = /^(javascript|typescript)/;

/** Runs the static heuristics against the *current* file text. */
export function analyzeHeuristics(content: string, file: OpenFile): AuraBugIssue[] {
  const issues: AuraBugIssue[] = [...emptyCatchIssues(content, file), ...todoCommentIssues(content, file)];
  if (JS_TS_LANGUAGE.test(file.language)) {
    issues.push(...debuggerIssues(content, file), ...unusedImportIssues(content, file));
  }
  return issues;
}

/* ── Optional AI-augmented scan (existing frontend AI integration) ─── */

function aiFindingsToIssues(findings: CodeActionFinding[], file: OpenFile): AuraBugIssue[] {
  return findings.map((f, i) => ({
    id: `ai-${file.path}-${f.line ?? i}`,
    severity: f.severity === 'critical' ? 'bug' : 'warning',
    title: f.title,
    explanation: `${f.detail} Flagged by the existing AI provider integration (read-only security scan of the current file).`,
    filePath: file.path,
    fileName: file.name,
    line: f.line,
    source: 'ai',
  }));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs the existing frontend AI integration over the whole current file
 * when it is actually available (service reachable + provider key set).
 * Returns an empty list (status `unavailable`) instead of failing the
 * deterministic scan whenever it isn't.
 */
export async function runAiAnalysis(
  projectId: string,
  file: OpenFile,
  content: string,
  graph: GraphView | null,
): Promise<{ issues: AuraBugIssue[]; status: AuraBugAiStatus }> {
  let health: Awaited<ReturnType<typeof aiClient.health>>;
  try {
    health = await withTimeout(aiClient.health(), 3000);
  } catch {
    return { issues: [], status: 'unavailable' };
  }
  if (!health?.health?.ok || !health?.key?.configured) return { issues: [], status: 'unavailable' };

  const ctx = contextForSelection(graph, file.path, file.cursor.line);
  const floor = riskFloor('review-security', ctx, content);

  try {
    const res = await withTimeout(
      aiClient.codeAction({
        projectId,
        action: 'review-security',
        filePath: file.path,
        language: file.language,
        selectedCode: content,
        selectionRange: null,
        surroundingContext: { before: '', after: '' },
        symbol: ctx.symbol,
        dependencies: ctx.dependencies,
        dependents: ctx.dependents,
        dependentFileCount: ctx.dependentFileCount,
        riskFloor: floor,
      }),
      25000,
    );
    if (!res.ok || !res.findings?.length) return { issues: [], status: 'done' };
    return { issues: aiFindingsToIssues(res.findings, file), status: 'done' };
  } catch {
    return { issues: [], status: 'unavailable' };
  }
}

/* ── Apply-fix helpers ─────────────────────────────────────────────── */

/** The file text with `issue.fix` applied — the canonical apply path. */
export function applyPatch(content: string, issue: AuraBugIssue): string {
  if (!issue.fix) return content;
  return splicePatch(content, issue.fix, issue.fix.newText);
}
