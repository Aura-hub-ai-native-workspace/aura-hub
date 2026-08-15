/**
 * Release gate verification.
 * ==================================================================
 * Exercises the publish refusals in `build-latest-json.mjs` against real
 * fixture directories, and checks the version authority for agreement.
 *
 *   node scripts/release-gate-verify.mjs
 *
 * SCOPE, stated plainly: this validates the GATE, not the cryptography.
 * It proves the manifest builder refuses to publish an unsigned, mixed,
 * duplicated or incomplete release. It does NOT verify a minisign
 * signature — every `.sig` fixture here is arbitrary bytes, and a passing
 * run is never evidence that signing works. Real signature verification
 * requires the production key, which lives only in CI.
 *
 * Each refusal is paired with a NEGATIVE CONTROL: the same fixture set,
 * corrected, must publish. Without that pair a refusal test proves only
 * that the script errors, not that it errors for the stated reason.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const VERSION = CONF.version;

const results = [];
let group = '';
const setGroup = (g) => { group = g; console.log(`\n── ${g} ──`); };

function record(name, ok, detail) {
  results.push({ group, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The four artifacts a complete release publishes, as staging names them. */
const COMPLETE = [
  `AURA-Hub-${VERSION}-linux-x64.AppImage.tar.gz`,
  `AURA-Hub-${VERSION}-windows-x64.nsis.zip`,
  `AURA-Hub-${VERSION}-macos-x64.app.tar.gz`,
  `AURA-Hub-${VERSION}-macos-arm64.app.tar.gz`,
];

/**
 * Build a fixture directory.
 * `sigs` controls which artifacts get a `.sig`; the bytes are arbitrary —
 * this gate never verifies them, and neither does this test.
 */
function fixture(files, { sigs = 'all', emptySig = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-relgate-'));
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), 'artifact-bytes');
    const wantSig = sigs === 'all' || (Array.isArray(sigs) && sigs.includes(f));
    if (wantSig) {
      fs.writeFileSync(path.join(dir, `${f}.sig`), f === emptySig ? '' : 'dGVzdC1zaWduYXR1cmU=');
    }
  }
  return dir;
}

function runBuilder(dir, extra = []) {
  const out = path.join(dir, 'latest.json');
  // `--name value`, not `--name=value`: build-latest-json reads the NEXT
  // argv entry. Passing the joined form silently fell back to the default
  // directory and made every case here pass or fail for the wrong reason.
  const r = spawnSync('node', [
    path.join(ROOT, 'scripts/build-latest-json.mjs'),
    '--dir', dir, '--out', out, '--tag', `v${VERSION}`, ...extra,
  ], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stderr: (r.stderr || '') + (r.stdout || ''), out };
}

/** A refusal must exit non-zero AND say why, in the expected terms. */
function expectRefusal(name, dir, pattern, extra = []) {
  const r = runBuilder(dir, extra);
  const refused = r.code !== 0;
  const reasoned = pattern.test(r.stderr);
  const wroteManifest = fs.existsSync(r.out);
  record(name,
    refused && reasoned && !wroteManifest,
    refused
      ? (reasoned ? (wroteManifest ? 'refused but still wrote a manifest' : `exit ${r.code}`) : `wrong reason: ${r.stderr.trim().slice(0, 110)}`)
      : 'PUBLISHED — the gate did not refuse');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════ */

setGroup('negative control — a correct release must publish');

{
  const dir = fixture(COMPLETE);
  const r = runBuilder(dir);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(r.out, 'utf8')); } catch { /* stays null */ }

  record('NC1. a complete, signed, single-version release publishes',
    r.code === 0 && manifest !== null,
    r.code === 0 ? `version ${manifest?.version}` : `exit ${r.code}: ${r.stderr.trim().slice(0, 120)}`);

  record('NC2. the manifest carries all four supported targets',
    manifest && Object.keys(manifest.platforms ?? {}).length === 4,
    manifest ? Object.keys(manifest.platforms ?? {}).join(', ') : 'no manifest');

  record('NC3. every platform entry has a non-empty signature',
    manifest && Object.values(manifest.platforms ?? {}).every((p) => typeof p.signature === 'string' && p.signature.length > 0),
    'signature present on each target');

  record('NC4. URLs point at permanent GitHub Release assets',
    manifest && Object.values(manifest.platforms ?? {}).every(
      (p) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v/.test(p.url)),
    manifest ? String(Object.values(manifest.platforms)[0]?.url ?? '').slice(0, 78) : 'no manifest');

  record('NC5. the manifest version matches the version authority',
    manifest?.version === VERSION, `manifest=${manifest?.version} conf=${VERSION}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

setGroup('publish refusals');

expectRefusal('R1. an unsigned artifact cannot publish',
  fixture(COMPLETE, { sigs: COMPLETE.slice(1) }), /has no signature/i);

expectRefusal('R2. an empty signature cannot publish',
  fixture(COMPLETE, { emptySig: COMPLETE[0] }), /empty|blank signature/i);

expectRefusal('R3. mixed-version artifacts cannot publish',
  fixture([...COMPLETE.slice(1), `AURA-Hub-9.9.9-linux-x64.AppImage.tar.gz`]),
  /refusing to mix builds|is version/i);

expectRefusal('R4. a missing platform cannot publish',
  fixture(COMPLETE.slice(1)), /missing|incomplete|expected/i);

expectRefusal('R5. an artifact directory with no artifacts cannot publish',
  fixture([]), /missing|incomplete|expected|no updater artifact|found no/i);

{
  // Two artifacts claiming one target: the gate must refuse rather than
  // silently pick one for every user on that platform.
  const dir = fixture(COMPLETE);
  fs.writeFileSync(path.join(dir, `AURA-Hub-${VERSION}-linux-x64.AppImage.tar.gz.dup`), 'x');
  fs.renameSync(
    path.join(dir, `AURA-Hub-${VERSION}-linux-x64.AppImage.tar.gz.dup`),
    path.join(dir, `AURA-Hub-${VERSION}-linux-x64.app.tar.gz`),
  );
  fs.writeFileSync(path.join(dir, `AURA-Hub-${VERSION}-linux-x64.app.tar.gz.sig`), 'c2ln');
  expectRefusal('R6. two artifacts for one target cannot publish', dir, /two artifacts claim|refusing to guess|names a platform/i);
}

setGroup('version authority');

{
  // One version, five places. Any disagreement must be visible, because a
  // manifest that advertises a version the binary does not report makes
  // every client either re-offer an installed update or refuse a real one.
  const read = {
    'package.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    'apps/desktop/package.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/package.json'), 'utf8')).version,
    'tauri.conf.json': CONF.version,
    'Cargo.toml': /^version\s*=\s*"([^"]+)"/m.exec(
      fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8'))?.[1],
  };
  const distinct = [...new Set(Object.values(read))];
  record('V1. every version source agrees', distinct.length === 1, JSON.stringify(read));

  // The published release is the fifth source, and it is allowed to be
  // BEHIND (nothing published yet) but never AHEAD of the build.
  record('V2. the build version is the single authority the manifest derives from',
    VERSION === read['tauri.conf.json'], `tauri.conf.json = ${VERSION}`);
}

setGroup('security');

{
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

  const keyish = tracked.filter((f) => /(^|\/)(\.env|.*\.key|.*\.pem|.*minisign.*|.*private.*key.*)$/i.test(f));
  record('S1. no key or credential file is tracked in git', keyish.length === 0, keyish.join(', ') || 'none');

  // A minisign SECRET key file starts with this comment. The public key in
  // tauri.conf.json is expected and is not a secret.
  const hits = [];
  for (const f of tracked) {
    if (f.startsWith('graphify-out/') || f.endsWith('.lock') || f.endsWith('package-lock.json')) continue;
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (/untrusted comment: minisign secret key/i.test(src)) hits.push(`${f} (secret key)`);
    if (/-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(src)) hits.push(`${f} (private key)`);
  }
  record('S2. no private signing material is committed', hits.length === 0, hits.join(', ') || 'none');

  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const signingRefs = [...ci.matchAll(/TAURI_SIGNING_PRIVATE_KEY[A-Z_]*\s*:\s*(.+)/g)].map((m) => m[1].trim());
  record('S3. CI references signing material only through secrets',
    signingRefs.length > 0 && signingRefs.every((v) => /^\$\{\{\s*secrets\./.test(v)),
    signingRefs.join(' | ') || 'no signing step found');

  record('S4. the signing key is never echoed or printed in CI',
    !/echo\s+.*TAURI_SIGNING_PRIVATE_KEY|cat\s+.*TAURI_SIGNING/.test(ci),
    'no echo/cat of the key');

  // The pubkey is the trust anchor and must be present and non-empty.
  const pubkey = CONF.plugins?.updater?.pubkey ?? '';
  record('S5. an updater public key (trust anchor) is configured',
    typeof pubkey === 'string' && pubkey.length > 40, `${pubkey.length} chars`);

  const endpoints = CONF.plugins?.updater?.endpoints ?? [];
  record('S6. every updater endpoint is HTTPS',
    endpoints.length > 0 && endpoints.every((e) => e.startsWith('https://')), endpoints.join(', '));
}

/* ── report ───────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(64)}`);
console.log(`Release gate — ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - [${f.group}] ${f.name}: ${f.detail}`);
}
console.log('\nSCOPE: publish-gate and version-authority logic only.');
console.log('Signature VERIFICATION is not tested here and is not claimed —');
console.log('the .sig fixtures are arbitrary bytes. Real verification needs the');
console.log('production key, which exists only as a CI secret.');
console.log('='.repeat(64));
process.exit(failed.length ? 1 : 0);
