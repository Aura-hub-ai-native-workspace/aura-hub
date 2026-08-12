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
import { useEditorStore } from '../editorStore';
import { fsReadDir, fsReadFile } from '../fsClient';
import { splicePatch, type OpenFile } from '../editorTypes';
import { languageFromPath } from '../fileIcons';
import type { AuraBugAiStatus, AuraBugIssue, AuraBugSeverity, AuraBugVerification } from './types';

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

/** Deterministic root-cause statement, derived from the diagnostic itself.
 *  Always an INFERENCE — never AI, never fabricated. Returns undefined when
 *  no cause can be honestly stated. */
const TS_CAUSE: Record<string, string> = {
  '2304': "The name is not declared anywhere visible in this scope (typo, missing import, or removed declaration).",
  '2552': "The name is not declared anywhere visible in this scope (typo, missing import, or removed declaration).",
  '2307': "The module specifier cannot be resolved to a real file or package on this project's module paths.",
  '2532': "The value is possibly `undefined`, so accessing it may throw at runtime.",
  '2531': "The value is possibly `null`, so accessing it may throw at runtime.",
  '18046': "The value may be `undefined` under strict settings, so this access is not proven safe.",
  '2339': "The property is not declared on this value's type — either the type is outdated or the property name is wrong.",
  '2322': "The value's type does not match the declared type — an interface/signature change is likely out of sync with its use.",
  '2554': "The call passes the wrong number of arguments for the function's declared signature.",
  '6133': "The declared binding is never used, so it is dead code.",
  '6196': "The declared binding is never used, so it is dead code.",
  '7006': "The parameter has an implicit `any` type, so no type checking protects its callers.",
  '7030': "This `any` type is not explicitly declared, hiding what the value really is.",
};

function rootCauseFor(issue: Omit<AuraBugIssue, 'status'>): string | undefined {
  if (issue.source === 'heuristic') {
    if (issue.id.startsWith('unused-import')) return 'An imported binding is never referenced, so it is dead code.';
    if (issue.id.startsWith('debugger')) return 'A debugger breakpoint was left in the source.';
    if (issue.id.startsWith('empty-catch')) return 'The catch block discards the error instead of handling it.';
    if (issue.id.startsWith('todo')) return 'Code is explicitly marked as unfinished or under suspicion.';
    return undefined;
  }
  if (issue.source === 'ai') return undefined;
  const code = issue.code ?? '';
  const ts = code.replace(/^ts/, '');
  const cause = TS_CAUSE[ts];
  if (cause) return cause;
  if (BUG_PATTERNS.test(issue.title)) return 'A possibly-null or possibly-undefined value is being accessed as if it were guaranteed.';
  if (/Cannot find name/i.test(issue.title)) return "A referenced name is not declared in any visible scope.";
  if (/Cannot find module/i.test(issue.title)) return "An import resolves to no real file or package on the module paths.";
  if (/never used|declared but/i.test(issue.title)) return 'Declared code is never used, so it is dead weight.';
  return undefined;
}

/**
 * Normalizes a freshly-detected issue: assigns the Bug Bot lifecycle
 * status and a deterministic root cause. Issues with a proposed fix (or a
 * safe patch) enter the flow as `fix-proposed`; everything else stays
 * `analyzed` (a problem is understood, but no safe fix is offered).
 */
function finalizeIssue(issue: Omit<AuraBugIssue, 'status'>): AuraBugIssue {
  return {
    ...issue,
    status: issue.fix || issue.suggestedFix ? 'fix-proposed' : 'analyzed',
    rootCause: issue.rootCause ?? rootCauseFor(issue),
  };
}

/**
 * Stable, line-independent identity for a finding within its file. Used by
 * verification so a fix that shifts lines still compares correctly, and so
 * a residual problem of the same kind is honestly reported as not fixed.
 */
function issueKind(issue: AuraBugIssue): string {
  if (issue.source === 'language-service') return `marker:${issue.code ?? issue.title}`;
  if (issue.source === 'ai') return `ai:${issue.title}`;
  if (issue.id.startsWith('unused-import')) {
    const m = issue.title.match(/from\s+'([^']+)'/);
    return `unused-import:${m?.[1] ?? issue.title}`;
  }
  for (const kind of ['debugger', 'empty-catch', 'todo']) {
    if (issue.id.startsWith(kind)) return kind;
  }
  return `heuristic:${issue.title}`;
}

/** Line-independent signature used to compare a finding across rescans. */
export function issueSignature(issue: AuraBugIssue): string {
  return `${issue.filePath}|${issueKind(issue)}`;
}

/** True when a Monaco model exists for this URI (open files only). */
export function modelExists(uri: monaco.Uri): boolean {
  return !!monaco.editor.getModel(uri);
}

export function markersToIssues(markers: monaco.editor.IMarker[], file: OpenFile): AuraBugIssue[] {
  return markers.map((m, i) => {
    const code = typeof m.code === 'string' ? m.code : m.code?.value;
    const sourceLabel = m.source ?? 'language service';
    const codeNote = code ? ` (${code})` : '';
    return finalizeIssue({
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
    });
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
  const out: Omit<AuraBugIssue, 'status'>[] = [];
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
  return out.map(finalizeIssue);
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
  const out: Omit<AuraBugIssue, 'status'>[] = [];
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
  return out.map(finalizeIssue);
}

function emptyCatchIssues(content: string, file: OpenFile): AuraBugIssue[] {
  const out: Omit<AuraBugIssue, 'status'>[] = [];
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
  return out.map(finalizeIssue);
}

function todoCommentIssues(content: string, file: OpenFile): AuraBugIssue[] {
  const out: Omit<AuraBugIssue, 'status'>[] = [];
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
  return out.map(finalizeIssue);
}

const JS_TS_LANGUAGE = /^(javascript|typescript)/;

/** Runs the static heuristics against the *current* file text. */
export function analyzeHeuristics(content: string, file: OpenFile): AuraBugIssue[] {
  const issues: AuraBugIssue[] = [...emptyCatchIssues(content, file), ...todoCommentIssues(content, file)];
  if (JS_TS_LANGUAGE.test(file.language)) {
    issues.push(...debuggerIssues(content, file), ...unusedImportIssues(content, file));
  }
  return issues.map(finalizeIssue);
}

/* ── Optional AI-augmented scan (existing frontend AI integration) ─── */

function aiFindingsToIssues(findings: CodeActionFinding[], file: OpenFile): AuraBugIssue[] {
  return findings.map((f, i) =>
    finalizeIssue({
      id: `ai-${file.path}-${f.line ?? i}`,
      severity: f.severity === 'critical' ? 'bug' : 'warning',
      title: f.title,
      explanation: `${f.detail} Flagged by the existing AI provider integration (read-only security scan of the current file).`,
      filePath: file.path,
      fileName: file.name,
      line: f.line,
      source: 'ai',
    }),
  );
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

/* ── Bug Bot: multi-file / project scan ────────────────────────────── */

/** A single file to scan: live buffer content (open tabs) or disk content. */
export interface ScanTarget {
  path: string;
  name: string;
  language: string;
  content: string;
}

export interface ScanResult {
  issues: AuraBugIssue[];
  filesScanned: number;
  /** Files skipped during collection (unreadable, non-scannable, byte-capped). */
  skipped: number;
  message?: string;
}

/** Only text files we can actually analyze are read during a project scan. */
const SCANNABLE_EXT = /\.(tsx?|jsx?|mjs|cjs|json|css|scss|less|html|md|py|go|rs|java|rb|php|sh|yml|yaml|toml|sql|graphql|vue|svelte)$/i;

const PROJECT_MAX_FILES = 150;
const PROJECT_MAX_BYTES = 10 * 1024 * 1024;
const PROJECT_MAX_DIRS = 3000;
const READ_CONCURRENCY = 8;

/** Every currently open tab's live buffer — includes unsaved edits. */
export function collectOpenFileTargets(): ScanTarget[] {
  const { openFiles } = useEditorStore.getState();
  return Object.values(openFiles)
    .filter((f) => !f.loading && !f.error)
    .map((f) => ({ path: f.path, name: f.name, language: f.language, content: f.content }));
}

/**
 * A bounded breadth-first walk of the real project tree through the same
 * confined fs bridge the explorer uses. The Rust side already filters
 * node_modules/.git/dist/etc. and dotfiles. When the desktop bridge is
 * unavailable (browser preview) this returns an honest empty result with a
 * message — never a fake scan.
 */
export async function collectProjectTargets(): Promise<{ targets: ScanTarget[]; skipped: number; message?: string }> {
  const { root, openFiles } = useEditorStore.getState();
  if (!root) return { targets: [], skipped: 0, message: 'No project is open.' };

  const targets: ScanTarget[] = [];
  const seenPaths = new Set<string>();
  const queue: string[] = [''];
  let dirsVisited = 0;
  let totalBytes = 0;
  let skipped = 0;

  try {
    while (queue.length && targets.length < PROJECT_MAX_FILES && dirsVisited < PROJECT_MAX_DIRS) {
      const relDir = queue.shift() as string;
      dirsVisited += 1;
      let children;
      try {
        children = await fsReadDir(root, relDir);
      } catch {
        skipped += 1;
        continue;
      }
      for (const child of children) {
        if (child.isDir) {
          queue.push(child.path);
          continue;
        }
        if (targets.length >= PROJECT_MAX_FILES) break;
        if (!SCANNABLE_EXT.test(child.name)) {
          skipped += 1;
          continue;
        }
        if (seenPaths.has(child.path)) continue;
        seenPaths.add(child.path);
        const live = openFiles[child.path];
        if (live && !live.loading && !live.error) {
          targets.push({ path: live.path, name: live.name, language: live.language, content: live.content });
        } else {
          targets.push({ path: child.path, name: child.name, language: languageFromPath(child.path), content: '' });
        }
      }
    }
  } catch {
    return { targets, skipped, message: 'Desktop file access unavailable — fell back to open files only.' };
  }

  // Read disk content for the targets we did not already have in memory,
  // with a hard total-byte cap so a huge repo cannot bloat the scan.
  const toRead = targets.filter((t) => t.content === '');
  await mapLimit(toRead, READ_CONCURRENCY, async (t) => {
    if (totalBytes >= PROJECT_MAX_BYTES) {
      skipped += 1;
      return;
    }
    try {
      const content = await fsReadFile(root, t.path);
      totalBytes += content.length;
      t.content = content;
    } catch {
      skipped += 1;
    }
  });

  const capped = targets.length >= PROJECT_MAX_FILES;
  return {
    targets: targets.filter((t) => t.content !== ''),
    skipped,
    message: capped ? `Project scan capped at ${PROJECT_MAX_FILES} files.` : undefined,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Scan a set of targets. Monaco markers are only collected when the file
 *  actually has a live model (open tabs); everything else gets the
 *  deterministic heuristic pass — honestly labeled by source per issue.
 *  `skipped` is the caller's count of files it chose not to scan (skipped
 *  during collection: unreadable, non-scannable, or byte-capped). */
export async function scanTargets(targets: ScanTarget[], skipped = 0): Promise<ScanResult> {
  const scanned = await mapLimit(targets, READ_CONCURRENCY, async (t) => {
    const uri = monaco.Uri.parse(t.path);
    let markers: monaco.editor.IMarker[] = [];
    if (modelExists(uri)) {
      try {
        markers = await collectModelMarkers(uri);
      } catch {
        markers = [];
      }
    }
    const file: OpenFile = {
      path: t.path,
      name: t.name,
      language: t.language,
      content: t.content,
      originalContent: t.content,
      dirty: false,
      loading: false,
      error: null,
      saveError: null,
      cursor: { line: 1, column: 1 },
      selection: null,
    };
    return [...markersToIssues(markers, file), ...analyzeHeuristics(t.content, file)];
  });
  const issues = scanned.flat();
  return { issues, filesScanned: targets.length, skipped };
}

/* ── Bug Bot: post-fix verification ────────────────────────────────── */

/**
 * Deterministic re-scan of the affected file after a fix was applied.
 * `passed` is only true when no finding with the same signature remains;
 * `null` means verification genuinely could not run (reported honestly,
 * never claimed as passed).
 */
export async function verifyFix(issue: AuraBugIssue): Promise<AuraBugVerification> {
  const checkedAt = new Date().toISOString();
  const method = 'deterministic re-scan (markers + static scan)';
  const file = useEditorStore.getState().openFiles[issue.filePath];
  if (!file) {
    return { checkedAt, method, passed: null, detail: 'The file is not open, so the fix could not be re-scanned.' };
  }
  const uri = monaco.Uri.parse(file.path);
  let markers: monaco.editor.IMarker[] = [];
  if (modelExists(uri)) {
    try {
      markers = await collectModelMarkers(uri);
    } catch {
      markers = [];
    }
  }
  const current = [...markersToIssues(markers, file), ...analyzeHeuristics(file.content, file)].filter((c) => c.source !== 'ai');
  const signature = issueSignature(issue);
  const stillPresent = current.some((c) => issueSignature(c) === signature);
  if (stillPresent) {
    return { checkedAt, method, passed: false, detail: 'A deterministic re-scan still reports this problem after the fix.' };
  }
  return { checkedAt, method, passed: true, detail: 'No deterministic finding with this signature remains after the fix.' };
}
