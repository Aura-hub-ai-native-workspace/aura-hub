/**
 * stage-release-artifacts — give the installers names a user can read.
 * ==================================================================
 * Tauri names its output after the platform's packaging conventions:
 * `AURA Hub_0.1.1_amd64.AppImage`, `AURA Hub_0.1.1_x64-setup.exe`,
 * `AURA Hub_0.1.1_aarch64.dmg`. Those are correct for each ecosystem and
 * wrong for a downloads page — the space breaks URLs, `amd64`/`x64`/
 * `x86_64` name the same architecture three ways, and nothing says which
 * OS a `.dmg` targets when it sits beside four other files.
 *
 * So the built artifacts are COPIED (never moved, never rewritten) into
 * `dist-release/` under one predictable scheme:
 *
 *     AURA-Hub-<version>-<os>-<arch>.<ext>
 *
 * The version comes from `tauri.conf.json` — the same value the installer
 * itself carries — so it can never drift from what was actually built and
 * is never invented here.
 *
 * This only renames. It does not build, sign, or alter a single byte of
 * any artifact.
 *
 * ── The layout this script is written against ────────────────────────
 * Tauri CLI 2.11.x with `bundle.createUpdaterArtifacts: true` signs the
 * NATIVE BUNDLE IN PLACE. There are no `.AppImage.tar.gz` / `.nsis.zip`
 * wrappers; those belong to the `"v1Compatible"` mode, which this project
 * does not use. Observed, from the CLI's own output:
 *
 *     linux    AURA Hub_0.1.1_amd64.AppImage      + .sig
 *              AURA Hub_0.1.1_amd64.deb           + .sig
 *     windows  AURA Hub_0.1.1_x64-setup.exe       + .sig
 *     macos    AURA Hub.app.tar.gz                + .sig
 *
 * So on Linux and Windows the file a person downloads and the file the
 * updater downloads are THE SAME FILE, staged once under one name and
 * serving both roles. macOS is the exception only because a `.app` is a
 * directory and has to be archived before it can be signed or shipped.
 *
 * Usage:
 *   node scripts/stage-release-artifacts.mjs [--bundle <dir>] [--out <dir>]
 *                                            [--os <name>] [--arch <name>]
 *
 * Every flag defaults to the real thing: the real build output, the real
 * release directory, and the platform actually running. The overrides
 * exist so the verification suites can exercise the naming scheme for
 * platforms this machine cannot build — a Linux box has no way to produce
 * an NSIS installer, and "we never tested that name" is how a platform
 * goes missing from a release. CI passes none of them, which
 * `release-verify` asserts.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

/* Defaults are the real build output and the real release directory; the
   overrides exist so the verification suites can drive this script over
   fixture directories instead of restating its rules in a test. */
const BUNDLE = path.resolve(ROOT, arg('bundle', 'apps/desktop/src-tauri/target/release/bundle'));
const OUT = path.resolve(ROOT, arg('out', 'dist-release'));

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const VERSION = conf.version;
if (!VERSION) throw new Error('tauri.conf.json has no version — refusing to invent one.');

const HOST_OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const OS_NAME = arg('os', HOST_OS);
if (!['linux', 'windows', 'macos'].includes(OS_NAME)) {
  throw new Error(`--os ${OS_NAME} is not a platform this product publishes.`);
}

/** The architecture to assume when a filename does not name one. */
const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const FALLBACK_ARCH = arg('arch', HOST_ARCH);
if (!['x64', 'arm64'].includes(FALLBACK_ARCH)) {
  throw new Error(`--arch ${FALLBACK_ARCH} is not an architecture this product publishes.`);
}

const fail = (lines) => {
  for (const l of [].concat(lines)) console.error(l);
  process.exit(1);
};

/** Normalise the many spellings of an architecture to two canonical names. */
function archOf(filename) {
  const f = filename.toLowerCase();
  if (/aarch64|arm64/.test(f)) return 'arm64';
  if (/x86_64|amd64|x64/.test(f)) return 'x64';
  // Nothing in the filename — fall back to the architecture that built it.
  // `AURA Hub.app.tar.gz` is the real case: a macOS app bundle is named
  // after the product alone, so only the runner knows which slice it is.
  return FALLBACK_ARCH;
}

function walk(dir, out = [], depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // A macOS `.app` is a directory, and it is an artifact rather than a
      // folder to descend into.
      if (e.name.endsWith('.app')) { out.push(full); continue; }
      // A Linux `.AppDir` is the staging tree linuxdeploy built the
      // AppImage FROM — hundreds of bundled libraries, none of them an
      // artifact. Descending into it would drown the classification report
      // and, worse, feed the version guard filenames like
      // `libfoo_1.2.3_amd64.so`, which name a version that is not ours.
      if (e.name.endsWith('.AppDir')) continue;
      walk(full, out, depth + 1);
      continue;
    }
    out.push(full);
  }
  return out;
}

/* ── the three classes an artifact can belong to ──────────────────── */

/** What a person downloads and runs. */
const INSTALLER = /\.(AppImage|deb|rpm|exe|msi|dmg)$/i;

/**
 * What the UPDATER downloads and applies, in the in-place-signing layout
 * described above. Deliberately NOT including `.AppImage.tar.gz` or
 * `.nsis.zip`: this project does not build them, and if the bundle config
 * ever changed to produce them, the unrecognised-signature guard below
 * should say so loudly rather than quietly accept a layout none of the
 * rest of the pipeline was checked against.
 */
const UPDATER = /(\.AppImage|-setup\.exe|\.app\.tar\.gz)$/i;

/**
 * Signed by Tauri, but never an updater target.
 *
 * With `createUpdaterArtifacts: true` the CLI signs EVERY bundle it
 * produces, including the `.deb`. A `.deb` can never be an updater
 * artifact: Tauri's Linux updater replaces a running AppImage, and a
 * package-manager install has nothing for it to replace — which is
 * exactly what `update_install_kind` reports as `managed` and the client
 * refuses with UNSUPPORTED_INSTALL. So these are staged as downloads and
 * excluded from the updater set, out loud rather than by omission.
 */
const DISTRIBUTION_ONLY = /\.(deb|rpm)$/i;

/**
 * Compound suffixes must be matched whole. Taking everything after the
 * last dot turns `.app.tar.gz` into `gz`, which loses the format and
 * would collide the macOS updater bundle with anything else gzipped.
 */
function extOf(base) {
  const m = /\.(AppImage\.tar\.gz|app\.tar\.gz|nsis\.zip|tar\.gz)(\.sig)?$/i.exec(base);
  if (m) return m[1] + (m[2] ?? '');
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
}

/**
 * The version Tauri wrote into the filename, if it wrote one.
 *
 * `AURA Hub_0.1.1_amd64.AppImage` carries it; `AURA Hub.app.tar.gz` does
 * not, because a macOS app bundle is named after the product alone. A
 * missing version is therefore not a fault — a DISAGREEING one is.
 */
function versionIn(base) {
  return /_(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)_/.exec(base)?.[1] ?? null;
}

/* ── collect and classify ─────────────────────────────────────────── */

const all = walk(BUNDLE);
const artifacts = all.filter((f) => !f.endsWith('.sig'));

/**
 * A `.sig` is emitted for exactly one thing: something Tauri signed. So
 * the signatures on disk are the authoritative statement of what the
 * build considers an updater candidate, and the classes above are this
 * pipeline's belief about what those are called.
 */
const signed = new Set(
  all.filter((f) => f.endsWith('.sig')).map((f) => f.slice(0, -'.sig'.length)),
);

const installers = artifacts.filter((f) => INSTALLER.test(f));
const updaters = artifacts.filter((f) => UPDATER.test(f) && !DISTRIBUTION_ONLY.test(f));

/*
 * GUARD 1 — an unrecognised signed artifact stops the release.
 *
 * If Tauri signed something this pipeline cannot classify, it has
 * produced an updater artifact under a name nothing downstream was
 * written against, and the honest outcome is to stop. The alternative is
 * a release that looks complete while one platform is quietly missing
 * from latest.json — which does not fail, it just means those users never
 * hear about another update.
 */
const unrecognised = [...signed].filter((f) => !UPDATER.test(f) && !DISTRIBUTION_ONLY.test(f));
if (unrecognised.length) {
  fail([
    'Tauri signed an artifact this pipeline does not recognise:',
    ...unrecognised.map((f) => `  ${path.basename(f)}`),
    '',
    'Classify it in scripts/stage-release-artifacts.mjs — as UPDATER if the',
    'updater downloads it, or as DISTRIBUTION_ONLY if it is a download only.',
    'Refusing to continue: staging it under the wrong name would drop a platform',
    'from latest.json silently.',
  ]);
}

/*
 * GUARD 2 — an updater artifact without its signature stops the release.
 *
 * `build-latest-json` would refuse it later anyway, but by then the
 * platform is already missing and the reason is three steps away. An
 * unsigned updater artifact can never install: every client rejects it
 * after downloading, and INVALID_SIGNATURE is the one failure AURA never
 * retries, because it reads as tampering.
 */
const unsignedUpdaters = updaters.filter((f) => !signed.has(f));
if (unsignedUpdaters.length) {
  fail([
    'An updater artifact has no signature:',
    ...unsignedUpdaters.map((f) => `  ${path.basename(f)}`),
    '',
    'Every artifact the updater downloads must be signed, and the signature must',
    'cover the bytes as they will ship. On Linux the AppImage is repacked after',
    'the build (scripts/patch-appimage-linux.mjs) and re-signed there — a missing',
    'signature here usually means that step could not reach a signing key.',
    'Refusing to continue: an unsigned artifact fails verification on every machine.',
  ]);
}

/*
 * GUARD 3 — a build that mixes versions stops the release.
 *
 * Every staged name is written with the version from tauri.conf.json, so
 * a stale artifact left in target/ from a previous build would be RENAMED
 * into this release and become indistinguishable from it. Checking the
 * version Tauri itself wrote into the filename is what makes that
 * visible.
 */
const considered = [...new Set([...installers, ...updaters, ...signed])];
const mixed = considered
  .map((f) => [f, versionIn(path.basename(f))])
  .filter(([, v]) => v !== null && v !== VERSION);
if (mixed.length) {
  fail([
    `tauri.conf.json says ${VERSION}, but the build directory holds artifacts from another version:`,
    ...mixed.map(([f, v]) => `  ${path.basename(f)}  (version ${v})`),
    '',
    'Staging renames every artifact to the configured version, so these would be',
    'published as though they were part of this release.',
    'Refusing to continue: clean the bundle directory and rebuild.',
  ]);
}

/*
 * GUARD 4 — two updater artifacts for one target stops the release.
 *
 * `build-latest-json` catches this across platforms; catching it here
 * names the two actual files rather than the two staged names, which is
 * the difference between a diagnosis and a puzzle.
 */
const byTarget = new Map();
for (const f of updaters) {
  const target = `${OS_NAME}-${archOf(path.basename(f))}`;
  if (byTarget.has(target)) {
    fail([
      `two updater artifacts claim ${target}:`,
      `  ${path.basename(byTarget.get(target))}`,
      `  ${path.basename(f)}`,
      '',
      'Refusing to guess which one users should be updated to.',
    ]);
  }
  byTarget.set(target, f);
}

if (installers.length === 0) {
  fail([`No installers found under ${BUNDLE}. Build the desktop app first.`]);
}

/* ── stage ────────────────────────────────────────────────────────── */

fs.mkdirSync(OUT, { recursive: true });
const staged = [];

/** Copy one file under the canonical name, and report it. */
function stage(src, name) {
  const dest = path.join(OUT, name);
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  staged.push({ name, mb, from: path.basename(src) });
  return { dest, mb };
}

/*
 * One pass over a UNIQUE set of files.
 *
 * On Linux and Windows the installer and the updater artifact are the
 * same file. Staging them in two passes would copy that file twice under
 * the same name — harmless, but it would report two artifacts where one
 * exists, and a count nobody can reconcile is how a missing platform
 * hides. So each file is staged once and its roles are reported.
 */
const unique = [...new Set([...installers, ...updaters])]
  .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

const roleOf = (f) => {
  const roles = [];
  if (INSTALLER.test(f)) roles.push('download');
  if (updaters.includes(f)) roles.push('updater');
  else if (DISTRIBUTION_ONLY.test(f) && signed.has(f)) roles.push('signed, excluded from updater');
  return roles.join(' + ');
};

console.log(`Staging ${OS_NAME} v${VERSION} from ${path.relative(ROOT, BUNDLE)}\n`);

for (const src of unique) {
  const base = path.basename(src);
  const name = `AURA-Hub-${VERSION}-${OS_NAME}-${archOf(base)}.${extOf(base)}`;
  const { mb } = stage(src, name);
  console.log(`  ${base}\n    → ${name}  (${mb} MB)  [${roleOf(src)}]`);

  // Updater artifacts travel WITH their signature or not at all. Guard 2
  // has already established that every one of them has a signature; this
  // is what puts it beside the artifact under the matching name.
  if (updaters.includes(src)) {
    stage(`${src}.sig`, `${name}.sig`);
    console.log(`    → ${name}.sig`);
  }
}

/*
 * Nothing is dropped in silence.
 *
 * Anything Tauri produced that this run did not stage is named here with
 * the reason. An artifact that vanishes without a line of output is
 * exactly the failure the guards above exist to prevent, and a summary
 * that only lists successes cannot show it.
 */
const notStaged = considered.filter((f) => !unique.includes(f));
if (notStaged.length) {
  console.log('\nNot staged:');
  for (const f of notStaged) {
    console.log(`  ${path.basename(f)} — not an installer and not an updater artifact`);
  }
}

const excluded = [...signed].filter((f) => DISTRIBUTION_ONLY.test(f));
if (excluded.length) {
  console.log('\nSigned by Tauri, deliberately excluded from the updater set:');
  for (const f of excluded) {
    console.log(`  ${path.basename(f)} — a package-manager install is updated by its package manager,`);
    console.log('    never by AURA. It ships as a download; it never enters latest.json.');
  }
}

const sigs = staged.filter((s) => s.name.endsWith('.sig')).length;
console.log(`\n${staged.length} file(s) staged in ${path.relative(ROOT, OUT)}/ for ${OS_NAME} v${VERSION}`);
console.log(`  downloads: ${installers.length} · updater artifacts: ${updaters.length} · signatures: ${sigs}`);

if (updaters.length === 0) {
  console.warn('  !! no updater artifact was produced — check bundle.createUpdaterArtifacts in tauri.conf.json');
}
