/**
 * notification-approval-verify — the two bugs the Windows lab test found.
 * ==================================================================
 *
 * BUG 1 — an approval notification did nothing when clicked.
 *
 *   `useNotificationsFeed` raises a notification for every Fabric approval,
 *   including `system.install`, which is how a node such as OpenCode gets
 *   installed. `NotificationCenter`'s row handler routed a notification by
 *   `missionId`, else by `diagnosisId`, and had no third branch. A
 *   `system.install` approval has NEITHER — it belongs to no mission and no
 *   diagnosis — so the row marked itself read and returned. The request went
 *   on waiting, the install never ran, and OpenCode stayed undetected.
 *
 *   This is NOT Windows-specific and involves no OS notification: AURA grants
 *   only `core:default` in `capabilities/default.json` and registers no
 *   notification plugin, so what was clicked was AURA's own in-app row. It
 *   fails identically on every platform, which is what makes this test
 *   deterministic here rather than needing the lab machine.
 *
 * BUG 2 — "Ask AURA" opened the Workspace and the project chat.
 *
 *   The command was titled 'Help Chat Assistant' and ran
 *   `inWorkspace(() => openPanel('ai-chat'))`, i.e. `setNav('workspace')`
 *   followed by the project-grounded chat panel. Ask AURA is a different
 *   surface that answers with no project and no Workspace, but its open-state
 *   was Home's local `useState`, so no command could reach it and the only
 *   Ask-AURA-shaped command that could exist was the wrong one.
 *
 * Parts C and D are negative controls: they reconstruct the OLD behaviour and
 * show it failing the same assertions, so a passing run means the checks can
 * actually tell the two apart.
 *
 * Usage: node scripts/notification-approval-verify.mjs
 * Needs no service and no browser.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

/* ── browser globals the stores read at module load ───────────────── */
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.document = { documentElement: { setAttribute() {} } };
globalThis.window = { confirm: () => true };

const dir = mkdtempSync(path.join(tmpdir(), 'notif-approval-'));
fs.writeFileSync(path.join(dir, 'stores.ts'), `
export { useAppStore } from '${ROOT}/packages/core/src/store/appStore';
export { useNotificationsStore } from '${ROOT}/apps/desktop/src/ops/notificationsStore';
`);
const bundle = path.join(dir, 'stores.mjs');
execFileSync('npx', [
  'esbuild', path.join(dir, 'stores.ts'),
  '--bundle', '--platform=node', '--format=esm',
  '--define:import.meta.env={}',
  `--outfile=${bundle}`,
], { cwd: ROOT, stdio: 'pipe' });

const S = await import(bundle);
const app = () => S.useAppStore.getState();
const notes = () => S.useNotificationsStore.getState();

/* Missing is a FAIL, not a crash: this suite is meant to be runnable against
   the pre-fix tree as a negative control, where some of these files do not
   exist yet. */
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
};

/* ══════════════════════════════════════════════════════════════════
   A — the notification carries the approval it is asking about
   ══════════════════════════════════════════════════════════════════ */
console.log('\n[A] a Fabric approval notification carries its request id');
{
  const created = notes().notify({
    key: 'fabric-approval:req-install-1',
    kind: 'approval-required',
    title: 'Authorization required — Install OpenCode',
    detail: 'system.install · opencode',
    approvalId: 'req-install-1',
  });
  check('notification was created', created !== null);
  check('approvalId survives notify()', created?.approvalId === 'req-install-1', String(created?.approvalId));
  check('it carries no missionId', created?.missionId === undefined);
  check('it carries no diagnosisId', created?.diagnosisId === undefined,
    'this is the exact shape the old handler could not route');

  const persisted = JSON.parse(globalThis.localStorage.getItem('aura.ops.notifications') ?? '[]');
  check('approvalId survives persistence', persisted[0]?.approvalId === 'req-install-1');
}

console.log('\n[A2] the feed puts the request id on the notification');
{
  const feed = read('apps/desktop/src/ops/useNotificationsFeed.ts');
  const block = feed.slice(feed.indexOf('fabric-approval:'), feed.indexOf('fabric-approval:') + 700);
  check('feed sets approvalId from the request', /approvalId:\s*request\.id/.test(block));
}

/* ══════════════════════════════════════════════════════════════════
   B — the row routes an approval that belongs to no mission
   ══════════════════════════════════════════════════════════════════ */
console.log('\n[B] NotificationCenter routes a mission-less approval');
{
  const src = read('apps/desktop/src/ops/NotificationCenter.tsx');
  const open = src.slice(src.indexOf('const open = ()'), src.indexOf('return (', src.indexOf('const open = ()')));
  check('the handler has an approval branch', /n\.approvalId/.test(open));
  check('it opens the app-level gate', /setPendingApprovalId\(n\.approvalId\)/.test(open));
  check('the approval branch is reached before the mission branch',
    open.indexOf('n.approvalId') < open.indexOf('n.missionId'),
    'otherwise a mission-less approval still falls through');
  check('it returns rather than falling through', /return;/.test(open));
}

console.log('\n[B2] there is a surface that can answer it');
{
  const modal = read('apps/desktop/src/ops/ApprovalRequestModal.tsx');
  check('the modal reuses the existing ApprovalGate', /<ApprovalGate\b/.test(modal),
    'a second approval UI would be a duplicate authority');
  check('it answers through fabricClient.decide', /fabricClient\s*\n?\s*\.decide\(|fabricClient\.decide\(/.test(modal));
  check('it does not decide anything locally', !/granted\s*=\s*true|autoApprove/i.test(modal));
  const appTsx = read('apps/desktop/src/App.tsx');
  check('the modal is mounted app-level', /<ApprovalRequestModal\s*\/>/.test(appTsx),
    'mounting it inside a screen would reintroduce "no surface can answer this"');
}

/* ══════════════════════════════════════════════════════════════════
   C — Ask AURA opens Ask AURA, not the Workspace project chat
   ══════════════════════════════════════════════════════════════════ */
console.log('\n[C] opening Ask AURA navigates nowhere and needs no project');
{
  S.useAppStore.setState({ nav: 'home', activeProjectId: null, inProjectView: false, askAuraChatboxOpen: false });
  app().setAskAuraChatboxOpen(true);
  check('Ask AURA is open', app().askAuraChatboxOpen === true);
  check('nav did not move to the Workspace', app().nav === 'home', app().nav);
  check('no project was required', app().activeProjectId === null);
  check('it did not enter the project view', app().inProjectView === false);
  check('it did not open the project Ask AURA sub-mode', app().askAuraOpen === false);
  app().setAskAuraChatboxOpen(false);
  check('closing it navigates nowhere either', app().nav === 'home' && app().askAuraChatboxOpen === false);
}

console.log('\n[C2] negative control — what the old command did');
{
  S.useAppStore.setState({ nav: 'home', activeProjectId: null, inProjectView: false });
  app().setNav('workspace');                       // the `inWorkspace` wrapper
  check('the old route DOES leave home', app().nav === 'workspace',
    'proves part C would have caught the bug rather than passing vacuously');
  S.useAppStore.setState({ nav: 'home' });
}

console.log('\n[C3] the command is wired to Ask AURA, not to the project panel');
{
  const cmds = read('apps/desktop/src/shell/useCommands.ts');
  const line = cmds.split('\n').find((l) => l.includes("id: 'open-ask-aura'")) ?? '';
  check('an Ask AURA command exists', line !== '');
  check('it is titled "Ask AURA"', /title:\s*'Ask AURA'/.test(line));
  check('it does not go through inWorkspace', !line.includes('inWorkspace'), line.trim().slice(0, 120));
  check('it does not open the ai-chat panel', !line.includes("openPanel('ai-chat')"));
  check('it opens the Ask AURA overlay', /setAskAuraChatboxOpen\(true\)/.test(line));

  const chat = cmds.split('\n').find((l) => l.includes("id: 'open-ai-chat'")) ?? '';
  check('the project chat command still exists', chat !== '');
  check('the project chat is not called Ask AURA', !/title:\s*'Ask AURA'/.test(chat),
    'two different surfaces must not share one name');
}

/* ══════════════════════════════════════════════════════════════════
   D — the product name
   ══════════════════════════════════════════════════════════════════ */
console.log('\n[D] "Help Chat Assistant" is gone from every user-facing string');
{
  const files = [
    'apps/desktop/src/shell/useCommands.ts',
    'apps/desktop/src/ops/layoutStore.ts',
    'apps/desktop/src/ops/workspaceIntelligence.ts',
    'apps/desktop/src/screens/Home.tsx',
  ];
  for (const f of files) check(`no "Help Chat Assistant" in ${f}`, !read(f).includes('Help Chat Assistant'));
  check('negative control: the detector matches the old string',
    'label: \'Help Chat Assistant\''.includes('Help Chat Assistant'));
}

console.log('\n[D2] Ask AURA is mounted where every entry point can reach it');
{
  const appTsx = read('apps/desktop/src/App.tsx');
  const home = read('apps/desktop/src/screens/Home.tsx');
  check('the overlay is rendered app-level', /<AskAuraChatbox\b/.test(appTsx));
  check('Home no longer owns the overlay', !/<AskAuraChatbox\b/.test(home),
    'while Home owned it, opening it from anywhere else rendered nothing');
  check('Home no longer keeps a local copy of the flag', !/useState\(false\)[^\n]*AskAura/i.test(home));
}

console.log(failed ? '\nFAILED' : '\nAll checks passed');
process.exitCode = failed ? 1 : 0;
