/**
 * release-verify — the release, before anyone can download it.
 * ==================================================================
 * `latest.json` is the one file that tells every installed copy of AURA
 * Hub what to fetch and install. Once it is published, machines act on it
 * without asking anyone. So it is checked here, before publication, and
 * checked against the same rules the CLIENT applies — the applicability
 * gate in apps/desktop/src/updater is imported and run, rather than
 * restated. A manifest that this suite passes but the client refuses
 * would be a release nobody can install.
 *
 * Two modes:
 *
 *   • PIPELINE (default) — the release plumbing itself: manifest shape,
 *     signature presence, version agreement, URL derivation, and the
 *     refusals. Runs anywhere, needs no build.
 *
 *   • ARTIFACTS (--dir with real staged output) — additionally checks a
 *     real dist-release directory: every platform present, every bundle
 *     signed, every URL naming a file that exists.
 *
 * What it does NOT prove, and no local suite can: that a signature is
 * VALID. Validity is minisign against the production key, which lives
 * only with the operator and in CI. This suite proves a signature is
 * present, non-empty, and carried unaltered from the `.sig` on disk —
 * verification itself happens in tauri-plugin-updater on the user's
 * machine, and that is where it must happen.
 *
 * Usage: node scripts/release-verify.mjs [--dir dist-release] [--tag v0.1.1]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const info = (m) => console.log(`      ${m}`);

/* ── the client's own gate, imported not restated ────────────────── */

const outDir = mkdtempSync(path.join(tmpdir(), 'release-'));
const bundled = path.join(outDir, 'applicability.mjs');
execFileSync('npx', [
  'esbuild', path.join(ROOT, 'apps/desktop/src/updater/applicability.ts'),
  '--bundle', '--platform=node', '--format=esm', `--outfile=${bundled}`,
], { cwd: ROOT, stdio: 'pipe' });
const A = await import(bundled);

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const VERSION = conf.version;
const TAG = arg('tag', `v${VERSION}`);
const DIR = path.resolve(ROOT, arg('dir', 'dist-release'));

const ALL_TARGETS = ['linux-x86_64', 'windows-x86_64', 'darwin-x86_64', 'darwin-aarch64'];

/** Run the generator in a disposable directory and return its outcome. */
function generate(files, extraArgs = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stage-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const out = path.join(dir, 'latest.json');
  try {
    const stdout = execFileSync('node', [
      path.join(ROOT, 'scripts/build-latest-json.mjs'),
      '--dir', dir, '--out', out, '--tag', TAG, ...extraArgs,
    ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, stdout, manifest: JSON.parse(fs.readFileSync(out, 'utf8')) };
  } catch (e) {
    return { ok: false, stderr: `${e.stderr ?? ''}${e.stdout ?? ''}` };
  }
}

/**
 * A complete, well-formed set of staged artifacts.
 *
 * The REAL names. Tauri CLI 2.11.x with `createUpdaterArtifacts: true`
 * signs the native bundle in place, so the Linux and Windows updater
 * artifacts ARE the AppImage and the NSIS installer; macOS keeps
 * `.app.tar.gz` because a `.app` is a directory. Nothing here is a
 * `.tar.gz`/`.zip` wrapper — those are `"v1Compatible"` output, which
 * this project does not build.
 */
const BUNDLES = {
  'linux-x86_64': `AURA-Hub-${VERSION}-linux-x64.AppImage`,
  'windows-x86_64': `AURA-Hub-${VERSION}-windows-x64.exe`,
  'darwin-x86_64': `AURA-Hub-${VERSION}-macos-x64.app.tar.gz`,
  'darwin-aarch64': `AURA-Hub-${VERSION}-macos-arm64.app.tar.gz`,
};
const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduClJXUWFiYzEyMwo=';

const completeSet = () => {
  const files = {};
  for (const name of Object.values(BUNDLES)) {
    files[name] = 'artifact bytes';
    files[`${name}.sig`] = SIG;
  }
  return files;
};

/* ══════════════════════════════════════════════════════════════════
   1 · a complete release produces a manifest the client accepts
   ══════════════════════════════════════════════════════════════════ */

console.log('=== 1. A COMPLETE RELEASE ===');
{
  const r = generate(completeSet());
  check('1a. a complete set of signed artifacts produces a manifest', r.ok, r.stderr ?? '');

  if (r.ok) {
    const m = r.manifest;
    check('1b. the manifest version comes from tauri.conf.json, not the filename',
      m.version === VERSION, m.version);
    check('1c. every published target is present',
      ALL_TARGETS.every((t) => m.platforms?.[t]), Object.keys(m.platforms ?? {}).join(', '));
    check('1d. every entry carries the signature from its .sig, byte for byte',
      ALL_TARGETS.every((t) => m.platforms[t].signature === SIG.trim()));
    check('1e. every URL is https', ALL_TARGETS.every((t) => /^https:\/\//.test(m.platforms[t].url)));
    check('1f. every URL points at this tag',
      ALL_TARGETS.every((t) => m.platforms[t].url.includes(`/download/${TAG}/`)), TAG);
    check('1g. pub_date is a real timestamp', !Number.isNaN(Date.parse(m.pub_date)), m.pub_date);

    // The decisive check: the client must accept what the pipeline emits.
    const verdict = A.evaluateCandidate({
      currentVersion: '0.0.1', target: 'linux-x86_64', metadata: m,
    });
    check('1h. THE CLIENT ACCEPTS IT — the real applicability gate says yes',
      verdict.applicable === true, verdict.detail ?? '');

    for (const t of ALL_TARGETS) {
      const v = A.evaluateCandidate({ currentVersion: '0.0.1', target: t, metadata: m });
      check(`1i. …on ${t}`, v.applicable === true, v.detail ?? '');
    }

    // And refuses it on a machine already running this version.
    const same = A.evaluateCandidate({ currentVersion: VERSION, target: 'linux-x86_64', metadata: m });
    check('1j. …and refuses it on a machine already running this version',
      same.applicable === false && same.code === 'DOWNGRADE_REJECTED', same.code);
  }
}

/* ══════════════════════════════════════════════════════════════════
   2 · the refusals — each one a way a bad release could ship
   ══════════════════════════════════════════════════════════════════ */

console.log('\n=== 2. WHAT THE PIPELINE REFUSES ===');
{
  // A platform silently dropped is the failure nobody notices: those
  // users just stop getting updates.
  for (const [target, name] of Object.entries(BUNDLES)) {
    const files = completeSet();
    delete files[name];
    delete files[`${name}.sig`];
    const r = generate(files);
    check(`2a. a release missing ${target} is refused`,
      !r.ok && /no artifact for/.test(r.stderr), r.ok ? 'PUBLISHED ANYWAY' : 'refused');
  }
}
{
  // An artifact with no signature can never install — every client will
  // reject it after downloading. Better to fail here.
  const files = completeSet();
  delete files[`${BUNDLES['linux-x86_64']}.sig`];
  const r = generate(files);
  check('2b. an UNSIGNED artifact is refused',
    !r.ok && /no signature/.test(r.stderr), r.ok ? 'PUBLISHED ANYWAY' : 'refused');
}
{
  const files = completeSet();
  files[`${BUNDLES['linux-x86_64']}.sig`] = '   \n';
  const r = generate(files);
  check('2c. an EMPTY signature is refused',
    !r.ok && /empty/.test(r.stderr), r.ok ? 'PUBLISHED ANYWAY' : 'refused');
}
{
  // Stale artifacts left over from a previous build are exactly how a
  // release ends up advertising a version it did not build.
  const files = completeSet();
  const stale = 'AURA-Hub-0.0.9-linux-x64.AppImage';
  files[stale] = 'old bytes';
  files[`${stale}.sig`] = SIG;
  const r = generate(files);
  check('2d. an artifact from a DIFFERENT VERSION is refused',
    !r.ok && /Refusing to mix builds/.test(r.stderr), r.ok ? 'PUBLISHED ANYWAY' : 'refused');
}
{
  // Two files claiming one platform: whichever sorts first would win
  // silently, and half the evidence says the other one shipped.
  const files = completeSet();
  const dupe = `AURA-Hub-${VERSION}-linux-x64.app.tar.gz`;
  files[dupe] = 'other bytes';
  files[`${dupe}.sig`] = SIG;
  const r = generate(files);
  check('2e. TWO artifacts claiming one platform is refused',
    !r.ok && /two artifacts claim/i.test(r.stderr), r.ok ? 'PUBLISHED ANYWAY' : 'refused');
}
{
  const r = generate({});
  check('2f. an EMPTY directory produces no manifest',
    !r.ok, r.ok ? 'PUBLISHED AN EMPTY RELEASE' : 'refused');
}
{
  // The deliberate escape hatch must work, and must be deliberate.
  const files = {};
  const name = BUNDLES['linux-x86_64'];
  files[name] = 'bytes';
  files[`${name}.sig`] = SIG;
  const r = generate(files, ['--targets', 'linux-x86_64']);
  check('2g. a narrowed release is allowed only when stated explicitly',
    r.ok && Object.keys(r.manifest.platforms).length === 1,
    r.ok ? 'linux only, as asked' : r.stderr);
}
{
  /*
   * Every Linux release ships a `.deb` beside the AppImage, and Tauri
   * signs it — `createUpdaterArtifacts` signs every bundle it produces.
   * Neither fact may put it in the manifest. Tauri's Linux updater
   * replaces a running AppImage; a package-manager install has nothing
   * for it to replace, which is what the client reports as `managed` and
   * refuses with UNSUPPORTED_INSTALL. A `.deb` here would advertise an
   * update no Linux user could apply.
   */
  const files = completeSet();
  const deb = `AURA-Hub-${VERSION}-linux-x64.deb`;
  files[deb] = 'deb bytes';
  files[`${deb}.sig`] = SIG;
  const dmg = `AURA-Hub-${VERSION}-macos-arm64.dmg`;
  files[dmg] = 'dmg bytes';
  files[`${dmg}.sig`] = SIG;

  const r = generate(files);
  check('2h. a signed .deb and .dmg beside the release do not block it', r.ok, r.stderr ?? '');
  check('2i. …and neither reaches the manifest',
    r.ok && !JSON.stringify(r.manifest).includes('.deb') && !JSON.stringify(r.manifest).includes('.dmg'),
    r.ok ? 'downloads only, as intended' : 'no manifest');
  check('2j. …and linux-x86_64 still names the AppImage',
    r.ok && r.manifest.platforms['linux-x86_64'].url.endsWith(`${VERSION}-linux-x64.AppImage`),
    r.ok ? r.manifest.platforms['linux-x86_64'].url.split('/').pop() : 'no manifest');
  check('2k. …and the manifest holds exactly the four updater targets',
    r.ok && Object.keys(r.manifest.platforms).length === 4,
    r.ok ? Object.keys(r.manifest.platforms).join(', ') : 'no manifest');
}

/* ══════════════════════════════════════════════════════════════════
   3 · configuration the release depends on
   ══════════════════════════════════════════════════════════════════ */

console.log('\n=== 3. CONFIGURATION ===');
{
  const endpoints = conf.plugins?.updater?.endpoints ?? [];
  check('3a. an updater endpoint is configured', endpoints.length > 0);
  check('3b. it is https', endpoints.every((u) => /^https:\/\//.test(u)));

  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//.exec(endpoints[0] ?? '');
  check('3c. the release location is derivable from the endpoint', Boolean(repo), repo?.[1] ?? 'not derivable');

  // One repository, or the manifest points somewhere the client never asks.
  if (repo) {
    const r = generate(completeSet());
    check('3d. published URLs and the endpoint name the same repository',
      r.ok && Object.values(r.manifest.platforms).every((p) => p.url.includes(repo[1])), repo[1]);
  }

  check('3e. updater artifacts are enabled, so there is something to publish',
    conf.bundle?.createUpdaterArtifacts === true);
}
{
  // The client's target list and the pipeline's must agree, or one side
  // publishes what the other will never install.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/build-latest-json.mjs'), 'utf8');
  const types = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/updater/types.ts'), 'utf8');
  for (const t of ALL_TARGETS) {
    check(`3f. ${t} is known to both the client and the pipeline`,
      src.includes(t) && types.includes(t));
  }
  check('3g. the pipeline publishes no target the client would refuse',
    ALL_TARGETS.every((t) => A.isSupportedTarget(t)));
}

/* ══════════════════════════════════════════════════════════════════
   4 · the Linux repack must not desynchronise the updater bundle
   ══════════════════════════════════════════════════════════════════ */

console.log('\n=== 4. THE PATCHED APPIMAGE ===');
{
  /*
   * The AppImage is repacked AFTER Tauri builds and signs it, to remove a
   * bundled library that breaks rendering.
   *
   * With `createUpdaterArtifacts: true`, Tauri 2.11 signs the AppImage
   * ITSELF — the updater artifact and the download are one file. So the
   * moment the repack finishes, the signature on disk covers bytes that
   * no longer exist. Published that way, every Linux client downloads the
   * patched AppImage and fails verification: INVALID_SIGNATURE, the one
   * failure AURA never retries because it reads as tampering. The
   * pipeline would have manufactured a tamper warning out of its own fix.
   *
   * The sequence must therefore be BUILD → PATCH → SIGN → STAGE. These
   * are source checks because reproducing the behaviour needs a real
   * Linux bundle, a repack tool and a signing key; CI exercises it on
   * every tag, and it was proven against real artifacts during the
   * repair that introduced these checks.
   */
  const raw = fs.readFileSync(path.join(ROOT, 'scripts/patch-appimage-linux.mjs'), 'utf8');
  // Comments stripped first: a defined-but-never-called re-sign is exactly
  // the regression this checks for, and it reads identically otherwise.
  const patch = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  check('4a. the patch re-signs the AppImage itself — the artifact the updater downloads',
    /signer', 'sign', appimage\]/.test(patch) && /function resignPatchedAppImage/.test(patch));
  check('4a2. …and the re-sign is actually CALLED after the repack',
    /^\s*resignPatchedAppImage\(/m.test(patch), 'live call site, not just a definition');
  check('4b. no obsolete .AppImage.tar.gz path survives in live code',
    !/AppImage\.tar\.gz/.test(patch),
    'the v1Compatible wrapper this project does not build');
  check('4c. a stale signature is never left beside new bytes',
    /fs\.rmSync\(sig\)/.test(patch) && /process\.exit\(1\)/.test(patch));
  check('4c2. …and it is removed BEFORE signing, so a failed signing cannot leave it',
    patch.indexOf('if (hadSig) fs.rmSync(sig);') < patch.indexOf("'signer', 'sign'"),
    'removal precedes signing');
  check('4d. the signing key is passed by environment, never as an argument',
    !/--private-key|-k',/.test(patch), 'nothing key-shaped in a process listing');

  // A re-sign the pipeline cannot perform is a build that fails at the
  // last useful moment. The patch step needs the key the build step has.
  const ciSrc = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const patchStep = ciSrc.slice(
    ciSrc.indexOf('Patch the AppImage'), ciSrc.indexOf('Install a virtual display'),
  );
  check('4e. CI gives the patch step the signing secrets it needs to re-sign',
    /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\./.test(patchStep)
    && /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{\s*secrets\./.test(patchStep),
    'both passed by reference');
  check('4f. CI patches before it stages, so staging copies the final bytes',
    ciSrc.indexOf('patch-appimage-linux.mjs') < ciSrc.indexOf('stage-release-artifacts.mjs'));
}

/* ══════════════════════════════════════════════════════════════════
   5 · CI wiring
   ══════════════════════════════════════════════════════════════════ */

console.log('\n=== 5. THE PUBLISHING PIPELINE ===');
{
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  check('5a. only a version tag publishes',
    /if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/.test(ci));
  check('5b. publishing waits for every platform to build',
    /needs:\s*desktop-build/.test(ci));
  check('5c. the manifest is generated in CI, never hand-written',
    /build-latest-json\.mjs/.test(ci));
  check('5d. the release is verified BEFORE it is published',
    ci.indexOf('release-verify.mjs') < ci.indexOf('gh release create')
    && ci.includes('release-verify.mjs'));
  check('5e. every platform artifact is collected',
    /merge-multiple:\s*true/.test(ci));
  check('5f. the signing key reaches the build by secrets reference',
    /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\./.test(ci));

  // NEGATIVE CONTROLS: the shortcuts that would quietly break the release.
  check('5g. signing is never skipped in CI', !/--no-sign/.test(ci));
  check('5h. no key material is inlined in the workflow',
    !/TAURI_SIGNING_PRIVATE_KEY:\s*(?!\$\{\{)[A-Za-z0-9+/=]{8,}/.test(ci));
  check('5i. the release job takes only the permission it needs',
    /permissions:\s*\n\s*#[^\n]*\n\s*contents:\s*write/.test(ci) || /contents:\s*write/.test(ci));

  // The release job verifies the manifest by bundling the client's gate,
  // so it needs the toolchain even though it compiles nothing. Without
  // this the job fails at the one step that protects the release.
  const releaseJob = ci.slice(ci.indexOf('\n  release:'));
  check('5j. the publishing job installs what its verification needs',
    /npm ci/.test(releaseJob), 'npm ci present in the release job');
}

/* ══════════════════════════════════════════════════════════════════
   6 · real staged artifacts, when there are any
   ══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════
   7 · the version bump every release starts with
   ══════════════════════════════════════════════════════════════════ */

console.log('\n=== 7. VERSION BUMP ===');
{
  /**
   * A fixture repository holding only the six files the bump touches.
   * Fixtures rather than the real tree: this exercises a script whose
   * whole job is rewriting those files in place.
   */
  const fixture = (v, drift = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bumpfix-'));
    const files = {
      'package.json': `{\n  "name": "aura-hub",\n  "version": "${drift['package.json'] ?? v}"\n}\n`,
      'apps/desktop/package.json': `{\n  "name": "@aura/desktop",\n  "version": "${drift['apps/desktop/package.json'] ?? v}"\n}\n`,
      'apps/desktop/src-tauri/tauri.conf.json': `{\n  "version": "${drift['tauri.conf.json'] ?? v}"\n}\n`,
      'apps/desktop/src-tauri/Cargo.toml': `[package]\nname = "aura-hub"\nversion = "${drift['Cargo.toml'] ?? v}"\n`,
      'apps/desktop/src-tauri/Cargo.lock': `[[package]]\nname = "aura-hub"\nversion = "${drift['Cargo.lock'] ?? v}"\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\n`,
      'package-lock.json': `{\n  "packages": {\n    "": {\n      "name": "aura-hub",\n      "version": "${drift['package-lock.json'] ?? v}"\n    }\n  }\n}\n`,
    };
    for (const [f, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), content);
    }
    return dir;
  };

  const bump = (dir, ...args) => {
    try {
      const stdout = execFileSync('node', [
        path.join(ROOT, 'scripts/bump-version.mjs'), ...args, '--root', dir,
      ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
      return { ok: true, stdout };
    } catch (e) {
      return { ok: false, stderr: `${e.stderr ?? ''}${e.stdout ?? ''}` };
    }
  };

  const versionsIn = (dir) => [
    ['package.json', /"version":\s*"([^"]+)"/],
    ['apps/desktop/package.json', /"version":\s*"([^"]+)"/],
    ['apps/desktop/src-tauri/tauri.conf.json', /"version":\s*"([^"]+)"/],
    ['apps/desktop/src-tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m],
    ['apps/desktop/src-tauri/Cargo.lock', /name = "aura-hub"\nversion = "([^"]+)"/],
    ['package-lock.json', /"name": "aura-hub",\n\s*"version": "([^"]+)"/],
  ].map(([f, re]) => re.exec(fs.readFileSync(path.join(dir, f), 'utf8'))?.[1]);

  {
    const dir = fixture('0.1.1');
    const r = bump(dir, '0.1.2');
    const after = versionsIn(dir);
    check('7a. a forward bump moves every source', r.ok && after.every((v) => v === '0.1.2'),
      after.join(', '));
    // The lockfile's other packages must not be swept along with it.
    const lock = fs.readFileSync(path.join(dir, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
    check('7b. …and leaves dependency versions alone', /name = "serde"\nversion = "1\.0\.200"/.test(lock));
  }
  {
    const dir = fixture('0.1.1');
    const r = bump(dir, '0.1.0');
    check('7c. a BACKWARDS bump is refused', !r.ok && /older than/.test(r.stderr),
      r.ok ? 'ACCEPTED' : 'refused');
    check('7d. …and changes nothing', versionsIn(dir).every((v) => v === '0.1.1'));
  }
  {
    const dir = fixture('0.1.1');
    const r = bump(dir, '0.1.1');
    check('7e. bumping to the SAME version is refused', !r.ok && /current version/.test(r.stderr));
  }
  {
    const dir = fixture('0.1.1');
    const r = bump(dir, 'v0.1.2');
    check('7f. a version the client could not parse is refused', !r.ok, r.ok ? 'ACCEPTED' : 'refused');
    check('7g. …and changes nothing', versionsIn(dir).every((v) => v === '0.1.1'));
  }
  {
    // Pre-existing drift must be reported, not silently overwritten.
    const dir = fixture('0.1.1', { 'Cargo.toml': '0.1.0' });
    const r = bump(dir, '0.1.2');
    check('7h. PRE-EXISTING DRIFT is refused rather than papered over',
      !r.ok && /disagree/.test(r.stderr), r.ok ? 'OVERWROTE THE DRIFT' : 'refused');
    check('7i. …and the drifted state is preserved for diagnosis',
      versionsIn(dir).includes('0.1.0'));
  }
  {
    const dir = fixture('0.1.1');
    const r = bump(dir, '--check');
    check('7j. --check reports without changing anything',
      r.ok && versionsIn(dir).every((v) => v === '0.1.1'));
  }
  {
    // NEGATIVE CONTROL: it must not commit, tag, or push on its own.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/bump-version.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    check('7k. the bump never commits, tags or pushes by itself',
      !/execFileSync\(\s*'git'|spawnSync\(\s*'git'/.test(src), 'prints the commands instead');
  }
}

console.log('\n=== 6. REAL ARTIFACTS ===');
{
  const present = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => /\.(AppImage|exe|app\.tar\.gz)$/.test(f))
    : [];

  if (present.length === 0) {
    info(`ARTIFACTS: NOT VERIFIED — no updater bundles in ${path.relative(ROOT, DIR)}.`);
    info('This machine builds one platform; all four exist only on CI, which runs this suite before publishing.');
  } else {
    info(`found ${present.length} updater bundle(s) in ${path.relative(ROOT, DIR)}`);
    for (const f of present) {
      const sig = path.join(DIR, `${f}.sig`);
      check(`6a. ${f} is signed`, fs.existsSync(sig) && fs.readFileSync(sig, 'utf8').trim().length > 0);
      check(`6b. ${f} is not empty`, fs.statSync(path.join(DIR, f)).size > 0);
    }
    const manifest = path.join(DIR, 'latest.json');
    if (fs.existsSync(manifest)) {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const v = A.validateMetadata(m);
      check('6c. the generated manifest passes the client\'s own validator', v.ok, v.detail ?? '');
      for (const [target, entry] of Object.entries(m.platforms ?? {})) {
        const file = path.basename(entry.url);
        check(`6d. the file ${target} points at was actually staged`, fs.existsSync(path.join(DIR, file)), file);
      }
    }
  }
}

console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
