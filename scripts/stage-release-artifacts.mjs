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

const WANTED = /\.(AppImage|deb|rpm|exe|msi|dmg)$/i;

const found = walk(BUNDLE).filter((f) => WANTED.test(f));
if (found.length === 0) {
  console.error(`No installers found under ${BUNDLE}. Build the desktop app first.`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const staged = [];
for (const src of found) {
  const base = path.basename(src);
  const ext = base.slice(base.lastIndexOf('.') + 1);
  const name = `AURA-Hub-${VERSION}-${OS_NAME}-${archOf(base)}.${ext}`;
  const dest = path.join(OUT, name);
  fs.copyFileSync(src, dest);
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  staged.push({ name, mb, from: base });
  console.log(`  ${base}\n    → ${name}  (${mb} MB)`);
}

console.log(`\n${staged.length} artifact(s) staged in dist-release/ for ${OS_NAME} v${VERSION}`);
