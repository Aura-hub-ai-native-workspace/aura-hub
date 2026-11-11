/**
 * active-project-verify — one authority for "what project are we on?"
 * ==================================================================
 * AURA used to hold four separate answers to that question:
 *
 *   1. `appStore.activeProjectId`                  — nulled by every setNav
 *   2. `localStorage['aura.workspace.projectId']`  — WorkspaceScreen's private copy
 *   3. `useWorkspace.openId`                       — the client's last open()
 *   4. `pipeline.currentProjectId`                 — the service's mount
 *
 * (2) existed ONLY because (1) was destroyed on navigation: the Workspace Hub
 * needed a project that survived leaving the project screen, so it kept its
 * own. Two pointers that nothing reconciled meant the Hub could plan a
 * mission against one project while the rest of the shell displayed another.
 *
 * The fix separates two questions that were conflated:
 *   • WHICH project is active   → `activeProjectId`, persisted, nav-independent
 *   • Am I LOOKING at it        → `inProjectView`
 *
 * Case 1 is the regression that made the second pointer necessary.
 *
 * Usage: node scripts/active-project-verify.mjs
 * Requires no running service.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'active-project-'));
const out = path.join(outDir, 'appStore.mjs');

/* React is bundled in rather than left external: zustand imports
   `useSyncExternalStore`, and the bundle runs from a temp directory that
   cannot resolve the repo's node_modules. Only the vanilla store API
   (getState/setState) is exercised here — no component ever renders. */
execFileSync('npx', [
  'esbuild', `${ROOT}/packages/core/src/store/appStore.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
], { cwd: ROOT, stdio: 'pipe' });

/* A minimal localStorage, so persistence is exercised rather than stubbed
   away. The store reads it at module load, so it must exist before import. */
function installStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
  };
  globalThis.document = { documentElement: { setAttribute() {} } };
  return map;
}

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

const store = installStorage();
const { useAppStore } = await import(out);
const get = () => useAppStore.getState();

/* ── 1. THE REGRESSION — navigation must not deactivate the project ─ */
{
  get().openProject('alpha');
  check('1a. openProject makes it active and shows its screen',
    get().activeProjectId === 'alpha' && get().inProjectView === true,
    `active=${get().activeProjectId} inView=${get().inProjectView}`);

  get().setNav('workspace');
  check('1. setNav LEAVES the project active (was: nulled)',
    get().activeProjectId === 'alpha',
    `active=${get().activeProjectId}`);
  check('1b. setNav does leave the project view',
    get().inProjectView === false && get().nav === 'workspace');
}

/* ── 2. the Hub no longer needs a private pointer ─────────────────── */
{
  // Standing on the Workspace (Hub) screen, the active project is readable
  // from the ONE authority — which is the whole reason the second key is gone.
  check('2. the Hub can read the active project from the shell store',
    get().nav === 'workspace' && get().activeProjectId === 'alpha');
  check('2b. the retired private key is never written',
    store.get('aura.workspace.projectId') === undefined,
    `keys=${[...store.keys()].join(', ')}`);
}

/* ── 3. closing the project view keeps the project active ────────── */
{
  get().openProject('alpha');
  get().closeProject();
  check('3. closeProject exits the view but keeps the project active',
    get().activeProjectId === 'alpha' && get().inProjectView === false,
    `active=${get().activeProjectId} inView=${get().inProjectView}`);
}

/* ── 4. switching project without navigating ─────────────────────── */
{
  get().setNav('workspace');
  get().setActiveProject('beta');
  check('4. setActiveProject switches project without changing screen',
    get().activeProjectId === 'beta' && get().nav === 'workspace' && get().inProjectView === false,
    `active=${get().activeProjectId} nav=${get().nav}`);
}

/* ── 5. persistence ──────────────────────────────────────────────── */
{
  check('5. the active project is persisted under one key',
    store.get('aura.activeProjectId') === 'beta',
    `stored=${store.get('aura.activeProjectId')}`);

  get().setActiveProject(null);
  check('5b. clearing removes the persisted value',
    store.get('aura.activeProjectId') === undefined && get().activeProjectId === null);
}

/* ── 6. clearActiveProject forgets it entirely ───────────────────── */
{
  get().openProject('gamma');
  get().clearActiveProject();
  check('6. clearActiveProject drops the project and the view',
    get().activeProjectId === null && get().inProjectView === false);
  check('6b. and does not leave it persisted',
    store.get('aura.activeProjectId') === undefined);
}

/* ── 7. a relaunch restores the active project ───────────────────── */
{
  // Fresh module instance over a storage that already holds a project —
  // exactly what a relaunch looks like.
  installStorage({ 'aura.activeProjectId': 'delta', 'aura-onboarded': 'true' });
  const { useAppStore: relaunched } = await import(`${out}?relaunch=1`);
  const s = relaunched.getState();
  check('7. a relaunch restores the active project',
    s.activeProjectId === 'delta', `active=${s.activeProjectId}`);
  check('7b. a relaunch does NOT reopen the project screen',
    s.inProjectView === false && s.nav === 'home',
    `inView=${s.inProjectView} nav=${s.nav}`);
}

/* ── 8. no stored project means no project, not a guess ──────────── */
{
  installStorage({ 'aura-onboarded': 'true' });
  const { useAppStore: fresh } = await import(`${out}?relaunch=2`);
  check('8. a first run has no active project',
    fresh.getState().activeProjectId === null && fresh.getState().inProjectView === false);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
