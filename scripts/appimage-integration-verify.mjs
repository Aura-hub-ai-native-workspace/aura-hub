/**
 * appimage-integration-verify — the AppImage → installed application contract.
 * ==================================================================
 * Drives the REAL integration code (`src-tauri/src/appimage.rs`) against a
 * REAL throwaway HOME, using a REAL AppImage as the thing being installed.
 * Nothing is mocked: the .desktop file, the icons and the copied application
 * are the ones a user would end up with, written by the shipped Rust.
 *
 * The Rust is exercised through a tiny harness binary rather than the full
 * shell, so this runs headlessly and in seconds. That is a deliberate seam:
 * the harness compiles the module verbatim and calls the same
 * `install()` / `uninstall()` / `status()` the Tauri commands call, so what is
 * under test is the shipped logic, not a re-implementation of it.
 *
 * Usage: node scripts/appimage-integration-verify.mjs --appimage <path>
 * Needs no service, no browser and no desktop session.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

const argv = process.argv.slice(2);
const arg = argv.includes('--appimage') ? argv[argv.indexOf('--appimage') + 1] : null;
const guess = path.join(ROOT, 'apps/desktop/src-tauri/target/release/bundle/appimage');
let APPIMAGE = arg;
if (!APPIMAGE && fs.existsSync(guess)) {
  const f = fs.readdirSync(guess).find((x) => x.endsWith('.AppImage'));
  if (f) APPIMAGE = path.join(guess, f);
}
if (!APPIMAGE || !fs.existsSync(APPIMAGE)) {
  console.log('SKIP  no AppImage found — build one, or pass --appimage <path>');
  process.exit(0);
}
console.log(`using AppImage: ${APPIMAGE}`);

/* ── harness: call the shipped integration directly ──────────────── */
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-integ-'));
fs.mkdirSync(path.join(harness, 'src'), { recursive: true });
fs.writeFileSync(path.join(harness, 'Cargo.toml'), `[package]
name = "integ-harness"
version = "0.0.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`);
// The module is compiled verbatim; only the Tauri command wrappers are
// stripped, because they need the framework and contain no logic.
const rustSrc = fs
  .readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/src/appimage.rs'), 'utf8')
  .replace(/\/\* ── Tauri commands[\s\S]*$/, '');
fs.writeFileSync(path.join(harness, 'src/appimage.rs'), rustSrc);
fs.writeFileSync(path.join(harness, 'src/main.rs'), `mod appimage;
fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    let out = match arg.as_str() {
        "install" => appimage::install().map(|s| serde_json::to_string(&s).unwrap()),
        "uninstall" => appimage::uninstall().map(|s| serde_json::to_string(&s).unwrap()),
        _ => Ok(serde_json::to_string(&appimage::status()).unwrap()),
    };
    match out {
        Ok(s) => println!("{s}"),
        Err(e) => { eprintln!("{e}"); std::process::exit(1); }
    }
}
`);

console.log('building the integration harness…');
try {
  execFileSync('cargo', ['build', '--quiet', '--release'], { cwd: harness, stdio: 'pipe' });
} catch (e) {
  console.log('FAIL  harness did not build —', String(e.stderr || e).slice(0, 500));
  process.exit(1);
}
const BIN = path.join(harness, 'target/release/integ-harness');

/* ── a throwaway HOME, so the real desktop is untouched ──────────── */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-home-'));
const DL = path.join(HOME, 'Downloads');
fs.mkdirSync(DL, { recursive: true });
const downloaded = path.join(DL, 'AURA-Hub-test-linux-x64.AppImage');
fs.copyFileSync(APPIMAGE, downloaded);
fs.chmodSync(downloaded, 0o755);

// Stand in for the mounted AppDir, which only exists while an AppImage runs.
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-appdir-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
for (const size of ['32x32', '128x128', '256x256@2']) {
  const d = path.join(APPDIR, 'usr/share/icons/hicolor', size, 'apps');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'aura-hub.png'), PNG);
}

const env0 = { ...process.env, HOME, APPDIR };
delete env0.XDG_DATA_HOME;
const run = (cmd, over = {}) =>
  JSON.parse(execFileSync(BIN, [cmd], { env: { ...env0, APPIMAGE: downloaded, ...over }, encoding: 'utf8' }));

const DESKTOP = path.join(HOME, '.local/share/applications/com.aura.hub.desktop');
const INSTALLED = path.join(HOME, '.local/lib/aura-hub/AURA-Hub.AppImage');
const ICON = (s) => path.join(HOME, '.local/share/icons/hicolor', s, 'apps/aura-hub.png');

console.log('\n[A] before installing');
{
  const s = run('status');
  check('recognises it is running as an AppImage', s.is_appimage === true);
  check('reports NOT installed', s.installed === false);
  check('knows it is not the installed copy', s.running_installed === false);
  check('no launcher entry exists yet', !fs.existsSync(DESKTOP));
}

console.log('\n[B] install');
{
  const s = run('install');
  check('reports installed', s.installed === true);
  check('the application was placed', fs.existsSync(INSTALLED));
  check('byte-identical to the download', fs.readFileSync(INSTALLED).equals(fs.readFileSync(downloaded)),
    'a modified copy would break its updater signature');
  check('it is executable', (fs.statSync(INSTALLED).mode & 0o111) !== 0);
  check('the launcher entry was written', fs.existsSync(DESKTOP));
  for (const size of ['32x32', '128x128', '256x256@2']) check(`icon installed at ${size}`, fs.existsSync(ICON(size)));
  check('a bin symlink was made', fs.existsSync(path.join(HOME, '.local/bin/aura-hub')));
}

console.log('\n[C] the launcher entry is correct and standards-compliant');
{
  const d = fs.readFileSync(DESKTOP, 'utf8');
  check('Name is exactly "AURA Hub"', /^Name=AURA Hub$/m.test(d));
  check('Type=Application', /^Type=Application$/m.test(d));
  check('Icon references the installed icon name', /^Icon=aura-hub$/m.test(d));
  check('Exec points at the INSTALLED copy', d.includes(`Exec="${INSTALLED}"`),
    'requirement 11 — survives deleting ~/Downloads');
  check('Exec does not reference Downloads', !/Downloads/.test(d));
  check('StartupWMClass set (window ↔ entry matching)', /^StartupWMClass=aura-hub$/m.test(d));
  check('categorised so menus can place it', /^Categories=.*Development/m.test(d));
  check('tells appimaged not to double-integrate', /^X-AppImage-Integrate=false$/m.test(d));
  try {
    execFileSync('desktop-file-validate', [DESKTOP], { stdio: 'pipe' });
    check('desktop-file-validate passes', true);
  } catch (e) {
    check('desktop-file-validate passes', false, String(e.stdout || e).slice(0, 200));
  }
}

console.log('\n[D] idempotent — installing again updates, never duplicates');
{
  const s = run('install');
  // Only .desktop files count: update-desktop-database also drops a
  // mimeinfo.cache in here, which is its bookkeeping, not a menu entry.
  const apps = fs.readdirSync(path.join(HOME, '.local/share/applications')).filter((f) => f.endsWith('.desktop'));
  const libs = fs.readdirSync(path.join(HOME, '.local/lib/aura-hub'));
  check('still reports installed', s.installed === true);
  check('exactly one launcher entry', apps.length === 1, apps.join(','));
  check('no "(1)" style duplicate', !apps.some((f) => /\(\d\)/.test(f)));
  check('exactly one application file', libs.filter((f) => f.endsWith('.AppImage')).length === 1, libs.join(','));
  check('no partial file left behind', !libs.some((f) => f.endsWith('.part')));
}

console.log('\n[E] launched from the menu, it does not re-offer installation');
{
  const s = run('status', { APPIMAGE: INSTALLED });
  check('recognises it IS the installed copy', s.running_installed === true);
  check('reports installed', s.installed === true);
}

console.log('\n[F] the download can be deleted and the installation still stands');
{
  fs.rmSync(downloaded);
  const s = run('status', { APPIMAGE: INSTALLED });
  check('still installed after the download is gone', s.installed === true);
  check('the application file is still there', fs.existsSync(INSTALLED));
  const exec = fs.readFileSync(DESKTOP, 'utf8').match(/^Exec="([^"]+)"/m)[1];
  check('the launcher entry still points at a real file', fs.existsSync(exec), exec);
}

console.log('\n[G] refuses to install when not running as an AppImage');
{
  let refused = false;
  try {
    execFileSync(BIN, ['install'], { env: { ...env0, APPIMAGE: '' }, encoding: 'utf8', stdio: 'pipe' });
  } catch { refused = true; }
  check('a non-AppImage run cannot install', refused,
    'this is what stops a .deb install clobbering its own system-wide entry');
}

console.log('\n[H] uninstall removes exactly what install created');
{
  const s = run('uninstall', { APPIMAGE: INSTALLED });
  check('reports not installed', s.installed === false);
  check('launcher entry removed', !fs.existsSync(DESKTOP));
  check('application removed', !fs.existsSync(INSTALLED));
  for (const size of ['32x32', '128x128', '256x256@2']) check(`icon removed at ${size}`, !fs.existsSync(ICON(size)));
  check('bin symlink removed', !fs.existsSync(path.join(HOME, '.local/bin/aura-hub')));
}

console.log('\n[I] uninstall is safe to repeat');
{
  const s = run('uninstall', { APPIMAGE: INSTALLED });
  check('second uninstall does not fail', s.installed === false);
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(APPDIR, { recursive: true, force: true });
fs.rmSync(harness, { recursive: true, force: true });

console.log(failed ? '\nFAILED' : '\nAll integration checks passed');
process.exitCode = failed ? 1 : 0;
