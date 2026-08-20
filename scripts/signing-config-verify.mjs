/**
 * signing-config-verify — the signing gate never fakes a success.
 * ==================================================================
 * The one property that matters about a signing pipeline you cannot yet
 * run — because there are no certificates — is that it does the RIGHT
 * thing about their absence: it refuses loudly when signing was asked
 * for and the material is missing, it ships honestly unsigned when
 * signing was not asked for, and it never once reports an artifact
 * signed that it did not sign.
 *
 * That decision logic is pure and testable on any machine, so it is
 * tested here, exhaustively, with the missing-credential case as the
 * central control. The actual signtool/codesign invocations cannot run
 * on Linux and are NOT exercised — that is stated, not hidden.
 *
 * Run:  node scripts/signing-config-verify.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SIGN = path.join(ROOT, 'scripts', 'sign-desktop.mjs');
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'aura-sign-verify-'));

let failed = 0, passed = 0;
const check = (n, ok, extra = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`); };
const control = (n, ok, extra = '') => check(`  ↳ control: ${n}`, ok, extra);
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

/**
 * Run sign-desktop.mjs with a chosen platform, environment and args.
 *
 * The platform is forced by a tiny shim that overrides
 * `Object.defineProperty(process, 'platform')` before importing the real
 * script — so the Windows and macOS decision paths are exercised from
 * Linux, which is the whole point. Only the DECISION runs; the signer
 * functions are never reached without real tools, and every test here
 * stays on a path that returns before spawning one.
 */
function runSign({ platform, env = {}, requireFlag = false, artifact = null }) {
  const shim = path.join(SCRATCH, `shim-${platform}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(shim, [
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
    `await import(${JSON.stringify(SIGN)});`,
  ].join('\n'));

  const args = [shim];
  if (artifact) { args.push('--artifact', artifact); }
  if (requireFlag) args.push('--require');

  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env, AURA_SIGN_REQUIRE: env.AURA_SIGN_REQUIRE ?? '' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const reportLine = out.split('\n').find((l) => l.startsWith('signing-report '));
  const report = reportLine ? JSON.parse(reportLine.slice('signing-report '.length)) : null;
  return { status: r.status, out, report };
}

// A clean environment for each case — none of the real secrets leak in.
const CLEAN = {
  WINDOWS_CERTIFICATE: '', WINDOWS_CERTIFICATE_PASSWORD: '', WINDOWS_CERTIFICATE_THUMBPRINT: '',
  APPLE_CERTIFICATE: '', APPLE_CERTIFICATE_PASSWORD: '', APPLE_SIGNING_IDENTITY: '',
  APPLE_API_KEY: '', APPLE_API_ISSUER: '', APPLE_API_KEY_ID: '',
  APPLE_ID: '', APPLE_APP_PASSWORD: '', APPLE_TEAM_ID: '',
};

console.log('AURA Hub — signing pipeline gate verification');
console.log('(the signing DECISION is verified here; signtool/codesign are not run)');

/* ══════════════════════════════════════════════════════════════════
   1. Requested + absent secrets → LOUD failure, nothing signed
   ══════════════════════════════════════════════════════════════════ */

section('requested but no credentials → refuse loudly');

for (const platform of ['win32', 'darwin']) {
  const r = runSign({ platform, env: CLEAN, requireFlag: true });
  check(`${platform}: exits non-zero when signing is required but unprovisioned`, r.status === 1, `status ${r.status}`);
  check(`${platform}: reports signed=false`, r.report?.signed === false);
  check(`${platform}: names the missing secrets`, Array.isArray(r.report?.missing) && r.report.missing.length > 0,
    (r.report?.missing ?? []).join(', '));
  check(`${platform}: emits an ::error:: annotation`, /::error::/.test(r.out));
  check(`${platform}: does NOT claim to have signed`, !/signed=true|"signed":true/.test(r.out));
}

/* ══════════════════════════════════════════════════════════════════
   2. Not requested → honest unsigned, exit 0
   ══════════════════════════════════════════════════════════════════ */

section('not requested → ship unsigned, honestly, exit 0');

for (const platform of ['win32', 'darwin']) {
  const r = runSign({ platform, env: CLEAN, requireFlag: false });
  check(`${platform}: exits 0 without signing when not required`, r.status === 0, `status ${r.status}`);
  check(`${platform}: reports signed=false`, r.report?.signed === false);
  check(`${platform}: says plainly it is shipping unsigned`, /unsigned/i.test(JSON.stringify(r.report)));
}

/* ══════════════════════════════════════════════════════════════════
   3. Provisioned → proceeds past the gate to the real signer
   ══════════════════════════════════════════════════════════════════ */

section('fully provisioned → the gate opens (and only then)');

{
  // A missing artifact makes the REAL signer path fail before it spawns a
  // tool — which proves the gate OPENED (we got past credential checks)
  // without needing signtool to exist. If the gate had stayed closed we
  // would see a "missing secrets" error instead of a "no artifact" one.
  const winProvisioned = {
    ...CLEAN,
    WINDOWS_CERTIFICATE_THUMBPRINT: 'DEADBEEF00112233445566778899AABBCCDDEEFF',
  };
  const r = runSign({ platform: 'win32', env: winProvisioned, requireFlag: true, artifact: path.join(SCRATCH, 'does-not-exist.exe') });
  check('win32: with a thumbprint present, the gate opens and it reaches the artifact check',
    r.status === 1 && /No artifact to sign/.test(r.out), r.out.split('\n').find((l) => l.includes('error')) ?? '');
  control('…and it did NOT fail for missing secrets', !/required secrets are absent/.test(r.out));

  const macProvisioned = {
    ...CLEAN,
    APPLE_CERTIFICATE: 'base64', APPLE_CERTIFICATE_PASSWORD: 'x', APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example',
    APPLE_ID: 'dev@example.com', APPLE_APP_PASSWORD: 'app-pw', APPLE_TEAM_ID: 'TEAM123456',
  };
  const m = runSign({ platform: 'darwin', env: macProvisioned, requireFlag: true, artifact: path.join(SCRATCH, 'nope.app') });
  check('darwin: with the Apple-ID credential set present, the gate opens',
    m.status === 1 && /No artifact to sign/.test(m.out));
  control('…and it did NOT fail for missing secrets', !/required secrets are absent/.test(m.out));
}

/* ══════════════════════════════════════════════════════════════════
   4. Partial credentials are treated as absent, not "close enough"
   ══════════════════════════════════════════════════════════════════ */

section('partial credentials are absent, never "close enough"');

{
  // A PFX with no password must NOT be treated as provisioned.
  const partial = { ...CLEAN, WINDOWS_CERTIFICATE: 'base64-pfx-but-no-password' };
  const r = runSign({ platform: 'win32', env: partial, requireFlag: true });
  check('win32: a certificate without its password is refused', r.status === 1 && r.report?.signed === false);
  check('win32: the missing password is named specifically',
    (r.report?.missing ?? []).includes('WINDOWS_CERTIFICATE_PASSWORD'), (r.report?.missing ?? []).join(', '));

  // Apple: signing identity present but notarization creds missing.
  const halfMac = { ...CLEAN, APPLE_CERTIFICATE: 'x', APPLE_CERTIFICATE_PASSWORD: 'x', APPLE_SIGNING_IDENTITY: 'Developer ID Application: X' };
  const m = runSign({ platform: 'darwin', env: halfMac, requireFlag: true });
  check('darwin: a signing identity without notarization creds is refused', m.status === 1);
  check('darwin: the missing notarization credentials are named',
    (m.report?.missing ?? []).some((s) => /APPLE_(API_KEY|ID|APP_PASSWORD|TEAM_ID)/.test(s)),
    (m.report?.missing ?? []).join(', '));

  // NEGATIVE CONTROL for the whole file: the same darwin call with a
  // COMPLETE credential set must NOT report missing secrets — otherwise
  // every "refused" above could be a script that always refuses.
  const full = { ...halfMac, APPLE_ID: 'a@b.c', APPLE_APP_PASSWORD: 'p', APPLE_TEAM_ID: 'T' };
  const good = runSign({ platform: 'darwin', env: full, requireFlag: true, artifact: path.join(SCRATCH, 'x.app') });
  control('a complete credential set is NOT reported as missing anything',
    !/required secrets are absent/.test(good.out), 'gate opened, failed only on the absent artifact');
}

/* ══════════════════════════════════════════════════════════════════
   5. Linux is a complete answer, not a gap
   ══════════════════════════════════════════════════════════════════ */

section('linux signs nothing, and says so, exit 0');

{
  const r = runSign({ platform: 'linux', env: CLEAN, requireFlag: true });
  check('linux exits 0 even when signing is "required"', r.status === 0);
  check('linux reports signed=false with a reason, not a failure', r.report?.signed === false && /updater signature|integrity/i.test(JSON.stringify(r.report)));
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`${passed} passed · ${failed} failed`);
console.log('\nNOTE: this verifies the signing DECISION only. The signtool and');
console.log('codesign/notarytool invocations are BUILT: NOT COMPILED here — they');
console.log('require a Windows/macOS runner and real certificates (see QUESTIONS.md).');
if (failed) console.log('\nFAILED — do not report the signing gate as verified.');
else console.log('\nAll checks passed. The gate refuses loudly and never fakes success.');
process.exit(failed ? 1 : 0);
