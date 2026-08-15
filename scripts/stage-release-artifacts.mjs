/**
 * stage-release-artifacts — give the installers names a user can read.
 * ==================================================================
 * Tauri names its output after the platform's packaging conventions:
 * `AURA Hub_0.1.0_amd64.AppImage`, `AURA Hub_0.1.0_x64-setup.exe`,
 * `AURA Hub_0.1.0_aarch64.dmg`. Those are correct for each ecosystem and
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
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(ROOT, 'apps/desktop/src-tauri/target/release/bundle');
const OUT = path.join(ROOT, 'dist-release');

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const VERSION = conf.version;
if (!VERSION) throw new Error('tauri.conf.json has no version — refusing to invent one.');

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

/** Normalise the many spellings of an architecture to two canonical names. */
function archOf(filename) {
  const f = filename.toLowerCase();
  if (/aarch64|arm64/.test(f)) return 'arm64';
  if (/x86_64|amd64|x64/.test(f)) return 'x64';
  // Nothing in the filename — fall back to the architecture that built it.
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function walk(dir, out = [], depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    // A macOS .app is a directory, and it is an artifact rather than a
    // folder to descend into.
    if (e.isDirectory() && !e.name.endsWith('.app')) walk(full, out, depth + 1);
    else out.push(full);
  }
  return out;
}

/** What a person downloads and runs. */
const INSTALLER = /\.(AppImage|deb|rpm|exe|msi|dmg)$/i;

/**
 * What the UPDATER downloads — a different set of files with the same
 * contents. Tauri emits these only when `bundle.createUpdaterArtifacts`
 * is on, one per platform, each beside a detached `.sig`.
 */
const UPDATER = /\.(AppImage\.tar\.gz|app\.tar\.gz|nsis\.zip)$/i;

/**
 * Compound suffixes must be matched whole. Taking everything after the
 * last dot turns `.AppImage.tar.gz` into `gz`, which loses the format and
 * collides the Linux updater bundle with the macOS one.
 */
function extOf(base) {
  const m = /\.(AppImage\.tar\.gz|app\.tar\.gz|nsis\.zip|tar\.gz)(\.sig)?$/i.exec(base);
  if (m) return m[1] + (m[2] ?? '');
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
}

const all = walk(BUNDLE);
const installers = all.filter((f) => INSTALLER.test(f));
const updaters = all.filter((f) => UPDATER.test(f));

/*
 * A `.sig` is emitted for exactly one thing: an updater artifact. So the
 * signatures on disk are the authoritative list of what Tauri considers
 * an updater bundle, and UPDATER above is this pipeline's belief about
 * what those are called.
 *
 * If the two disagree, Tauri has produced an updater artifact under a
 * name this pipeline does not recognise, and the honest outcome is to
 * stop. The alternative is a release that looks complete while one
 * platform is quietly missing from latest.json — which does not fail, it
 * just means those users never hear about another update.
 */
const unrecognised = all
  .filter((f) => f.endsWith('.sig'))
  .map((f) => f.slice(0, -'.sig'.length))
  .filter((artifact) => !UPDATER.test(artifact));

if (unrecognised.length) {
  console.error('Tauri signed an updater artifact this pipeline does not recognise:');
  for (const f of unrecognised) console.error(`  ${path.basename(f)}`);
  console.error('\nAdd its suffix to UPDATER in scripts/stage-release-artifacts.mjs.');
  console.error('Refusing to continue: staging it under the wrong name would drop a platform from latest.json silently.');
  process.exit(1);
}

if (installers.length === 0) {
  console.error(`No installers found under ${BUNDLE}. Build the desktop app first.`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const staged = [];

/** Copy one file under the canonical name, and report it. */
function stage(src, name) {
  const dest = path.join(OUT, name);
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  staged.push({ name, mb, from: path.basename(src) });
  console.log(`  ${path.basename(src)}\n    → ${name}  (${mb} MB)`);
  return dest;
}

for (const src of installers) {
  const base = path.basename(src);
  stage(src, `AURA-Hub-${VERSION}-${OS_NAME}-${archOf(base)}.${extOf(base)}`);
}

/*
 * Updater bundles travel WITH their signatures or not at all.
 *
 * A bundle staged without its `.sig` cannot be put in a manifest, and a
 * `.sig` staged without its bundle signs nothing — either way the release
 * would look complete while the update path was broken. The only case
 * where a missing signature is legitimate is an unsigned build
 * (`--no-sign`), which is for local inspection and never published, so it
 * is reported rather than treated as normal.
 */
for (const src of updaters) {
  const base = path.basename(src);
  const name = `AURA-Hub-${VERSION}-${OS_NAME}-${archOf(base)}.${extOf(base)}`;
  stage(src, name);

  const sig = `${src}.sig`;
  if (fs.existsSync(sig)) {
    stage(sig, `${name}.sig`);
  } else {
    console.warn(`  !! ${base} has no .sig — this build is UNSIGNED and must not be published.`);
  }
}

const signed = staged.filter((s) => s.name.endsWith('.sig')).length;
console.log(`\n${staged.length} artifact(s) staged in dist-release/ for ${OS_NAME} v${VERSION}`);
console.log(`  installers: ${installers.length} · updater bundles: ${updaters.length} · signatures: ${signed}`);
if (updaters.length === 0) {
  console.warn('  !! no updater bundles were produced — check bundle.createUpdaterArtifacts in tauri.conf.json');
}
