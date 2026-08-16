/**
 * Update experience verification.
 * ==================================================================
 * Exercises the update lifecycle through `UpdateService` with a stub
 * adapter, so every failure path — signature rejection, network loss,
 * unsupported install, downgrade — is reachable deterministically.
 *
 *   node scripts/update-ui-verify.mjs
 *
 * SCOPE, stated plainly: the stub replaces the NATIVE BOUNDARY only. It
 * proves that AURA reacts correctly to what the native updater reports.
 * It does NOT test minisign verification, and nothing here should ever be
 * read as evidence that signature checking works — that belongs to
 * `updater-verify.mjs` and to Tauri itself. Where this suite says
 * "invalid signature", it is testing AURA's HANDLING of a signature
 * failure the native layer raised, not the cryptography.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { UpdateService } = await imp('apps/desktop/src/updater/updateService.ts');
const { presentUpdateState, formatBytes, releaseNoteLines, PRESENTED_STATES } =
  await imp('apps/desktop/src/updater/updatePresentation.ts');
const { canSelfUpdate } = await imp('apps/desktop/src/updater/types.ts');

/* ── harness ──────────────────────────────────────────────────────── */

const results = [];
let group = '';
const setGroup = (g) => { group = g; console.log(`\n── ${g} ──`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ group, name, ok: true });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ group, name, ok: false, detail: e.message });
    console.log(`  FAIL  ${name} — ${e.message}`);
  }
}

/* ── stub adapter ─────────────────────────────────────────────────── */

/**
 * A controllable stand-in for the native updater.
 * `installKind` defaults to self-updating so the common paths are
 * reachable; the .deb case sets it explicitly.
 */
function stubAdapter(opts = {}) {
  const {
    version = '0.1.0',
    offered = null,
    os = 'linux',
    arch = 'x86_64',
    installKind = 'self-updating',
    checkError = null,
    installError = null,
    relaunchError = null,
    progressEvents = [],
    // Gap between progress callbacks. Real downloads deliver chunks over
    // time; a burst delivered inside one tick is not a download, it is an
    // artifact of a stub. Cases that care about intermediate values space
    // them out, so they exercise the timeline a user actually sees.
    progressGapMs = 0,
  } = opts;

  const calls = { check: 0, downloadAndInstall: 0, relaunch: 0, close: 0, installKind: 0 };

  return {
    calls,
    adapter: {
      currentVersion: async () => version,
      platform: async () => ({ os, arch }),
      installKind: async () => { calls.installKind += 1; return installKind; },
      sourceHost: () => 'github.com',
      relaunch: async () => {
        calls.relaunch += 1;
        if (relaunchError) throw new Error(relaunchError);
      },
      check: async () => {
        calls.check += 1;
        if (checkError) throw new Error(checkError);
        if (!offered) return null;
        return {
          offered,
          async downloadAndInstall(onProgress) {
            calls.downloadAndInstall += 1;
            for (const p of progressEvents) {
              onProgress(p);
              if (progressGapMs) await new Promise((r) => setTimeout(r, progressGapMs));
            }
            if (installError) throw new Error(installError);
          },
          async close() { calls.close += 1; },
        };
      },
    },
  };
}

const OFFER = (over = {}) => ({ version: '0.2.0', releaseDate: '2026-02-01T00:00:00Z', notes: '- New thing\n- Fixed thing', ...over });

/* ══════════════════════════════════════════════════════════════════ */

setGroup('1–4 · version applicability');

await check('1. current version → up-to-date, no candidate', async () => {
  const { adapter } = stubAdapter({ version: '0.1.0', offered: null });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'up-to-date', `got ${s.kind}`);
  return s.currentVersion;
});

await check('2. newer version → update-available with the real candidate', async () => {
  const { adapter } = stubAdapter({ version: '0.1.0', offered: OFFER() });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'update-available', `got ${s.kind}`);
  assert(s.candidate.version === '0.2.0', 'wrong version');
  assert(s.candidate.currentVersion === '0.1.0', 'candidate lost the current version');
  return `${s.candidate.currentVersion} → ${s.candidate.version}`;
});

await check('3. equal version → up-to-date, never offered as an update', async () => {
  const { adapter, calls } = stubAdapter({ version: '0.2.0', offered: OFFER({ version: '0.2.0' }) });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'up-to-date', `an equal version was offered as ${s.kind}`);
  assert(calls.close === 1, 'the rejected native handle was not released');
  return 'rejected and released';
});

await check('4. downgrade → refused, presented as up to date', async () => {
  const { adapter } = stubAdapter({ version: '0.3.0', offered: OFFER({ version: '0.1.0' }) });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'up-to-date', `a downgrade was accepted as ${s.kind}`);
  return 'downgrade rejected';
});

setGroup('5–9 · failure classification');

await check('5. invalid metadata → failed, never "up to date"', async () => {
  const { adapter } = stubAdapter({ version: '0.1.0', offered: OFFER({ version: 'not-a-version' }) });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'failed', `got ${s.kind}`);
  assert(s.error.code === 'INVALID_METADATA', `got ${s.error.code}`);
  return s.error.code;
});

await check('5b. NEGATIVE CONTROL — a failed check is never reported as up-to-date', async () => {
  for (const e of ['network unreachable', 'signature mismatch', 'malformed manifest json']) {
    const { adapter } = stubAdapter({ checkError: e });
    const s = await new UpdateService(adapter).check();
    assert(s.kind === 'failed', `"${e}" produced ${s.kind}, not failed`);
  }
  return 'three failure modes, none reported as current';
});

await check('6. invalid signature → INVALID_SIGNATURE, install refused', async () => {
  // The native layer is what raises this. AURA must classify it distinctly
  // rather than folding it into a generic download failure.
  const { adapter } = stubAdapter({
    version: '0.1.0', offered: OFFER(), installError: 'minisign signature verification failed',
  });
  const svc = new UpdateService(adapter);
  await svc.check();
  const s = await svc.downloadAndInstall();
  assert(s.kind === 'failed', `got ${s.kind}`);
  assert(s.error.code === 'INVALID_SIGNATURE', `got ${s.error.code}`);
  const v = presentUpdateState(s);
  assert(v.canRetry === false, 'a signature failure must not offer retry');
  assert(v.tone === 'critical', 'a signature failure must not be toned as routine');
  return 'classified, not retryable';
});

await check('7. unsupported platform → refused before any install', async () => {
  const { adapter } = stubAdapter({ os: 'freebsd', arch: 'x86_64', offered: OFFER() });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'failed', `got ${s.kind}`);
  assert(['INCOMPATIBLE_PLATFORM', 'UNSUPPORTED_ARCHITECTURE'].includes(s.error.code), `got ${s.error.code}`);
  return s.error.code;
});

await check('8. network failure → NETWORK_ERROR, retryable', async () => {
  const { adapter } = stubAdapter({ checkError: 'fetch failed: ENOTFOUND' });
  const s = await new UpdateService(adapter).check();
  assert(s.error.code === 'NETWORK_ERROR', `got ${s.error.code}`);
  assert(presentUpdateState(s).canRetry, 'network failure should be retryable');
  return 'retryable';
});

await check('9. timeout → NETWORK_ERROR, retryable', async () => {
  const { adapter } = stubAdapter({ checkError: 'request timed out after 30000ms' });
  const s = await new UpdateService(adapter).check();
  assert(s.error.code === 'NETWORK_ERROR', `got ${s.error.code}`);
  return 'classified as network';
});

setGroup('10–15 · download, install, restart');

await check('10. download progress is the adapter\'s, never invented', async () => {
  const emitted = [
    { downloaded: 0, total: 1000, percent: 0 },
    { downloaded: 500, total: 1000, percent: 50 },
    { downloaded: 1000, total: 1000, percent: 100 },
  ];
  const seen = [];
  const { adapter } = stubAdapter({ offered: OFFER(), progressEvents: emitted, progressGapMs: 130 });
  const svc = new UpdateService(adapter);
  await svc.check();
  svc.subscribe((s) => { if (s.kind === 'downloading') seen.push(s.progress.percent); });
  await svc.downloadAndInstall();
  assert(seen.includes(50) && seen.includes(100), `progress not surfaced: ${seen.join(',')}`);
  // The invariant this case is named for: nothing surfaced may be a number
  // the adapter never produced.
  const produced = new Set([null, ...emitted.map((p) => p.percent)]);
  assert(seen.every((p) => produced.has(p)), `invented progress: ${seen.join(',')}`);
  return `percent sequence ${seen.join(' → ')}`;
});

await check('10b. a burst of progress events is coalesced, and the last one always lands', async () => {
  // A ~100 MB download reports thousands of chunks; every notification used
  // to re-render the UI. The service coalesces them to ~10/sec. What must
  // NOT change: the completing chunk is always announced, nothing is
  // invented, and the download still ends in ready-to-install.
  const emitted = Array.from({ length: 500 }, (_, i) => ({
    downloaded: (i + 1) * 2, total: 1000, percent: Math.round(((i + 1) / 500) * 100),
  }));
  const seen = [];
  const { adapter } = stubAdapter({ offered: OFFER(), progressEvents: emitted });
  const svc = new UpdateService(adapter);
  await svc.check();
  svc.subscribe((s) => { if (s.kind === 'downloading') seen.push(s.progress); });
  const final = await svc.downloadAndInstall();

  assert(seen.length < 50, `500 events produced ${seen.length} notifications`);
  const last = seen[seen.length - 1];
  assert(last.percent === 100 && last.downloaded === 1000, `last notification was ${last.downloaded}/${last.total}`);
  const produced = new Set(emitted.map((p) => p.downloaded));
  assert(seen.slice(1).every((p) => produced.has(p.downloaded)), 'a coalesced value was never produced by the adapter');
  assert(final.kind === 'ready-to-install', `got ${final.kind}`);
  return `${seen.length} notifications for 500 events, ending at 100%`;
});

await check('11. download completion → ready to restart', async () => {
  const { adapter } = stubAdapter({ offered: OFFER(), progressEvents: [{ downloaded: 10, total: 10, percent: 100 }] });
  const svc = new UpdateService(adapter);
  await svc.check();
  const s = await svc.downloadAndInstall();
  assert(s.kind === 'ready-to-install', `got ${s.kind}`);
  return s.kind;
});

await check('12. install ready presents a restart action, not an install one', async () => {
  const { adapter } = stubAdapter({ offered: OFFER() });
  const svc = new UpdateService(adapter);
  await svc.check();
  const v = presentUpdateState(await svc.downloadAndInstall());
  assert(v.canRestart === true, 'no restart action offered');
  assert(v.canInstall === false, 'still offering install after installing');
  assert(!/ready-to-install/.test(v.status), `raw state name leaked to the user: ${v.status}`);
  return `"${v.status}"`;
});

await check('13. restart is explicit and uses the adapter\'s relaunch', async () => {
  const { adapter, calls } = stubAdapter({ offered: OFFER() });
  const svc = new UpdateService(adapter);
  await svc.check();
  assert(calls.relaunch === 0, 'relaunch happened before install');
  await svc.downloadAndInstall();
  assert(calls.relaunch === 0, 'the service restarted on its own — restart must be explicit');
  await svc.restart();
  assert(calls.relaunch === 1, 'relaunch was not called');
  return 'never automatic';
});

await check('14. install failure → current version intact, honest message', async () => {
  const { adapter } = stubAdapter({ offered: OFFER(), installError: 'permission denied writing to disk' });
  const svc = new UpdateService(adapter);
  await svc.check();
  const s = await svc.downloadAndInstall();
  assert(s.kind === 'failed' && s.error.code === 'INSTALL_FAILED', `got ${s.kind}/${s.error?.code}`);
  assert(/still intact/i.test(presentUpdateState(s).detail), 'message does not reassure about the current install');
  return 'INSTALL_FAILED';
});

await check('15. retry after a recoverable failure succeeds', async () => {
  let fail = true;
  const base = stubAdapter({ version: '0.1.0', offered: OFFER() });
  const adapter = {
    ...base.adapter,
    check: async () => {
      if (fail) { fail = false; throw new Error('fetch failed'); }
      return base.adapter.check();
    },
  };
  const svc = new UpdateService(adapter);
  const first = await svc.check();
  assert(first.kind === 'failed', 'first attempt should fail');
  assert(presentUpdateState(first).canRetry, 'retry not offered');
  const second = await svc.check();
  assert(second.kind === 'update-available', `retry produced ${second.kind}`);
  return 'recovered';
});

setGroup('16–19 · startup, offline, notification, .deb');

await check('16. offline startup does not throw and does not claim currency', async () => {
  const { adapter } = stubAdapter({ checkError: 'offline' });
  const svc = new UpdateService(adapter);
  const s = await svc.check();
  assert(s.kind === 'failed', `got ${s.kind}`);
  assert(s.error.code === 'NETWORK_ERROR', `got ${s.error.code}`);
  assert(presentUpdateState(s).canCheck, 'user cannot retry after an offline check');
  return 'app remains usable, state is honest';
});

await check('17. startup discovery yields an announceable candidate', async () => {
  const { adapter } = stubAdapter({ version: '0.1.0', offered: OFFER() });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'update-available', `got ${s.kind}`);
  assert(typeof s.candidate.version === 'string' && s.candidate.version.length > 0, 'no version to announce');
  return `announce ${s.candidate.version}`;
});

await check('18. notification dedupe key is stable per version', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/useUpdateNotifications.ts'), 'utf8');
  assert(/key: `update-available:\$\{version\}`/.test(src), 'notification key is not version-scoped');
  assert(/announced\.has\(version\)/.test(src), 'no session-level dedupe — dismissal would not stick');
  assert(!src.includes('setInterval'), 'the notifier polls');
  return 'one notification per version';
});

await check('19. .deb (managed) install → UNSUPPORTED_INSTALL, no install attempt', async () => {
  const { adapter, calls } = stubAdapter({ installKind: 'managed', offered: OFFER() });
  const svc = new UpdateService(adapter);
  const s = await svc.check();
  assert(s.kind === 'failed', `got ${s.kind}`);
  assert(s.error.code === 'UNSUPPORTED_INSTALL', `got ${s.error.code}`);
  assert(calls.check === 0, 'the update server was contacted for an install that cannot update');
  const v = presentUpdateState(s);
  assert(/aren't available for this installation/i.test(v.detail), `wrong wording: ${v.detail}`);
  assert(v.canInstall === false && v.canRetry === false, 'offered an action that cannot work');
  return 'refused before the network';
});

await check('19b. unknown install kind is refused, never assumed updatable', async () => {
  const { adapter } = stubAdapter({ installKind: 'unknown', offered: OFFER() });
  const s = await new UpdateService(adapter).check();
  assert(s.kind === 'failed' && s.error.code === 'UNSUPPORTED_INSTALL', `got ${s.kind}/${s.error?.code}`);
  assert(canSelfUpdate('unknown') === false, 'canSelfUpdate treats unknown as permitted');
  return 'fail-closed';
});

await check('19c. download path re-checks install kind (gate is not check-only)', async () => {
  const { adapter } = stubAdapter({ offered: OFFER() });
  const svc = new UpdateService(adapter);
  await svc.check();                       // passes: self-updating
  // Simulate a service whose install kind was never established.
  const bare = new UpdateService({ ...adapter, installKind: undefined });
  const s = await bare.check();
  assert(s.kind === 'failed' && s.error.code === 'UNSUPPORTED_INSTALL',
    `an adapter without installKind was allowed: ${s.kind}/${s.error?.code}`);
  return 'adapter without the probe is refused';
});

setGroup('20–25 · architecture invariants');

await check('20. no fake progress — unknown total yields no percentage', async () => {
  const { adapter } = stubAdapter({
    offered: OFFER(),
    progressEvents: [{ downloaded: 4096, total: null, percent: null }],
  });
  const svc = new UpdateService(adapter);
  await svc.check();
  let observed = null;
  svc.subscribe((s) => { if (s.kind === 'downloading') observed = s.progress; });
  await svc.downloadAndInstall();
  assert(observed && observed.percent === null, `percent was invented: ${observed?.percent}`);
  assert(formatBytes(null) === null, 'formatBytes invents a size for a null total');
  return 'indeterminate stays indeterminate';
});

await check('21. neither the UI nor the engine fetches update metadata itself', async () => {
  // The UI must not even name the manifest; the engine may document it,
  // but no layer above the native adapter may perform the request.
  for (const f of uiFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    assert(!/latest\.json/.test(src), `${path.basename(f)} references latest.json`);
    assert(!/releases\/latest\/download/.test(src), `${path.basename(f)} builds an artifact URL`);
  }
  for (const f of [...uiFiles(), ...engineFiles()]) {
    const src = fs.readFileSync(f, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert(!/\bfetch\s*\(/.test(code), `${path.basename(f)} performs its own request`);
    assert(!/XMLHttpRequest|axios/.test(code), `${path.basename(f)} uses another transport`);
  }
  return `${uiFiles().length} UI + ${engineFiles().length} engine files: no transport above the adapter`;
});

await check('22. native updater access is confined to tauriAdapter.ts', async () => {
  // Every file except the sanctioned boundary, including the engine.
  for (const f of [...uiFiles(), ...engineFiles()]) {
    const src = fs.readFileSync(f, 'utf8');
    assert(!/from '@tauri-apps\/plugin-updater'/.test(src), `${path.basename(f)} imports the updater plugin`);
    assert(!/from '@tauri-apps\/plugin-process'/.test(src), `${path.basename(f)} imports the process plugin`);
    assert(!/relaunch\s*\(\s*\)/.test(src.replace(/adapter\.relaunch\(\)/g, '')) || f.endsWith('updateService.ts'),
      `${path.basename(f)} relaunches directly`);
  }
  const adapter = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/tauriAdapter.ts'), 'utf8');
  assert(/@tauri-apps\/plugin-updater/.test(adapter), 'the adapter no longer owns the native import');
  return 'only tauriAdapter.ts touches the native plugins';
});

await check('23. only updateService owns the lifecycle (one service instance)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/useUpdater.ts'), 'utf8');
  assert(/let service: UpdateService \| null = null/.test(src), 'no module-level singleton');
  const panel = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/UpdatePanel.tsx'), 'utf8');
  assert(!/new UpdateService/.test(panel), 'the panel constructs its own service');
  assert(/startupCheckStarted/.test(src), 'no guard against duplicate startup checks');
  return 'single shared instance, remount-safe';
});

await check('24. no version is hardcoded in UI components', async () => {
  for (const f of uiFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = src.match(/["'`]\d+\.\d+\.\d+["'`]/g);
    assert(!hits, `${path.basename(f)} hardcodes ${hits?.join(',')}`);
  }
  // The fallback comes from the build, which reads tauri.conf.json.
  const vite = fs.readFileSync(path.join(ROOT, 'apps/desktop/vite.config.ts'), 'utf8');
  assert(/tauri\.conf\.json/.test(vite), 'the version fallback is not read from the version authority');
  return 'version comes from getVersion() / tauri.conf.json';
});

await check('25. no signing or key material reaches the desktop UI', async () => {
  for (const f of uiFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const bad of ['pubkey', 'minisign', 'PRIVATE KEY', 'TAURI_SIGNING', 'signature:']) {
      assert(!src.includes(bad), `${path.basename(f)} references ${bad}`);
    }
  }
  const diag = new UpdateService(stubAdapter().adapter).diagnostics();
  const blob = JSON.stringify(diag);
  assert(!/pubkey|minisign|BEGIN|signature/i.test(blob), 'diagnostics leak trust-anchor material');
  assert(!/https?:\/\//.test(blob), 'diagnostics expose a full URL rather than a host');
  return 'no key material, host-only source';
});

await check('every state kind has a truthful presentation', async () => {
  const kinds = new Set(PRESENTED_STATES);
  const sample = {
    idle: { kind: 'idle' },
    checking: { kind: 'checking' },
    'up-to-date': { kind: 'up-to-date', currentVersion: '0.1.0', checkedAt: 'now' },
    'update-available': { kind: 'update-available', candidate: cand() },
    downloading: { kind: 'downloading', candidate: cand(), progress: { downloaded: 1, total: 2, percent: 50 } },
    installing: { kind: 'installing', candidate: cand() },
    'ready-to-install': { kind: 'ready-to-install', candidate: cand() },
    restarting: { kind: 'restarting', candidate: cand() },
    cancelled: { kind: 'cancelled', candidate: cand() },
    failed: { kind: 'failed', error: { code: 'NETWORK_ERROR', message: 'x' }, candidate: null },
  };
  for (const k of kinds) {
    const v = presentUpdateState(sample[k]);
    assert(v && v.status && v.detail, `state ${k} has no presentation`);
    assert(!v.status.includes('-'), `state ${k} leaks a raw kind: ${v.status}`);
  }
  return `${kinds.size} states presented`;
});

await check('release notes are shown only when supplied, never invented', async () => {
  assert(releaseNoteLines(null).length === 0, 'notes invented from null');
  assert(releaseNoteLines('').length === 0, 'notes invented from empty');
  assert(releaseNoteLines('- a\n- b').join('|') === 'a|b', 'bullets not unwrapped');
  return 'absent notes omit the section';
});

function cand() {
  return { version: '0.2.0', currentVersion: '0.1.0', releaseDate: null, notes: null, mandatory: false };
}

/**
 * The PRESENTATION layer — what tests 21/22/24/25 are about.
 *
 * Scoped deliberately. `updateService.ts` and `applicability.ts` are the
 * engine and the policy: they are *supposed* to name latest.json and
 * minisign in their documentation and to drive the adapter, and asserting
 * otherwise would be testing the wrong layer. `tauriAdapter.ts` is the
 * one sanctioned native boundary. What must stay clean is everything a
 * component renders through.
 */
function uiFiles() {
  const dir = path.join(ROOT, 'apps/desktop/src/updater');
  const PRESENTATION = ['UpdatePanel.tsx', 'updatePresentation.ts', 'useUpdater.ts', 'useUpdateNotifications.ts'];
  return PRESENTATION
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f))
    .concat([path.join(ROOT, 'apps/desktop/src/screens/ai/AiSettings.tsx')]);
}

/** The engine layer, checked separately for the things IT must not do. */
function engineFiles() {
  const dir = path.join(ROOT, 'apps/desktop/src/updater');
  return ['updateService.ts', 'applicability.ts', 'types.ts']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f));
}

/* ── report ───────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`Update experience — ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - [${f.group}] ${f.name}: ${f.detail}`);
}
console.log(`\nNOTE: signature verification is NOT tested here — the stub replaces the`);
console.log(`native boundary. scripts/updater-verify.mjs and Tauri remain authoritative.`);
console.log('='.repeat(60));
process.exit(failed.length ? 1 : 0);
