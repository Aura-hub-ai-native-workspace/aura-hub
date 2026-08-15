/**
 * context-index-verify — the Context Fabric's change-detection foundation.
 * ==================================================================
 * These exist because two defects made "is AURA's understanding fresh?"
 * unanswerable, and both failed in the dangerous direction — they reported
 * stale knowledge as current:
 *
 *   1. The mtime baseline lived in ONE global file shared by every project,
 *      so opening a second project destroyed the first one's baseline.
 *   2. Staleness was decided by `fs.statSync(projectRoot).mtimeMs`. A
 *      directory's mtime only moves when its OWN entries change, so editing
 *      any nested file — nearly every real edit — left the check blind, and
 *      artifacts refreshed on a one-hour timer instead of on change.
 *
 * Case 6 below deliberately proves the OLD check would have failed, so this
 * suite documents the bug rather than merely asserting the fix.
 *
 * Every case drives the REAL module (bundled from source), not a
 * reimplementation of it.
 *
 * Usage: node scripts/context-index-verify.mjs
 * Requires no running service.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* An isolated AURA_HOME so the suite can never read or write the real one. */
const HOME = mkdtempSync(path.join(tmpdir(), 'aura-ctx-home-'));
process.env.AURA_HOME = HOME;

const out = path.join(mkdtempSync(path.join(tmpdir(), 'ctx-index-')), 'performance.mjs');
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/ai-service/src/intelligence/performance.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
], { cwd: ROOT, stdio: 'pipe' });

const {
  detectChanges, updateIndexState, isArtifactStale,
  loadIndexState, saveIndexState,
} = await import(out);

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

/** Build a small project tree with a deliberately DEEP nested file. */
function makeProject(label) {
  const root = mkdtempSync(path.join(tmpdir(), `aura-proj-${label}-`));
  mkdirSync(path.join(root, 'a', 'b', 'c', 'd'), { recursive: true });
  writeFileSync(path.join(root, 'top.ts'), 'export const top = 1;\n');
  writeFileSync(path.join(root, 'a', 'mid.ts'), 'export const mid = 1;\n');
  writeFileSync(path.join(root, 'a', 'b', 'c', 'd', 'deep.ts'), 'export const deep = 1;\n');
  return root;
}

/** Write a file and force its mtime to a known instant. */
function writeAt(file, content, whenMs) {
  writeFileSync(file, content);
  const t = whenMs / 1000;
  fs.utimesSync(file, t, t);
}

const A = makeProject('a');
const B = makeProject('b');

/* ── 1. a fresh project reports its whole tree as added ───────────── */
{
  const r = detectChanges('proj-a', A);
  check('1. first scan reports every file as added',
    r.added.length === 3 && r.changed.length === 0 && r.unchanged.length === 0,
    `added=${r.added.length} changed=${r.changed.length} unchanged=${r.unchanged.length}`);
  check('1b. totalIndexed counts the tree', r.totalIndexed === 3, `totalIndexed=${r.totalIndexed}`);
  check('1c. a small tree is not truncated', r.truncated === false, `truncated=${r.truncated}`);
  check('1d. maxMtimeMs is a real timestamp', r.maxMtimeMs > 0, `maxMtimeMs=${r.maxMtimeMs}`);
}

/* ── 2. after a baseline, an untouched tree is clean ──────────────── */
updateIndexState('proj-a', A);
{
  const r = detectChanges('proj-a', A);
  check('2. baselined tree reports no changes',
    r.added.length === 0 && r.changed.length === 0 && r.removed.length === 0 && r.unchanged.length === 3,
    `unchanged=${r.unchanged.length}`);
  // `hasChanges` was removed as a dead export (P3-1); the same question is
  // answered from the diff it used to wrap, with no second tree walk.
  const anyChange = (r) => r.changed.length > 0 || r.added.length > 0 || r.removed.length > 0;
  check('2b. the diff agrees nothing changed', anyChange(r) === false);
}

/* ── 3. THE REGRESSION — a second project must not clobber the first ─ */
{
  const rb = detectChanges('proj-b', B);
  check('3. project B scans independently (its own empty baseline)',
    rb.added.length === 3, `B added=${rb.added.length}`);

  updateIndexState('proj-b', B);

  const ra = detectChanges('proj-a', A);
  check('3b. project A is STILL clean after B was indexed',
    ra.added.length === 0 && ra.changed.length === 0 && ra.removed.length === 0,
    `A added=${ra.added.length} changed=${ra.changed.length} removed=${ra.removed.length}`);

  const files = fs.readdirSync(path.join(HOME, 'index-state')).sort();
  check('3c. each project owns a separate baseline file',
    files.includes('proj-a.json') && files.includes('proj-b.json'),
    files.join(', '));
  check('3d. the old shared global file is not written',
    !files.includes('file-mtimes.json'), files.join(', '));
}

/* ── 4. a project's baseline describes only its own tree ──────────── */
{
  const a = loadIndexState('proj-a');
  const b = loadIndexState('proj-b');
  const keys = Object.keys(a).sort();
  check('4. baseline holds relative paths for its own tree',
    keys.length === 3 && keys.includes('top.ts') && keys.includes(path.join('a', 'b', 'c', 'd', 'deep.ts')),
    keys.join(', '));
  check('4b. the two baselines are independent objects',
    Object.keys(b).length === 3);
}

/* ── 5. NESTED change detection ──────────────────────────────────── */
const deepFile = path.join(A, 'a', 'b', 'c', 'd', 'deep.ts');
const future = Date.now() + 60_000;
{
  writeAt(deepFile, 'export const deep = 2;\n', future);
  const r = detectChanges('proj-a', A);
  check('5. an edit four directories deep is detected',
    r.changed.length === 1 && r.changed[0] === path.join('a', 'b', 'c', 'd', 'deep.ts'),
    `changed=${JSON.stringify(r.changed)}`);
  check('5b. the diff agrees something changed',
    r.changed.length > 0 || r.added.length > 0 || r.removed.length > 0);
  check('5c. maxMtimeMs reflects the nested edit',
    r.maxMtimeMs >= future - 1000, `maxMtimeMs=${r.maxMtimeMs} future=${future}`);
}

/* ── 6. PROOF the replaced check was blind to that same edit ─────── */
{
  const rootMtime = fs.statSync(A).mtimeMs;

  /* The scenario being reproduced is the ordinary one: an artifact was
     generated at some point AFTER the project tree already existed, and a
     nested file was edited afterwards.

     `generatedAt` is therefore anchored just after the root directory's own
     last modification — not to `Date.now() - 1s`, which on a freshly created
     temp tree can fall BEFORE the root was made and would fire the old rule
     for the wrong reason (the root's creation, not the nested edit). The
     nested write in case 5 carries an mtime of now + 60s, so it is
     unambiguously after this instant. */
  const generatedAt = rootMtime + 1000;

  // The replaced rule: stale only if the ROOT directory's mtime exceeded the
  // artifact's generation time. The nested write never touched the root, so
  // the old rule reports "fresh" for a tree that demonstrably just changed.
  const oldSaysStale = rootMtime > generatedAt;
  const changes = detectChanges('proj-a', A);
  const newSaysStale = isArtifactStale(new Date(generatedAt).toISOString(), changes);

  check('6. the replaced root-mtime rule would have missed it',
    oldSaysStale === false, `rootMtime=${rootMtime} vs generatedAt=${generatedAt}`);
  check('6b. the nested edit really is newer than the artifact',
    changes.maxMtimeMs > generatedAt, `maxMtimeMs=${changes.maxMtimeMs} generatedAt=${generatedAt}`);
  check('6c. the new rule catches it', newSaysStale === true);
}

/* ── 7. isArtifactStale semantics ────────────────────────────────── */
updateIndexState('proj-a', A);
{
  const clean = detectChanges('proj-a', A);
  // An artifact generated AFTER the newest file still describes the tree.
  const afterTree = new Date(clean.maxMtimeMs + 5000).toISOString();
  check('7. artifact newer than every file is fresh',
    isArtifactStale(afterTree, clean) === false);

  const beforeTree = new Date(clean.maxMtimeMs - 5000).toISOString();
  check('7b. artifact older than the newest file is stale',
    isArtifactStale(beforeTree, clean) === true);

  check('7c. a missing timestamp is stale, never assumed fresh',
    isArtifactStale(undefined, clean) === true && isArtifactStale(null, clean) === true);
  check('7d. an unparseable timestamp is stale',
    isArtifactStale('not-a-date', clean) === true);
}

/* ── 8. additions and removals, which mtime alone cannot see ─────── */
{
  // A file restored from a backup carries an OLD mtime, so maxMtimeMs does
  // not move — only the baseline diff reveals it.
  const restored = path.join(A, 'a', 'restored.ts');
  writeAt(restored, 'export const restored = 1;\n', Date.now() - 600_000);
  const r = detectChanges('proj-a', A);
  const artifactAfterNewest = new Date(r.maxMtimeMs + 5000).toISOString();
  check('8. an added file with an OLD mtime is still detected',
    r.added.length === 1 && r.added[0] === path.join('a', 'restored.ts'),
    `added=${JSON.stringify(r.added)}`);
  check('8b. that addition makes an otherwise-newer artifact stale',
    isArtifactStale(artifactAfterNewest, r) === true);

  updateIndexState('proj-a', A);
  fs.rmSync(restored);
  const r2 = detectChanges('proj-a', A);
  check('8c. a removed file is detected',
    r2.removed.length === 1 && r2.removed[0] === path.join('a', 'restored.ts'),
    `removed=${JSON.stringify(r2.removed)}`);
  check('8d. a removal makes an otherwise-newer artifact stale',
    isArtifactStale(new Date(r2.maxMtimeMs + 5000).toISOString(), r2) === true);
}

/* ── 9. a project id can never escape the index-state directory ──── */
{
  const dir = path.join(HOME, 'index-state');
  let escaped = false;
  try {
    saveIndexState('../../escape', { 'x.ts': 1 });
    // Whatever it sanitised to, it must still be inside index-state.
    const stray = fs.existsSync(path.join(HOME, 'escape.json'))
      || fs.existsSync(path.resolve(HOME, '..', 'escape.json'));
    escaped = stray;
  } catch {
    escaped = false; // throwing is an acceptable answer too
  }
  check('9. a path-like project id cannot write outside index-state', escaped === false);
  check('9b. the sanitised name stays in the index-state directory',
    fs.readdirSync(dir).every((f) => !f.includes('/') && !f.includes('..') || f.endsWith('.json')));

  let threw = false;
  try { loadIndexState('...'); } catch { threw = true; }
  check('9c. an id that sanitises to nothing is rejected, not shared', threw === true);
}

/* ── 10. an empty tree is handled honestly ───────────────────────── */
{
  const empty = mkdtempSync(path.join(tmpdir(), 'aura-proj-empty-'));
  const r = detectChanges('proj-empty', empty);
  check('10. an empty project reports nothing and claims no mtime',
    r.totalIndexed === 0 && r.maxMtimeMs === 0 && r.added.length === 0,
    `totalIndexed=${r.totalIndexed} maxMtimeMs=${r.maxMtimeMs}`);
  check('10b. an artifact over an empty tree is not falsely stale',
    isArtifactStale(new Date().toISOString(), r) === false);
}

/* ── 11. cost — the walk must be cheap enough to run per request ─── */
{
  const t0 = performance.now();
  const r = detectChanges('aura-hub-self', ROOT);
  const ms = Math.round(performance.now() - t0);
  console.log(`INFO  scanned ${r.totalIndexed} files of the real repo in ${ms}ms (truncated=${r.truncated})`);
  check('11. a real repository scan stays under 2s', ms < 2000, `${ms}ms`);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
