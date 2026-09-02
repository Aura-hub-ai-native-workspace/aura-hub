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

/**
 * The four artifacts a complete release publishes, as staging names them.
 *
 * These are the REAL names, taken from the Tauri CLI's own output rather
 * than from what the pipeline used to assume. With
 * `createUpdaterArtifacts: true` the CLI signs the native bundle IN PLACE,
 * so on Linux and Windows the updater artifact is the AppImage and the
 * NSIS installer themselves; macOS keeps `.app.tar.gz` because a `.app`
 * is a directory and has to be archived. The `.AppImage.tar.gz` /
 * `.nsis.zip` wrappers this list used to name belong to `"v1Compatible"`
 * mode, which this project does not build — assuming them is what made
 * run 31902182292 refuse Linux and Windows at the staging step.
 */
const COMPLETE = [
  `AURA-Hub-${VERSION}-linux-x64.AppImage`,
  `AURA-Hub-${VERSION}-windows-x64.exe`,
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
  fixture([...COMPLETE.slice(1), `AURA-Hub-9.9.9-linux-x64.AppImage`]),
  /refusing to mix builds|is version/i);

expectRefusal('R4. a missing platform cannot publish',
  fixture(COMPLETE.slice(1)), /missing|incomplete|expected/i);

expectRefusal('R5. an artifact directory with no artifacts cannot publish',
  fixture([]), /missing|incomplete|expected|no updater artifact|found no/i);

{
  // Two artifacts claiming one target: the gate must refuse rather than
  // silently pick one for every user on that platform.
  const dir = fixture(COMPLETE);
  fs.writeFileSync(path.join(dir, `AURA-Hub-${VERSION}-linux-x64.app.tar.gz`), 'x');
  fs.writeFileSync(path.join(dir, `AURA-Hub-${VERSION}-linux-x64.app.tar.gz.sig`), 'c2ln');
  expectRefusal('R6. two artifacts for one target cannot publish', dir, /two artifacts claim|refusing to guess|names a platform/i);
}

/*
 * The manifest's allow-list is stated positively, so the artifacts that
 * must never reach a client are excluded by construction rather than by a
 * filter. These prove that construction holds.
 */
{
  // A `.deb` sits in dist-release beside the AppImage on every Linux
  // release — it is a download. Tauri signs it too, because
  // createUpdaterArtifacts signs every bundle. Neither fact may put it in
  // the manifest: a package-manager install cannot apply an AURA update.
  const dir = fixture(COMPLETE);
  const deb = `AURA-Hub-${VERSION}-linux-x64.deb`;
  fs.writeFileSync(path.join(dir, deb), 'deb bytes');
  fs.writeFileSync(path.join(dir, `${deb}.sig`), 'dGVzdC1zaWduYXR1cmU=');
  const r = runBuilder(dir);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(r.out, 'utf8')); } catch { /* stays null */ }

  record('R7. a signed .deb beside the release does not block it',
    r.code === 0, r.code === 0 ? 'published' : `exit ${r.code}: ${r.stderr.trim().slice(0, 110)}`);
  record('R8. …and never appears in the manifest',
    manifest !== null && !JSON.stringify(manifest).includes('.deb'),
    manifest ? 'no .deb in latest.json' : 'no manifest');
  record('R9. …and linux-x86_64 still points at the AppImage',
    manifest?.platforms?.['linux-x86_64']?.url?.endsWith(`${VERSION}-linux-x64.AppImage`),
    manifest?.platforms?.['linux-x86_64']?.url?.split('/').pop() ?? 'absent');
  record('R10. the manifest carries exactly the four updater targets, no more',
    manifest && Object.keys(manifest.platforms ?? {}).length === 4,
    Object.keys(manifest?.platforms ?? {}).join(', '));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Downloads that are not updater artifacts on any platform.
  const dir = fixture(COMPLETE);
  for (const extra of [`AURA-Hub-${VERSION}-macos-arm64.dmg`, `AURA-Hub-${VERSION}-linux-x64.rpm`]) {
    fs.writeFileSync(path.join(dir, extra), 'bytes');
    fs.writeFileSync(path.join(dir, `${extra}.sig`), 'dGVzdC1zaWduYXR1cmU=');
  }
  const r = runBuilder(dir);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(r.out, 'utf8')); } catch { /* stays null */ }
  record('R11. a .dmg and a .rpm are downloads, never updater targets',
    manifest && !JSON.stringify(manifest).includes('.dmg') && !JSON.stringify(manifest).includes('.rpm')
      && Object.keys(manifest.platforms ?? {}).length === 4,
    manifest ? Object.keys(manifest.platforms).join(', ') : `exit ${r.code}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

setGroup('staging — the real Tauri 2.11 artifact layout');

/**
 * Build a `target/release/bundle`-shaped directory holding the names the
 * Tauri CLI actually emits, and run the real staging script over it.
 *
 * `files` maps `<subdir>/<name>` to whether it gets a `.sig`. The names
 * here are transcribed from CI run 31902182292 and from a local
 * `tauri build` — they are not invented, which is the whole point: the
 * previous version of this suite tested names Tauri never produced.
 */
function bundleFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-bundle-'));
  for (const [rel, signed] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `bytes of ${path.basename(rel)}`);
    if (signed) fs.writeFileSync(`${full}.sig`, 'dGVzdC1zaWduYXR1cmU=');
  }
  return dir;
}

function runStaging(bundle, extra = []) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-staged-'));
  const r = spawnSync('node', [
    path.join(ROOT, 'scripts/stage-release-artifacts.mjs'),
    '--bundle', bundle, '--out', out, ...extra,
  ], { cwd: ROOT, encoding: 'utf8' });
  const listed = fs.existsSync(out) ? fs.readdirSync(out).sort() : [];
  return { code: r.status, output: (r.stdout || '') + (r.stderr || ''), out, listed };
}

{
  // Linux, exactly as `tauri build` leaves it: the AppImage is BOTH the
  // download and the updater artifact, and the .deb is signed but is not.
  const dir = bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: true,
    [`deb/AURA Hub_${VERSION}_amd64.deb`]: true,
  });
  const r = runStaging(dir);

  record('T1. the real Linux AppImage filename is accepted',
    r.code === 0 && r.listed.includes(`AURA-Hub-${VERSION}-linux-x64.AppImage`),
    r.code === 0 ? r.listed.join(', ') : r.output.trim().split('\n')[0]);
  record('T2. …and is staged WITH its signature',
    r.listed.includes(`AURA-Hub-${VERSION}-linux-x64.AppImage.sig`));
  record('T3. …and is recorded as serving both roles',
    /AppImage {2}\(.*\) {2}\[download \+ updater\]/.test(r.output), 'download + updater');
  record('T4. the .deb is staged as a download',
    r.listed.includes(`AURA-Hub-${VERSION}-linux-x64.deb`));
  record('T5. …and its signature is NOT staged, so it cannot reach the manifest',
    !r.listed.includes(`AURA-Hub-${VERSION}-linux-x64.deb.sig`), r.listed.join(', '));
  record('T6. …and the exclusion is stated, not silent',
    /excluded from the updater set/i.test(r.output));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Windows. This machine cannot build an NSIS installer, so the naming
  // is exercised with --os against the filename CI actually produced.
  const dir = bundleFixture({ [`nsis/AURA Hub_${VERSION}_x64-setup.exe`]: true });
  const r = runStaging(dir, ['--os', 'windows']);
  record('T7. the real Windows -setup.exe filename is accepted',
    r.code === 0 && r.listed.includes(`AURA-Hub-${VERSION}-windows-x64.exe`),
    r.code === 0 ? r.listed.join(', ') : r.output.trim().split('\n')[0]);
  record('T8. …and is staged WITH its signature',
    r.listed.includes(`AURA-Hub-${VERSION}-windows-x64.exe.sig`));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // macOS. `.app.tar.gz` carries no architecture in its name — only the
  // runner knows which slice it built, which is why the fallback exists.
  const dir = bundleFixture({
    'macos/AURA Hub.app.tar.gz': true,
    [`dmg/AURA Hub_${VERSION}_aarch64.dmg`]: false,
  });
  const r = runStaging(dir, ['--os', 'macos', '--arch', 'arm64']);
  record('T9. the macOS .app.tar.gz remains accepted',
    r.code === 0 && r.listed.includes(`AURA-Hub-${VERSION}-macos-arm64.app.tar.gz`),
    r.code === 0 ? r.listed.join(', ') : r.output.trim().split('\n')[0]);
  record('T10. …with its signature, and the .dmg staged as a download only',
    r.listed.includes(`AURA-Hub-${VERSION}-macos-arm64.app.tar.gz.sig`)
    && r.listed.includes(`AURA-Hub-${VERSION}-macos-arm64.dmg`)
    && !r.listed.includes(`AURA-Hub-${VERSION}-macos-arm64.dmg.sig`),
    r.listed.join(', '));
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A staging refusal must exit non-zero, say why, and stage nothing. */
function expectStagingRefusal(name, dir, pattern, extra = []) {
  const r = runStaging(dir, extra);
  const refused = r.code !== 0;
  const reasoned = pattern.test(r.output);
  record(name,
    refused && reasoned && r.listed.length === 0,
    refused
      ? (reasoned
        ? (r.listed.length ? `refused but staged ${r.listed.length} file(s)` : `exit ${r.code}`)
        : `wrong reason: ${r.output.trim().slice(0, 110)}`)
      : 'STAGED — the gate did not refuse');
  fs.rmSync(dir, { recursive: true, force: true });
}

expectStagingRefusal('T11. an updater artifact with no signature is refused',
  bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: false,
    [`deb/AURA Hub_${VERSION}_amd64.deb`]: true,
  }),
  /has no signature/i);

expectStagingRefusal('T12. a signed artifact of an unknown kind still fails closed',
  bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: true,
    [`weird/AURA Hub_${VERSION}_amd64.snap`]: true,
  }),
  /does not recognise/i);

expectStagingRefusal('T13. a v1Compatible wrapper is unrecognised rather than half-supported',
  bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage.tar.gz`]: true,
  }),
  /does not recognise/i);

expectStagingRefusal('T14. an artifact from another version is refused',
  bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: true,
    'appimage/AURA Hub_9.9.9_amd64.AppImage': true,
  }),
  /another version|two updater artifacts/i);

expectStagingRefusal('T15. two updater artifacts claiming one target are refused',
  bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: true,
    [`macos/AURA Hub_${VERSION}_amd64.app.tar.gz`]: true,
  }),
  /two updater artifacts claim/i);

{
  // Nothing may vanish without a line of output. The AppDir is build
  // scaffolding rather than an artifact, and must not be reported as one
  // — nor may its bundled libraries reach any guard.
  const dir = bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: true,
    'appimage/AURA Hub.AppDir/usr/lib/libwayland-client.so.0': false,
    'appimage/AURA Hub.AppDir/usr/lib/libfoo_9.9.9_amd64.so': false,
    [`deb/AURA Hub_${VERSION}_amd64.deb`]: true,
  });
  const r = runStaging(dir);
  record('T16. the AppDir build tree is not mistaken for artifacts',
    r.code === 0 && !r.output.includes('libwayland') && !r.output.includes('libfoo'),
    r.code === 0 ? 'AppDir skipped' : r.output.trim().split('\n')[0]);
  record('T17. every input artifact is accounted for in the report',
    [`AURA Hub_${VERSION}_amd64.AppImage`, `AURA Hub_${VERSION}_amd64.deb`]
      .every((n) => r.output.includes(n)),
    'both named in the output');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // The staged output must be exactly what the manifest builder accepts.
  // Two scripts agreeing in prose is not agreement; this runs one into
  // the other.
  const dir = bundleFixture({
    [`appimage/AURA Hub_${VERSION}_amd64.AppImage`]: true,
    [`deb/AURA Hub_${VERSION}_amd64.deb`]: true,
  });
  const staged = runStaging(dir);
  const out = path.join(staged.out, 'latest.json');
  const b = spawnSync('node', [
    path.join(ROOT, 'scripts/build-latest-json.mjs'),
    '--dir', staged.out, '--out', out, '--tag', `v${VERSION}`, '--targets', 'linux-x86_64',
  ], { cwd: ROOT, encoding: 'utf8' });
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* stays null */ }

  record('T18. what staging writes is what the manifest builder reads',
    b.status === 0 && manifest !== null,
    b.status === 0 ? 'manifest built from staged output' : `${b.stderr}`.trim().slice(0, 110));
  record('T19. the Linux entry points at the AppImage',
    manifest?.platforms?.['linux-x86_64']?.url?.endsWith(`${VERSION}-linux-x64.AppImage`),
    manifest?.platforms?.['linux-x86_64']?.url?.split('/').pop() ?? 'absent');
  record('T20. and the staged .deb never entered it',
    manifest !== null && !JSON.stringify(manifest).includes('.deb'));
  fs.rmSync(dir, { recursive: true, force: true });
}

setGroup('the Linux patch sequence — build, patch, sign, stage');

{
  /*
   * The AppImage is repacked AFTER Tauri builds and signs it. Because
   * Tauri 2.11 signs the AppImage ITSELF (there is no `.AppImage.tar.gz`
   * to rebuild), the signature on disk covers the pre-patch bytes the
   * moment the repack finishes. Publishing that pair hands every Linux
   * client an artifact whose signature does not match — INVALID_SIGNATURE,
   * the one failure AURA never retries, because it reads as tampering.
   *
   * These are source checks: reproducing the behaviour needs a real
   * AppImage, a repack tool and a signing key. The behaviour itself is
   * exercised by CI on every tag, and was proven locally against real
   * artifacts and a disposable key during this repair.
   */
  const raw = fs.readFileSync(path.join(ROOT, 'scripts/patch-appimage-linux.mjs'), 'utf8');
  const patch = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  record('P1. the patch re-signs the ARTIFACT ITSELF, not a wrapper that no longer exists',
    /signer', 'sign', appimage\]/.test(patch), 'signs the AppImage');
  record('P2. …and the re-sign is actually CALLED after the repack',
    /^\s*resignPatchedAppImage\(/m.test(patch), 'live call site, not just a definition');
  record('P3. no reference to the obsolete .AppImage.tar.gz survives in live code',
    !/AppImage\.tar\.gz/.test(patch), 'the v1Compatible wrapper is gone');
  record('P4. a stale signature is removed rather than left beside new bytes',
    /fs\.rmSync\(sig\)/.test(patch) && /process\.exit\(1\)/.test(patch));
  record('P5. …and it is removed BEFORE signing, so a failed signing cannot leave it',
    patch.indexOf('if (hadSig) fs.rmSync(sig);') < patch.indexOf("'signer', 'sign'"),
    'removal precedes signing');
  record('P6. the signing key is passed by environment, never as an argument',
    !/--private-key|'-k'/.test(patch), 'nothing key-shaped in a process listing');

  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const patchStep = ci.slice(ci.indexOf('Patch the AppImage'), ci.indexOf('Install a virtual display'));
  record('P7. CI gives the patch step a signing key, or it could not re-sign',
    /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\./.test(patchStep)
    && /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{\s*secrets\./.test(patchStep),
    'both secrets referenced');
  record('P8. CI patches BEFORE it stages, so staging copies the final bytes',
    ci.indexOf('patch-appimage-linux.mjs') < ci.indexOf('stage-release-artifacts.mjs'));
  record('P9. nothing rewrites the AppImage after the patch step',
    ci.slice(ci.indexOf('patch-appimage-linux.mjs')).indexOf('tauri --workspace') === -1,
    'no rebuild between patch and stage');
  record('P10. CI never passes the test-only platform overrides',
    !/stage-release-artifacts\.mjs[^\n]*--os|stage-release-artifacts\.mjs[^\n]*--arch/.test(ci),
    'staging runs on the real platform in CI');
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

  /*
   * A signing key committed to this repository is the worst outcome this
   * suite can prevent, so the detector has to match the file the Tauri
   * CLI actually writes — and that file is BASE64-WRAPPED. Scanning the
   * raw text for a comment line finds nothing, because the comment is
   * inside the base64. A plaintext-only scan reports a clean tree while
   * the key sits in it.
   *
   * So each tracked file is tested as text AND, when it is a single
   * base64 blob, as its decoding. The public key decodes to a comment
   * saying "public key" and is expected — only "secret key" is a finding.
   *
   * The markers are ASSEMBLED rather than written out, because this file
   * is itself tracked and would otherwise match its own detector. A
   * scanner that always reports one hit is a scanner nobody reads.
   */
  const SECRET_KEY = `${'secret'} ${'key'}`;
  const SECRET_MARKERS = [
    ['untrusted comment', `minisign ${SECRET_KEY}`].join(': '),
    ['untrusted comment', `minisign encrypted ${SECRET_KEY}`].join(': '),
    ['untrusted comment', `rsign encrypted ${SECRET_KEY}`].join(': '),
  ];

  /** The decoding, if this file is one base64 blob; otherwise nothing. */
  const decodedIfBase64 = (src) => {
    const compact = src.trim();
    if (compact.length < 40 || compact.length > 100_000) return null;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(compact)) return null;
    try { return Buffer.from(compact, 'base64').toString('utf8'); } catch { return null; }
  };

  const looksLikeSecretKey = (src) =>
    [src, decodedIfBase64(src)]
      .filter(Boolean)
      .map((s) => s.toLowerCase())
      .some((b) => SECRET_MARKERS.some((m) => b.includes(m)));

  const hits = [];
  for (const f of tracked) {
    if (f.startsWith('graphify-out/') || f.endsWith('.lock') || f.endsWith('package-lock.json')) continue;
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (looksLikeSecretKey(src)) hits.push(`${f} (secret key)`);
    if (/-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(src)) hits.push(`${f} (private key)`);
  }
  record('S2. no private signing material is committed', hits.length === 0, hits.join(', ') || 'none');

  /*
   * NEGATIVE CONTROL for S2, and it is not optional.
   *
   * The previous version of this check looked for a plaintext comment the
   * Tauri CLI never writes: its key files are base64, and the comment
   * naming them is inside that base64 and uses rsign's wording, not
   * minisign's. S2 therefore passed on every tree, including one holding
   * a real key. A green detector that cannot detect is worse than no
   * detector, so the detector is now run against a file shaped exactly
   * like the one `tauri signer generate` produces.
   */
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const fakeSecret = b64(
    `${['untrusted comment', `rsign encrypted ${SECRET_KEY}`].join(': ')}\n`
    + 'RWRTY0IyaVYydXVCNUl4djhTcTBxa1lvcld4R213SXNLcnhoZjh6NUUr\n',
  );
  const fakePublic = b64(
    `${['untrusted comment', 'minisign public key'].join(': ')}\n`
    + 'RWTGV0Ym1hZ01yS3pGdGxaRmtQTnVndg==\n',
  );

  record('S2b. the detector FIRES on a base64 Tauri secret-key file',
    looksLikeSecretKey(fakeSecret), 'a committed key would be caught');
  record('S2c. …and does NOT fire on a public key, which is not a secret',
    !looksLikeSecretKey(fakePublic), 'trust anchors are expected in the tree');
  record('S2d. …and does NOT fire on the configured pubkey in tauri.conf.json',
    !looksLikeSecretKey(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')));

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
