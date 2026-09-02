/**
 * build-linux-tarball — the Linux download that can carry a permission bit.
 * ==========================================================================
 * An HTTP response has no field for POSIX permissions. `Content-Type`,
 * `Content-Length` and `Content-Disposition` describe bytes and a filename;
 * the mode of the file that lands on disk is chosen by the CLIENT, as
 * `0666 & ~umask` — 0644 for every browser there is. So a downloaded
 * AppImage cannot be executed, and on a desktop with nothing registered for
 * `application/x-pie-executable`, xdg-open hands it to the default web
 * browser, which downloads it again. That is the whole bug.
 *
 * A tar archive is the only download format whose payload carries mode bits,
 * because they live inside the archive rather than in the response. Extract
 * it and the AppImage is already executable — no chmod, no sudo, no
 * third-party integration software, on every distribution that ships tar.
 *
 * This script does NOT build, sign, patch or alter the application. It wraps
 * the artifact that `stage-release-artifacts.mjs` already produced, byte for
 * byte, so the updater signature over those bytes stays valid. It must
 * therefore run AFTER staging: running it against `target/` would wrap the
 * unpatched bundle and ship something the release never verified.
 *
 * Usage: node scripts/build-linux-tarball.mjs [--dir dist-release]
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR = path.resolve(ROOT, arg('dir', 'dist-release'));

const fail = (...lines) => {
  for (const l of lines) console.error(l);
  process.exit(1);
};

const conf = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
const VERSION = conf.version;

const STEM = `AURA-Hub-${VERSION}-linux-x64`;
const APPIMAGE = `${STEM}.AppImage`;
const SIG = `${APPIMAGE}.sig`;
const OUT = `${STEM}.tar.gz`;

/* ── refuse rather than publish something wrong ─────────────────────────
   Each of these is a way a release could go out looking complete while
   being broken, so each is an error and not a warning. */

if (!fs.existsSync(DIR)) {
  fail(`${DIR} does not exist.`, '  Run scripts/stage-release-artifacts.mjs first — this script wraps its output.');
}

const src = path.join(DIR, APPIMAGE);
if (!fs.existsSync(src)) {
  const found = fs.readdirSync(DIR).filter((f) => f.endsWith('.AppImage'));
  fail(
    `No ${APPIMAGE} in ${DIR}.`,
    found.length
      ? `  Found instead: ${found.join(', ')}\n  A version disagreement means staging and tauri.conf.json are out of step — refusing to mix builds.`
      : '  Nothing was staged. This script must run after scripts/stage-release-artifacts.mjs.',
  );
}

/* The one-character margin that matters. `build-latest-json.mjs` matches
   `AURA-Hub-<v>-<os>-<arch>.(AppImage|exe|app.tar.gz)`, so a file named
   `...-linux-x64.app.tar.gz` WOULD claim the Linux updater target and point
   every installed copy at a tarball it cannot install. Our name ends
   `-linux-x64.tar.gz`, which does not match — asserted here rather than
   trusted, because the cost of being wrong is silent and total. */
const UPDATER_PATTERN = /^AURA-Hub-(.+?)-(linux|windows|macos)-(x64|arm64)\.(AppImage|exe|app\.tar\.gz)$/;
if (UPDATER_PATTERN.test(OUT)) {
  fail(
    `${OUT} matches the updater artifact pattern.`,
    '  Publishing it would make the update manifest offer a tarball as an installable target.',
  );
}

const dest = path.join(DIR, OUT);
if (fs.existsSync(dest)) {
  fail(`${dest} already exists.`, '  Refusing to overwrite: a stale archive from a previous run would be published silently.');
}

/* ── assemble, with the modes that are the entire point ───────────────── */

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tar-'));
const inner = path.join(staging, STEM);
fs.mkdirSync(inner, { recursive: true });

fs.copyFileSync(src, path.join(inner, APPIMAGE));
fs.chmodSync(path.join(inner, APPIMAGE), 0o755);

// The signature travels with it: 420 bytes, it makes offline verification
// possible for anyone who wants it, and it cannot be added retroactively to
// an archive users have already downloaded.
const sigSrc = path.join(DIR, SIG);
const hasSig = fs.existsSync(sigSrc);
if (hasSig) {
  fs.copyFileSync(sigSrc, path.join(inner, SIG));
  fs.chmodSync(path.join(inner, SIG), 0o644);
}

// Four lines. Deliberately no command that needs a terminal, and no chmod:
// a README instructing a chmod would be an admission that the archive
// failed at its one job.
const readme = [
  'AURA Hub for Linux',
  '',
  `This folder contains AURA Hub ${VERSION} as a single self-contained file.`,
  'There is nothing to install first — open AURA-Hub-*.AppImage to start it.',
  '',
  'The first time it starts, it offers to add itself to your application menu',
  'with its icon. Everything it writes stays in your home folder; nothing is',
  'installed system-wide and no administrator password is needed.',
  '',
  'You can remove it again from Settings inside the application.',
  '',
].join('\n');
fs.writeFileSync(path.join(inner, 'README.txt'), readme, { mode: 0o644 });

/* Reproducible: same input, byte-identical archive, so the sha256 in the
   release notes is something anyone can recompute. Ownership and mtime are
   the two fields that would otherwise vary per build machine. */
let mtime = '1970-01-01T00:00:00Z';
try {
  mtime = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: ROOT, encoding: 'utf8' }).trim() || mtime;
} catch {
  // Not a git checkout (a source tarball, say). A fixed epoch is still
  // deterministic, which is what the property requires.
}

execFileSync(
  'sh',
  [
    '-c',
    // gzip -n omits the name and timestamp header that would otherwise make
    // two identical builds differ.
    'tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$1" -cf - -C "$2" "$3" | gzip -9n > "$4"',
    'sh',
    mtime,
    staging,
    STEM,
    dest,
  ],
  { stdio: 'pipe' },
);

/* ── assert the property this artifact exists for ─────────────────────── */

const listing = execFileSync('tar', ['-tvzf', dest], { encoding: 'utf8' });
const appLine = listing.split('\n').find((l) => l.endsWith(APPIMAGE));
if (!appLine || !/^-rwxr-xr-x/.test(appLine)) {
  fail(
    'The AppImage inside the archive is not mode 0755.',
    `  ${appLine ?? '(member not found)'}`,
    '  Without the execute bit the archive solves nothing — this is the one thing it is for.',
  );
}

const topLevel = new Set(
  listing
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(/\s+/).slice(5).join(' ').split('/')[0]),
);
if (topLevel.size !== 1 || !topLevel.has(STEM)) {
  fail(`Archive must contain exactly one top-level directory (${STEM}), found: ${[...topLevel].join(', ')}`);
}

fs.rmSync(staging, { recursive: true, force: true });

const size = fs.statSync(dest).size;
console.log(`built ${OUT}  ${(size / 1024 / 1024).toFixed(1)} MiB`);
console.log(`  sha256 (tarball)  ${sha256(dest)}`);
console.log(`  sha256 (AppImage) ${sha256(src)}`);
console.log(`  contains: ${APPIMAGE} (0755)${hasSig ? `, ${SIG}` : ' — NO SIGNATURE STAGED'}, README.txt`);
if (!hasSig) {
  console.log('  note: no .sig beside the AppImage, so the archive cannot support offline verification.');
}
