/**
 * updater-verify — the update engine's applicability and state machine.
 * ==================================================================
 * An updater is security infrastructure, so this suite is built around
 * what must NOT happen. Every security invariant carries a negative
 * control that reproduces the unsafe behaviour beside the safe one.
 *
 * ── What this suite does and does not prove ──────────────────────────
 * It exercises the parts AURA owns: version ordering, downgrade refusal,
 * target resolution, metadata validation, the state machine and every
 * failure path, plus configuration and secret hygiene.
 *
 * It does NOT prove minisign signature verification. That lives inside
 * `tauri-plugin-updater` (Rust) and can only be exercised against a real
 * signed artifact — which requires the production private key that is
 * deliberately not available here. Producing a "valid signature" fixture
 * would mean either holding that key or stubbing the verifier, and both
 * would make this suite lie about the thing that matters most. Signature
 * behaviour is proven in the release phase, against real signed builds.
 *
 * What IS proven here about signatures: AURA never bypasses the native
 * verifier, refuses metadata that carries no signature, and classifies a
 * native verification failure distinctly instead of hiding it.
 *
 * Usage: node scripts/updater-verify.mjs
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

/* ── bundle the engine (real source, never a reimplementation) ────── */
const outDir = mkdtempSync(path.join(tmpdir(), 'updater-'));
const bundle = (entry, name) => {
  const out = path.join(outDir, name);
  execFileSync('npx', [
    'esbuild', path.join(ROOT, entry),
    '--bundle', '--platform=node', '--format=esm',
    '--define:import.meta.env={}',
    `--outfile=${out}`,
  ], { cwd: ROOT, stdio: 'pipe' });
  return out;
};

const A = await import(bundle('apps/desktop/src/updater/applicability.ts', 'applicability.mjs'));
const S = await import(bundle('apps/desktop/src/updater/updateService.ts', 'service.mjs'));

const CURRENT = '0.1.1';
const LINUX = 'linux-x86_64';

/** A well-formed manifest in Tauri's own shape. */
const manifest = (version, platforms = [LINUX], extra = {}) => ({
  version,
  pub_date: '2026-08-15T00:00:00Z',
  notes: 'Release notes.',
  ...extra,
  platforms: Object.fromEntries(platforms.map((p) => [p, {
    signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpSV1FhYmM=',
    url: `https://github.com/example/releases/download/v${version}/AURA-Hub-${p}.tar.gz`,
  }])),
});

/* ══════════════════════════════════════════════════════════════════
   1–6 · version policy
   ══════════════════════════════════════════════════════════════════ */

const evalFull = (metadata, current = CURRENT, target = LINUX) =>
  A.evaluateCandidate({ currentVersion: current, target, metadata });

{
  const r = evalFull(manifest('0.1.2'));
  check('2. a valid newer release is applicable', r.applicable === true && r.candidate.version === '0.1.2');
  check('3. a higher PATCH is applicable', evalFull(manifest('0.1.2')).applicable === true);
  check('4. a higher MINOR is applicable', evalFull(manifest('0.2.0')).applicable === true);
  check('4b. a higher MAJOR is applicable', evalFull(manifest('1.0.0')).applicable === true);
}
{
  const r = evalFull(manifest('0.1.1'));
  check('5. an EQUAL version is refused', r.applicable === false && r.code === 'DOWNGRADE_REJECTED', r.code);
}
{
  const r = evalFull(manifest('0.1.0'));
  check('6. THE DOWNGRADE — an older version is refused',
    r.applicable === false && r.code === 'DOWNGRADE_REJECTED', r.detail);
  const major = evalFull(manifest('0.0.9'));
  check('6b. a lower minor/patch is refused too', major.applicable === false && major.code === 'DOWNGRADE_REJECTED');
}
{
  // Pre-release ordering: 0.2.0-beta.1 < 0.2.0, and both are > 0.1.1.
  check('6c. a pre-release ranks below its own release',
    A.compareVersions(A.parseVersion('0.2.0-beta.1'), A.parseVersion('0.2.0')) === -1);
  check('6d. numeric pre-release identifiers compare numerically',
    A.compareVersions(A.parseVersion('0.2.0-beta.2'), A.parseVersion('0.2.0-beta.10')) === -1);
}

/* ══════════════════════════════════════════════════════════════════
   7–10 · metadata and signature policy
   ══════════════════════════════════════════════════════════════════ */
{
  const malformed = [
    ['not an object', 'a string'],
    ['null', null],
    ['an array', []],
    ['no version', { platforms: { [LINUX]: { signature: 's', url: 'https://x/y' } } }],
    ['a junk version', manifest('not-a-version')],
    ['no platforms map', { version: '0.1.2' }],
    ['an empty platforms map', { version: '0.1.2', platforms: {} }],
    ['a platform that is not an object', { version: '0.1.2', platforms: { [LINUX]: 'nope' } }],
    ['a non-boolean mandatory', manifest('0.1.2', [LINUX], { mandatory: 'yes' })],
  ];
  for (const [label, bad] of malformed) {
    const r = evalFull(bad);
    check(`7. malformed metadata rejected — ${label}`,
      r.applicable === false && (r.code === 'INVALID_METADATA'), r.code);
  }
}
{
  // A platform entry with no signature can never become installable.
  const noSig = { version: '0.1.2', platforms: { [LINUX]: { url: 'https://x/y', signature: '' } } };
  const r = evalFull(noSig);
  check('10. MISSING SIGNATURE — metadata without a signature is refused',
    r.applicable === false && r.code === 'INVALID_METADATA', r.detail);

  const noSigField = { version: '0.1.2', platforms: { [LINUX]: { url: 'https://x/y' } } };
  check('10b. a platform entry with no signature field at all is refused',
    evalFull(noSigField).applicable === false);
}
{
  // Signed metadata may not point at a non-https artifact.
  const plain = { version: '0.1.2', platforms: { [LINUX]: { signature: 'sig', url: 'http://x/y' } } };
  check('10c. a non-https artifact URL is refused', evalFull(plain).applicable === false);
}

/* ══════════════════════════════════════════════════════════════════
   11–13 · platform and architecture safety
   ══════════════════════════════════════════════════════════════════ */
{
  check('11. resolveTarget maps the four shipped targets', [
    A.resolveTarget('linux', 'x86_64') === 'linux-x86_64',
    A.resolveTarget('windows', 'x86_64') === 'windows-x86_64',
    A.resolveTarget('darwin', 'x86_64') === 'darwin-x86_64',
    A.resolveTarget('darwin', 'aarch64') === 'darwin-aarch64',
  ].every(Boolean));

  check('11b. an unknown OS resolves to nothing', A.resolveTarget('plan9', 'x86_64') === null);
  check('12. an unsupported ARCHITECTURE resolves to nothing',
    A.resolveTarget('linux', 'riscv64') === null && A.resolveTarget('linux', 'i686') === null);
}
{
  // THE WRONG-PLATFORM CASE: a Linux client, a manifest offering only Windows.
  const r = evalFull(manifest('0.1.2', ['windows-x86_64']), CURRENT, LINUX);
  check('11c. THE WRONG PLATFORM — a Linux client refuses a Windows-only release',
    r.applicable === false && r.code === 'MISSING_ARTIFACT', r.detail);

  const macOnly = evalFull(manifest('0.1.2', ['darwin-aarch64', 'darwin-x86_64']), CURRENT, LINUX);
  check('11d. …and refuses a macOS-only release', macOnly.applicable === false);

  const unresolved = evalFull(manifest('0.1.2'), CURRENT, null);
  check('11e. an unresolvable target refuses everything',
    unresolved.applicable === false && unresolved.code === 'INCOMPATIBLE_PLATFORM');

  const bogus = evalFull(manifest('0.1.2', ['linux-riscv64']), CURRENT, 'linux-riscv64');
  check('12b. an unsupported target string is refused',
    bogus.applicable === false && bogus.code === 'UNSUPPORTED_ARCHITECTURE', bogus.code);
}
{
  const r = evalFull(manifest('0.1.2', ['darwin-aarch64']), CURRENT, LINUX);
  check('13. MISSING ARTIFACT — a release with no artifact for us is refused, and says what it does offer',
    r.applicable === false && r.code === 'MISSING_ARTIFACT' && r.detail.includes('darwin-aarch64'));
}
{
  // An unusable installed version must never be treated as "anything is newer".
  const r = evalFull(manifest('0.1.2'), 'garbage');
  check('13b. an unreadable INSTALLED version refuses the update',
    r.applicable === false && r.code === 'INVALID_METADATA', r.code);
}

/* ══════════════════════════════════════════════════════════════════
   State machine · 1, 14–18
   ══════════════════════════════════════════════════════════════════ */

/** Adapter stub. Drives every branch without a native runtime. */
function stubAdapter(over = {}) {
  return {
    currentVersion: async () => CURRENT,
    platform: async () => ({ os: 'linux', arch: 'x86_64' }),
    check: async () => null,
    relaunch: async () => {},
    sourceHost: () => 'github.com',
    // What a real desktop adapter reports: an AppImage on Linux, and every
    // Windows/macOS install, can replace itself. Overridable per case —
    // the managed (.deb) refusal is exercised at the end of this file.
    installKind: async () => 'self-updating',
    ...over,
  };
}
const offered = (version, extra = {}) => ({
  offered: { version, releaseDate: '2026-08-15T00:00:00Z', notes: 'n', ...extra },
  downloadAndInstall: async () => {},
  close: async () => {},
});

{
  const svc = new S.UpdateService(stubAdapter());
  const st = await svc.check();
  check('1. NO UPDATE — the engine reports up to date',
    st.kind === 'up-to-date' && st.currentVersion === CURRENT, st.kind);
}
{
  const svc = new S.UpdateService(stubAdapter({ check: async () => offered('0.1.2') }));
  const st = await svc.check();
  check('2b. an offered newer version surfaces as update-available',
    st.kind === 'update-available' && st.candidate.version === '0.1.2', st.kind);
}
{
  // A server offering an older build must not move the engine off up-to-date.
  const svc = new S.UpdateService(stubAdapter({ check: async () => offered('0.1.0') }));
  const st = await svc.check();
  check('6e. THE SERVER CANNOT FORCE A DOWNGRADE — engine stays up to date',
    st.kind === 'up-to-date', st.kind);
  check('6f. …and the refusal is recorded in diagnostics',
    svc.diagnostics().errorCode === 'DOWNGRADE_REJECTED', svc.diagnostics().errorCode);
}
{
  // The reinstall loop: a server offering exactly what is installed must
  // not start a download, or every check becomes an install.
  const svc = new S.UpdateService(stubAdapter({ check: async () => offered(CURRENT) }));
  const st = await svc.check();
  check('5b. AN IDENTICAL VERSION IS NOT REINSTALLED — engine stays up to date',
    st.kind === 'up-to-date', st.kind);
  check('5c. …and the reason is recorded',
    svc.diagnostics().errorCode === 'DOWNGRADE_REJECTED', svc.diagnostics().errorCode);
  const after = await svc.downloadAndInstall();
  check('5d. …with nothing pending to install',
    after.kind === 'failed' && after.error.code === 'INSTALL_FAILED', after.kind);
}
{
  const svc = new S.UpdateService(stubAdapter({
    platform: async () => ({ os: 'plan9', arch: 'x86_64' }),
    check: async () => offered('0.1.2'),
  }));
  const st = await svc.check();
  check('11f. an unsupported platform fails closed',
    st.kind === 'failed' && st.error.code === 'INCOMPATIBLE_PLATFORM', st.kind);
}

/* ══════════════════════════════════════════════════════════════════
   CHECK MUST SETTLE · X1–X8

   The v0.1.2 regression, in one sentence: `adapter.platform()` threw —
   on every platform, because the OS plugin's Rust half was never
   registered — and `check()` guarded only the network call, so the
   exception escaped and left the state on `checking`. The panel showed
   "Looking for a newer version…" for ever, with no error and no retry.

   Every stub in this file implemented `platform()` correctly, which is
   precisely why a green suite said nothing about it. These cases exist
   so a throw ANYWHERE in the check path is a visible failure, and so
   `checking` can never be a resting state again.
   ══════════════════════════════════════════════════════════════════ */
{
  // THE REGRESSION ITSELF. `window.__TAURI_OS_PLUGIN_INTERNALS__` is
  // undefined when the plugin is missing, so reading `.platform` throws
  // exactly this.
  const svc = new S.UpdateService(stubAdapter({
    platform: async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'platform')");
    },
  }));
  const st = await svc.check();
  check('X1. THE v0.1.2 DEFECT — platform() throwing settles as failed, not checking',
    st.kind === 'failed', st.kind);
  check('X1b. …and never rests on checking',
    st.kind !== 'checking', st.kind);
  check('X1c. …reported as a CHECK failure, not a false "install failed"',
    svc.diagnostics().errorCode === 'CHECK_FAILED', svc.diagnostics().errorCode);
}
{
  // A rejection at the very first await, before anything is known.
  const svc = new S.UpdateService(stubAdapter({
    currentVersion: async () => { throw new Error('no version'); },
  }));
  const st = await svc.check();
  check('X2. a throw at the FIRST step also settles as failed', st.kind === 'failed', st.kind);
}
{
  // A synchronous throw, not a rejected promise — a different failure
  // shape that must not escape either.
  const svc = new S.UpdateService(stubAdapter({
    installKind: () => { throw new TypeError('invoke is not a function'); },
  }));
  const st = await svc.check();
  check('X3. a SYNCHRONOUS throw settles as failed too', st.kind === 'failed', st.kind);
}
{
  // Resolution failure, distinct from a throw: the adapter answers, but
  // with an os/arch this product publishes nothing for. Answered before
  // the network — an offer-less release must not read as "up to date"
  // to someone who can never be updated.
  let reachedNetwork = false;
  const svc = new S.UpdateService(stubAdapter({
    platform: async () => ({ os: 'haiku', arch: 'sparc' }),
    check: async () => { reachedNetwork = true; return null; },
  }));
  const st = await svc.check();
  check('X4. an unresolvable platform fails closed rather than reporting up-to-date',
    st.kind === 'failed' && st.error.code === 'INCOMPATIBLE_PLATFORM', `${st.kind}/${st.error?.code}`);
  check('X4b. …and does not touch the network to find that out', !reachedNetwork);
}
{
  // A failed check must be retryable. The v0.1.2 defect also left `busy`
  // reachable only through a path that never ran, so a stuck check could
  // not be cleared by asking again.
  let attempts = 0;
  const svc = new S.UpdateService(stubAdapter({
    platform: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('undefined is not an object');
      return { os: 'linux', arch: 'x86_64' };
    },
    check: async () => offered('9.9.9'),
  }));
  const first = await svc.check();
  const second = await svc.check();
  check('X5. a failed check does not wedge the service — retry works',
    first.kind === 'failed' && second.kind === 'update-available',
    `${first.kind} → ${second.kind}`);
}
{
  // The background caller's last-resort path. `check()` settles its own
  // state, so this only fires if a rejection escapes it — and it must
  // still be observable rather than swallowed.
  const svc = new S.UpdateService(stubAdapter());
  svc.reportCheckFailure(new Error('getaddrinfo ENOTFOUND github.com'));
  check('X6. reportCheckFailure only acts while checking, never clobbering a settled state',
    svc.getState().kind === 'idle', svc.getState().kind);

  const stuck = new S.UpdateService(stubAdapter({
    platform: () => new Promise(() => {}), // never settles
  }));
  void stuck.check();
  await new Promise((r) => setTimeout(r, 5));
  check('X6b. …and a check that cannot settle is still sitting on checking',
    stuck.getState().kind === 'checking', stuck.getState().kind);

  /* The reporter's contract is ENFORCED, not merely documented: while a
     check is genuinely in flight it declines to act. Clearing the way for
     a second check beside a running one is how the first one's `finally`
     would come back and overwrite the second one's result. The legitimate
     caller — a `.catch()` on a REJECTED check — is never turned away,
     because a rejected promise has already run that `finally`. */
  stuck.reportCheckFailure(new Error('boom'));
  check('X6c. the reporter refuses to act while a check is still in flight',
    stuck.getState().kind === 'checking', stuck.getState().kind);
  check('X6d. …and it never fabricates a successful outcome',
    !['ready-to-install', 'up-to-date', 'update-available'].includes(stuck.getState().kind));
}
{
  /* The enforcement must be structural, not a comment. */
  const src = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/updateService.ts'), 'utf8');
  const body = src.slice(src.indexOf('reportCheckFailure('), src.indexOf('/* ── check'));
  check('X6e. the guard is in the code, not only in the prose',
    /checkInFlight/.test(body) && /this\.state\.kind !== 'checking'/.test(body));
  check('X6f. …and the reporter does not reset the busy flag it no longer owns',
    !/this\.busy\s*=/.test(body), 'busy is released by check() itself');
}
{
  // NEGATIVE CONTROLS. The fix must not have bought "always fails".
  const upToDate = new S.UpdateService(stubAdapter());
  const a = await upToDate.check();
  check('X7. the normal UP-TO-DATE path still works', a.kind === 'up-to-date', a.kind);

  const available = new S.UpdateService(stubAdapter({ check: async () => offered('9.9.9') }));
  const b = await available.check();
  check('X8. the normal UPDATE-AVAILABLE path still works',
    b.kind === 'update-available' && b.candidate.version === '9.9.9', b.kind);
}
{
  // The source-level invariant, so this cannot regress by deletion:
  // `check()` must have a catch, and the background caller must not
  // swallow. An empty catch is what hid the defect for a whole release.
  const svcSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/updateService.ts'), 'utf8');
  const body = svcSrc.slice(svcSrc.indexOf('async check('), svcSrc.indexOf('async downloadAndInstall('));
  check('X9. check() has a catch, not only a finally',
    /\}\s*catch\s*\(/.test(body) && /finally\s*\{/.test(body));

  const hookSrc = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/useUpdater.ts'), 'utf8');
  const stripped = hookSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('X10. the background check does not swallow its rejection',
    /\.catch\(\s*\([^)]*\)\s*=>\s*\{?\s*[a-zA-Z]/.test(stripped), 'catch has a body that does something');
}

/* ══════════════════════════════════════════════════════════════════
   PROGRESS COALESCING · C1–C8

   The native updater reports progress once per network chunk — for a
   ~100 MB artifact, thousands of callbacks, each previously notifying
   every subscriber and so re-rendering the UI. These cases pin what the
   coalescing may and may not do: it may reduce how OFTEN subscribers are
   told, and it may not alter a byte, a state, or an ordering.
   ══════════════════════════════════════════════════════════════════ */

/** Drive N progress callbacks through a real service and count what escapes. */
async function runProgress(events, { spreadMs = 0 } = {}) {
  const seen = [];
  const svc = new S.UpdateService(stubAdapter({
    check: async () => ({
      ...offered('9.9.9'),
      downloadAndInstall: async (onProgress) => {
        for (let i = 0; i < events; i += 1) {
          const downloaded = Math.round(((i + 1) / events) * 1_000_000);
          onProgress({ downloaded, total: 1_000_000, percent: Math.round(((i + 1) / events) * 100) });
          if (spreadMs) await new Promise((r) => setTimeout(r, spreadMs));
        }
      },
    }),
  }));
  await svc.check();
  svc.subscribe((s) => { if (s.kind === 'downloading') seen.push(s.progress); });
  const final = await svc.downloadAndInstall();
  return { seen, final, svc };
}

{
  // 5,000 chunks delivered as fast as the event loop allows — the shape of
  // a fast local download of a large artifact.
  const { seen, final, svc } = await runProgress(5000);

  check('C1. thousands of progress events do not become thousands of UI updates',
    seen.length < 200, `${seen.length} notifications for 5000 events`);
  check('C2. …and the reduction is large, not cosmetic',
    seen.length < 5000 / 20, `${(5000 / Math.max(seen.length, 1)).toFixed(0)}x fewer`);

  // The bytes must survive intact: the last notification is the completing
  // chunk, never a stale one frozen mid-download.
  const last = seen[seen.length - 1];
  check('C3. the COMPLETING chunk is always announced, never throttled away',
    last && last.downloaded === 1_000_000 && last.percent === 100,
    last ? `${last.downloaded}/${last.total} ${last.percent}%` : 'nothing seen');
  check('C4. diagnostics still report the exact final byte count',
    svc.diagnostics().progress?.downloaded === 1_000_000,
    String(svc.diagnostics().progress?.downloaded));

  // Coalescing must not touch the outcome.
  check('C5. the state still settles on ready-to-install', final.kind === 'ready-to-install', final.kind);
  check('C6. …and no automatic restart happened', final.kind !== 'restarting');

  // NEGATIVE CONTROL: no notification may claim more than was downloaded.
  check('C7. no notification reports progress that never happened',
    seen.every((p) => p.downloaded <= 1_000_000 && p.percent <= 100 && p.downloaded >= 0));
  const monotonic = seen.every((p, i) => i === 0 || p.downloaded >= seen[i - 1].downloaded);
  check('C8. progress never goes backwards', monotonic);
}
{
  // A slow download must still animate: spacing events beyond the coalescing
  // window must let each one through, or the fix would have traded a storm
  // for a frozen bar.
  // `seen` also holds the opening `downloading` state (0 bytes) that
  // `downloadAndInstall` sets before the first chunk arrives, so six
  // well-spaced chunks must produce exactly seven notifications.
  const { seen } = await runProgress(6, { spreadMs: 130 });
  check('C9. a slow download still updates on every chunk',
    seen.length === 7, `${seen.length} notifications = 1 opening + ${seen.length - 1}/6 chunks`);
}
{
  // A failed install must still fail, coalescing or not.
  const svc = new S.UpdateService(stubAdapter({
    check: async () => ({
      ...offered('9.9.9'),
      downloadAndInstall: async (onProgress) => {
        for (let i = 0; i < 500; i += 1) onProgress({ downloaded: i, total: 500, percent: 0 });
        throw new Error('permission denied writing to disk');
      },
    }),
  }));
  await svc.check();
  const st = await svc.downloadAndInstall();
  check('C10. an install that throws after a progress storm still fails closed',
    st.kind === 'failed' && st.error.code === 'INSTALL_FAILED', `${st.kind}/${st.error?.code}`);
}
{
  const svc = new S.UpdateService(stubAdapter({
    check: async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); },
  }));
  const st = await svc.check();
  check('14. NETWORK FAILURE — classified, and the app keeps running',
    st.kind === 'failed' && st.error.code === 'NETWORK_ERROR', st.error?.code);
  check('14b. a second check is still possible afterwards',
    (await new S.UpdateService(stubAdapter()).check()).kind === 'up-to-date');
}
{
  const svc = new S.UpdateService(stubAdapter({
    check: async () => ({ ...offered('0.1.2'), downloadAndInstall: async () => { throw new Error('connection reset during download'); } }),
  }));
  await svc.check();
  const st = await svc.downloadAndInstall();
  check('15. DOWNLOAD INTERRUPTION — reported as a download failure',
    st.kind === 'failed' && st.error.code === 'DOWNLOAD_FAILED', st.error?.code);
}
{
  const svc = new S.UpdateService(stubAdapter({
    check: async () => ({ ...offered('0.1.2'), downloadAndInstall: async () => { throw new Error('Permission denied writing to install directory'); } }),
  }));
  await svc.check();
  const st = await svc.downloadAndInstall();
  check('16. INSTALL FAILURE — reported as an install failure',
    st.kind === 'failed' && st.error.code === 'INSTALL_FAILED', st.error?.code);
}
{
  // The signature failure the native updater raises must stay distinct.
  const svc = new S.UpdateService(stubAdapter({
    check: async () => ({ ...offered('0.1.2'), downloadAndInstall: async () => { throw new Error('Update signature verification failed'); } }),
  }));
  await svc.check();
  const st = await svc.downloadAndInstall();
  check('8. INVALID SIGNATURE — surfaced distinctly, never as a generic failure',
    st.kind === 'failed' && st.error.code === 'INVALID_SIGNATURE', st.error?.code);
  check('8b. …and the message does not claim success',
    !/success|updated/i.test(st.error.message));
}
{
  const seen = [];
  const svc = new S.UpdateService(stubAdapter({
    check: async () => ({
      ...offered('0.1.2'),
      downloadAndInstall: async (onProgress) => {
        onProgress({ downloaded: 0, total: 100, percent: 0 });
        onProgress({ downloaded: 50, total: 100, percent: 50 });
        onProgress({ downloaded: 100, total: 100, percent: 100 });
      },
    }),
  }));
  svc.subscribe((s) => seen.push(s.kind));
  await svc.check();
  const st = await svc.downloadAndInstall();
  check('17. the happy path settles at ready-to-install, NOT installed-and-restarted',
    st.kind === 'ready-to-install', st.kind);
  check('17b. it passed through checking → update-available → downloading',
    seen.includes('checking') && seen.includes('update-available') && seen.includes('downloading'),
    seen.join(' → '));

  let relaunched = false;
  const svc2 = new S.UpdateService(stubAdapter({
    check: async () => offered('0.1.2'),
    relaunch: async () => { relaunched = true; },
  }));
  await svc2.check();
  await svc2.downloadAndInstall();
  const rs = await svc2.restart();
  check('17c. RESTART is explicit and only happens when asked',
    relaunched === true && rs.kind === 'restarting', rs.kind);
}
{
  const svc = new S.UpdateService(stubAdapter({ check: async () => offered('0.1.2') }));
  await svc.check();
  const st = await svc.cancel();
  check('18. CANCELLATION before download leaves nothing installed',
    st.kind === 'cancelled', st.kind);
  const after = await svc.downloadAndInstall();
  check('18b. a cancelled update cannot then be installed',
    after.kind === 'failed', after.kind);
}
{
  const svc = new S.UpdateService(stubAdapter({ check: async () => offered('0.1.2') }));
  await svc.check();
  const d = svc.diagnostics();
  check('D. diagnostics report state without secrets',
    d.currentVersion === CURRENT && d.candidateVersion === '0.1.2'
    && d.target === LINUX && d.updateSource === 'github.com');
  const blob = JSON.stringify(d);
  check('D2. diagnostics contain no signature or key material',
    !/signature|minisign|BEGIN|privkey|secret/i.test(blob));
}

/* ══════════════════════════════════════════════════════════════════
   Managed installations · a .deb cannot replace itself
   ══════════════════════════════════════════════════════════════════ */

{
  // The updater replaces an AppImage in place. A package-manager install
  // has nothing for it to replace, so it must refuse BEFORE the network
  // rather than fail at the last step with a broken half-install.
  const svc = new S.UpdateService(stubAdapter({
    installKind: async () => 'managed',
    check: async () => { throw new Error('the update server must not be contacted'); },
  }));
  const st = await svc.check();
  check('P1. a managed (.deb) install refuses before contacting the server',
    st.kind === 'failed' && st.error.code === 'UNSUPPORTED_INSTALL', `${st.kind}/${st.error?.code ?? '-'}`);
  check('P2. …and diagnostics say which kind of install it is',
    svc.diagnostics().installKind === 'managed', svc.diagnostics().installKind);
}

{
  // Fail closed: an adapter that cannot say is never assumed updatable.
  const svc = new S.UpdateService(stubAdapter({ installKind: async () => 'unknown' }));
  const st = await svc.check();
  check('P3. an undetermined install kind is refused, not assumed',
    st.kind === 'failed' && st.error.code === 'UNSUPPORTED_INSTALL', `${st.kind}/${st.error?.code ?? '-'}`);
}

{
  // The gate is re-checked on the install path, not only on check().
  const svc = new S.UpdateService(stubAdapter({ installKind: undefined }));
  const st = await svc.check();
  check('P4. an adapter with no install probe at all is refused',
    st.kind === 'failed' && st.error.code === 'UNSUPPORTED_INSTALL', `${st.kind}/${st.error?.code ?? '-'}`);
}

/* ══════════════════════════════════════════════════════════════════
   19–20 · secrets and configuration integrity
   ══════════════════════════════════════════════════════════════════ */
{
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const pubkey = conf.plugins?.updater?.pubkey ?? '';
  const decoded = Buffer.from(pubkey, 'base64').toString('utf8');

  check('20. the updater is configured with a public key',
    typeof pubkey === 'string' && pubkey.length > 0);
  check('20b. it is a minisign PUBLIC key, not a private one',
    decoded.includes('minisign public key') && !decoded.includes('secret key'), decoded.split('\n')[0]);
  check('20c. updater artifacts are enabled', conf.bundle?.createUpdaterArtifacts === true);
  check('20d. the endpoint is https', (conf.plugins?.updater?.endpoints ?? []).every((u) => /^https:\/\//.test(u)));

  const caps = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/capabilities/default.json'), 'utf8'));
  check('20e. updater + restart permissions are granted',
    caps.permissions.includes('updater:default') && caps.permissions.includes('process:allow-restart'));
  check('20f. the broader process:default is NOT granted',
    !caps.permissions.includes('process:default'),
    'only the restart is allowed, not arbitrary process control');
}
{
  /*
   * Enabling updater artifacts is not a free switch. With a pubkey
   * configured, the Tauri CLI refuses to build at all unless a private key
   * is supplied — so every workflow that bundles the app must pass one, or
   * packaging breaks on all four platforms at once. That coupling lives in
   * two files and is exactly the kind of thing that rots silently.
   */
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const buildsBundles = /tauri .*-- build|tauri build/.test(ci);
  const passesKey = /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\./.test(ci);

  check('22. a workflow that bundles the app supplies the signing key',
    !(conf.bundle?.createUpdaterArtifacts && buildsBundles) || passesKey,
    passesKey ? 'passed by secrets reference' : 'MISSING — every desktop build will fail');

  // NEGATIVE CONTROL: by reference only. A literal key in the workflow is
  // the failure this check exists to prevent, not a shortcut to green.
  check('22b. the key is referenced, never inlined',
    !/TAURI_SIGNING_PRIVATE_KEY:\s*(?!\$\{\{)[A-Za-z0-9+/=]{8,}/.test(ci),
    'no literal key material in CI');
  check('22c. signing is not disabled to dodge the requirement',
    !/--no-sign/.test(ci), 'no --no-sign escape hatch');
}
{
  /*
   * NEGATIVE CONTROL: a private key anywhere in tracked files must fail.
   *
   * The markers are assembled from fragments so this file does not match
   * its own pattern. The obvious alternative — skipping the scanner when
   * scanning — would carve out the one file guaranteed to mention key
   * formats, and a key pasted into a fixture here would go unseen. Every
   * tracked file is scanned, this one included.
   */
  const SECRET = `${'PRIVATE'} ${'KEY'}`;
  const KEY_MARKERS = new RegExp(
    [
      `minisign encrypted ${'secret'} ${'key'}`,
      `rsign encrypted ${'secret'} ${'key'}`,
      `untrusted comment: minisign ${'secret'} ${'key'}`,
      `BEGIN (RSA |OPENSSH |EC )?${SECRET}`,
    ].join('|'),
    'i',
  );

  /*
   * The Tauri CLI writes its key files BASE64-ENCODED, and the comment
   * naming them a secret key lives inside that base64. A plaintext scan
   * sees none of it and reports a clean tree while the key sits in it —
   * so each file is tested as text and, when it is a single base64 blob,
   * as its decoding. A public key decodes to "public key" and is not a
   * finding; only a secret is.
   */
  const decodedIfBase64 = (src) => {
    const compact = src.trim();
    if (compact.length < 40 || compact.length > 100_000) return null;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(compact)) return null;
    try { return Buffer.from(compact, 'base64').toString('utf8'); } catch { return null; }
  };
  const holdsKeyMaterial = (text) =>
    [text, decodedIfBase64(text)].filter(Boolean).some((b) => KEY_MARKERS.test(b));

  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const offenders = [];
  for (const f of tracked) {
    const p = path.join(ROOT, f);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (holdsKeyMaterial(text)) {
      offenders.push(f);
    }
  }
  check('19. SECRET SCAN — no private signing key in any tracked file',
    offenders.length === 0, offenders.join(', ') || 'clean');

  // The scanner must be able to find what it claims to find. Without this,
  // the base64 blind spot above would have kept case 19 green forever.
  const asKeyFile = (comment) => Buffer.from(
    `untrusted comment: ${comment}\nRWRTY0IyaVYydXVCNUl4djhTcTBxa1lvcld4R213SXNL\n`, 'utf8',
  ).toString('base64');
  check('19a. …and the scanner FIRES on a base64 Tauri key file',
    holdsKeyMaterial(asKeyFile(`rsign encrypted ${'secret'} ${'key'}`)),
    'a committed key would be caught');
  check('19a2. …while a public key, which is not a secret, passes',
    !holdsKeyMaterial(asKeyFile('minisign public key')), 'trust anchors are expected in the tree');

  const keyPath = path.join(process.env.HOME ?? '', '.aura', 'aura-updater.key');
  check('19b. the operator key lives outside the repository',
    !fs.existsSync(path.join(ROOT, 'aura-updater.key')) && !tracked.some((f) => f.includes('aura-updater.key')),
    `operator key expected at ${keyPath} — never read by this suite`);
}
{
  // NEGATIVE CONTROL: the engine must never fetch or execute on its own.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const files = ['types.ts', 'applicability.ts', 'updateService.ts', 'tauriAdapter.ts']
    .map((f) => [f, strip(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater', f), 'utf8'))]);

  for (const [name, src] of files) {
    check(`21. ${name} performs no download or execution of its own`,
      !/child_process|execFile|spawn\(|\bfetch\(|XMLHttpRequest|eval\(/.test(src));
  }
  const adapter = files.find(([n]) => n === 'tauriAdapter.ts')[1];
  check('21b. only the adapter imports the native updater',
    adapter.includes('@tauri-apps/plugin-updater'));
  const service = files.find(([n]) => n === 'updateService.ts')[1];
  check('21c. the service never imports it',
    !service.includes('@tauri-apps/plugin-updater') && !service.includes('@tauri-apps/plugin-process'));
}

/* ── version authority ────────────────────────────────────────────── */
{
  const read = (f, re) => (re.exec(fs.readFileSync(path.join(ROOT, f), 'utf8')) ?? [])[1];
  const versions = {
    'package.json': read('package.json', /"version":\s*"([^"]+)"/),
    'apps/desktop/package.json': read('apps/desktop/package.json', /"version":\s*"([^"]+)"/),
    'tauri.conf.json': read('apps/desktop/src-tauri/tauri.conf.json', /"version":\s*"([^"]+)"/),
    'Cargo.toml': read('apps/desktop/src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m),
    'Cargo.lock': read('apps/desktop/src-tauri/Cargo.lock', /name = "aura-hub"\nversion = "([^"]+)"/),
  };
  const unique = [...new Set(Object.values(versions))];
  check('V. every version source agrees', unique.length === 1, JSON.stringify(versions));

  /*
   * A deliberately HAND-SET pin, and the only place a version is written
   * down outside the six files the bump tool rewrites.
   *
   * V above proves the six agree with each other, which a stray global
   * find-and-replace would also satisfy. This proves they agree with what
   * a person last decided to ship. It therefore has to be edited by hand
   * at each release — that edit IS the check, and `bump-version.mjs`
   * deliberately does not touch it.
   *
   * 0.1.2 is the first updater-enabled release: the first built by the
   * repaired pipeline, and the first whose artifacts a client can
   * actually fetch and verify.
   */
  const RELEASE_CANDIDATE = '0.1.2';
  check('V2. the release candidate version is preserved', unique[0] === RELEASE_CANDIDATE, unique[0]);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
