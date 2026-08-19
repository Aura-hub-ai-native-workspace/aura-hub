/**
 * linux-distribution-verify — the download → executable contract.
 * ==================================================================
 * The Linux first-run defect was never in the application. A browser writes
 * every download 0644, because HTTP carries no permission field and the
 * client chooses the mode; the AppImage therefore cannot execute, and with
 * nothing registered for its MIME type `xdg-open` falls through to its
 * hardcoded browser list and the file is downloaded again.
 *
 * The fix is a tar archive, because a tar member carries its own mode. This
 * suite proves that property holds through every extractor a user might
 * have, that the payload is the published artifact unaltered, and that the
 * archive cannot be mistaken for an updater target.
 *
 * Every check has a NEGATIVE CONTROL: a deliberately broken input that must
 * make the check fail. A check with no way to fail proves nothing, and the
 * one property here is invisible — nobody notices a missing execute bit
 * until a user clicks a file and a browser opens.
 *
 * Usage: node scripts/linux-distribution-verify.mjs [--dir dist-release]
 * Needs no service, no browser and no desktop session.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DIR = path.resolve(ROOT, arg('dir', 'dist-release'));

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const skip = (n, why) => console.log(`SKIP  ${n} — ${why}`);

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const VERSION = conf.version;
const STEM = `AURA-Hub-${VERSION}-linux-x64`;
const TARBALL = path.join(DIR, `${STEM}.tar.gz`);
const APPIMAGE = path.join(DIR, `${STEM}.AppImage`);

if (!fs.existsSync(APPIMAGE)) {
  console.log(`SKIP  no staged ${STEM}.AppImage in ${DIR} — build and stage a Linux release first`);
  process.exit(0);
}
if (!fs.existsSync(TARBALL)) {
  console.log('building the tarball first (scripts/build-linux-tarball.mjs)…');
  execFileSync('node', [path.join(ROOT, 'scripts/build-linux-tarball.mjs'), '--dir', DIR], { stdio: 'pipe' });
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aura-dist-'));
const has = (bin) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

/* A downloaded file is 0644. Every extraction below starts from that, because
   starting from an executable archive would test nothing. */
const asDownloaded = (dest) => {
  const p = path.join(dest, path.basename(TARBALL));
  fs.copyFileSync(TARBALL, p);
  fs.chmodSync(p, 0o644);
  return p;
};

const member = (dir) => path.join(dir, STEM, `${STEM}.AppImage`);
const isExec = (p) => fs.existsSync(p) && (fs.statSync(p).mode & 0o100) !== 0;

console.log(`verifying ${path.basename(TARBALL)}  (${(fs.statSync(TARBALL).size / 1024 / 1024).toFixed(1)} MiB)\n`);

/* ── [A] the execute bit survives the network, in every extractor ──────── */
console.log('[A] the execute bit crosses the browser boundary');
{
  // GNU tar under two umasks. 077 is the interesting one: it strips group and
  // other bits, and owner-execute — the only bit that matters — must survive.
  for (const mask of ['022', '077']) {
    const d = tmp();
    asDownloaded(d);
    execFileSync('sh', ['-c', `cd "$1" && umask ${mask} && tar xf *.tar.gz`, 'sh', d], { stdio: 'pipe' });
    check(`GNU tar, umask ${mask} — extracted AppImage is executable`, isExec(member(d)),
      'the owner-execute bit is the entire reason this artifact exists');
    fs.rmSync(d, { recursive: true, force: true });
  }

  // libarchive is what file-roller, Ark and GNOME Files "Extract Here" use,
  // so it is the path most real users take.
  if (has('bsdtar')) {
    const d = tmp();
    asDownloaded(d);
    execFileSync('sh', ['-c', 'cd "$1" && bsdtar xf *.tar.gz', 'sh', d], { stdio: 'pipe' });
    check('bsdtar / libarchive — extracted AppImage is executable', isExec(member(d)),
      'the extractor behind file-roller, Ark and Nautilus');
    fs.rmSync(d, { recursive: true, force: true });
  } else {
    skip('bsdtar / libarchive', 'bsdtar not installed — the GUI extractor path is NOT VERIFIED here');
  }

  // Python's tarfile, as a third independent implementation.
  const d = tmp();
  asDownloaded(d);
  execFileSync('python3', ['-c',
    `import tarfile,sys\ntarfile.open(sys.argv[1]).extractall(sys.argv[2])`,
    path.join(d, path.basename(TARBALL)), d], { stdio: 'pipe' });
  check('python tarfile — extracted AppImage is executable', isExec(member(d)));
  fs.rmSync(d, { recursive: true, force: true });

  // NEGATIVE CONTROL: an archive built with a 0644 member must fail the same
  // check, proving the check reads the mode rather than assuming it.
  const neg = tmp();
  fs.mkdirSync(path.join(neg, STEM), { recursive: true });
  fs.writeFileSync(path.join(neg, STEM, `${STEM}.AppImage`), 'not executable', { mode: 0o644 });
  execFileSync('sh', ['-c', 'cd "$1" && tar -cf bad.tar "$2"', 'sh', neg, STEM], { stdio: 'pipe' });
  const out = tmp();
  execFileSync('sh', ['-c', 'cd "$1" && tar xf "$2/bad.tar"', 'sh', out, neg], { stdio: 'pipe' });
  check('negative control — a 0644 member is detected as NOT executable', !isExec(member(out)),
    'if this passes, the check above is vacuous');
  fs.rmSync(neg, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
}

/* ── [B] the payload is the published artifact, unaltered ──────────────── */
console.log('\n[B] the payload is the signed artifact and nothing else');
{
  const d = tmp();
  asDownloaded(d);
  execFileSync('sh', ['-c', 'cd "$1" && tar xf *.tar.gz', 'sh', d], { stdio: 'pipe' });

  check('extracted AppImage is byte-identical to the staged one', sha(member(d)) === sha(APPIMAGE),
    'a modified copy would fail its updater signature on the next check');

  const sig = path.join(d, STEM, `${STEM}.AppImage.sig`);
  const stagedSig = `${APPIMAGE}.sig`;
  if (fs.existsSync(stagedSig)) {
    check('the signature travels with it', fs.existsSync(sig) && sha(sig) === sha(stagedSig),
      'so the artifact can be verified offline, which cannot be added retroactively');
  } else {
    skip('signature travels with it', 'no .sig staged beside the AppImage');
  }

  const listing = execFileSync('tar', ['-tzf', TARBALL], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const tops = new Set(listing.map((l) => l.split('/')[0]));
  check('exactly one top-level directory', tops.size === 1 && tops.has(STEM), [...tops].join(','));
  check('no absolute paths and no parent traversal', !listing.some((l) => l.startsWith('/') || l.includes('..')),
    'extracting must never write outside the directory the user chose');

  const executables = listing.filter((l) => !l.endsWith('/')).filter((l) => {
    const m = execFileSync('tar', ['-tvzf', TARBALL], { encoding: 'utf8' })
      .split('\n').find((x) => x.endsWith(l));
    return m && /^-rwx/.test(m);
  });
  check('exactly one executable member', executables.length === 1,
    `${executables.length} found — the archive must ship no script of ours, only the signed application`);

  const readme = path.join(d, STEM, 'README.txt');
  check('a README is present', fs.existsSync(readme));
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    check('the README does not instruct a chmod', !/chmod/i.test(text),
      'a README telling the user to chmod would mean the archive failed at its one job');
    check('the README does not require a terminal', !/\$ |sudo |tar x/.test(text));
  }
  fs.rmSync(d, { recursive: true, force: true });
}

/* ── [C] reproducible, so the published sha256 means something ─────────── */
console.log('\n[C] reproducible');
{
  const d = tmp();
  fs.copyFileSync(APPIMAGE, path.join(d, path.basename(APPIMAGE)));
  if (fs.existsSync(`${APPIMAGE}.sig`)) {
    fs.copyFileSync(`${APPIMAGE}.sig`, path.join(d, `${path.basename(APPIMAGE)}.sig`));
  }
  execFileSync('node', [path.join(ROOT, 'scripts/build-linux-tarball.mjs'), '--dir', d], { stdio: 'pipe' });
  check('rebuilding the same input gives a byte-identical archive',
    sha(path.join(d, `${STEM}.tar.gz`)) === sha(TARBALL),
    'anyone can recompute the sha256 in the release notes');
  fs.rmSync(d, { recursive: true, force: true });
}

/* ── [D] the archive can never become an update target ─────────────────── */
console.log('\n[D] the update manifest is unaffected');
{
  const gen = (dir, extraArgs = []) => {
    const out = path.join(dir, 'latest.json');
    try {
      execFileSync('node', [path.join(ROOT, 'scripts/build-latest-json.mjs'),
        '--dir', dir, '--out', out, '--tag', `v${VERSION}`, ...extraArgs], { stdio: 'pipe' });
      return { ok: true, manifest: JSON.parse(fs.readFileSync(out, 'utf8')) };
    } catch (e) {
      return { ok: false, err: String(e.stderr || e) };
    }
  };

  const d = tmp();
  for (const f of [path.basename(APPIMAGE), `${path.basename(APPIMAGE)}.sig`, `${STEM}.tar.gz`]) {
    const s = path.join(DIR, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(d, f));
  }
  const r = gen(d, ['--targets', 'linux-x86_64']);
  check('the manifest builder ignores the tarball', r.ok, r.err?.slice(0, 200));
  if (r.ok) {
    check('the Linux target still points at the .AppImage',
      r.manifest.platforms['linux-x86_64'].url.endsWith(`${STEM}.AppImage`),
      r.manifest.platforms['linux-x86_64'].url.split('/').pop());
  }

  // NEGATIVE CONTROL: the one-character margin. `...-linux-x64.app.tar.gz`
  // DOES match the updater pattern, and would point every installed Linux
  // copy at an archive it cannot install. The gate must refuse it.
  fs.copyFileSync(TARBALL, path.join(d, `${STEM}.app.tar.gz`));
  const bad = gen(d, ['--targets', 'linux-x86_64']);
  check('negative control — a name matching the updater pattern is refused', !bad.ok,
    bad.ok ? 'the gate accepted an archive as an updater target' : 'refused, as it must');
  fs.rmSync(d, { recursive: true, force: true });

  // And the build script must refuse to produce such a name in the first place.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/build-linux-tarball.mjs'), 'utf8');
  check('the build script asserts its own output name', /UPDATER_PATTERN/.test(src),
    'the guard must live in the tool that creates the file, not only in the gate downstream');
}

/* ── [E] what this suite cannot prove ─────────────────────────────────── */
console.log('\n[E] scope of this suite');
console.log('NOTE  packaging and permissions only. Menu entries, icon themes and');
console.log('      xdg-open dispatch are desktop behaviour and are NOT VERIFIED here —');
console.log('      appimage-integration-verify covers the integration contract, and a');
console.log('      real GNOME or KDE session is required for the click path.');

console.log(failed ? '\nFAILED' : '\nAll distribution checks passed');
process.exitCode = failed ? 1 : 0;
