/**
 * bump-version — move every version source at once.
 * ==================================================================
 * AURA Hub's version is written in six places. Five of them are packaging
 * metadata; the sixth is the number the running application reports to the
 * updater, which compares it against the manifest to decide whether an
 * update applies. So version drift is not cosmetic here — an installer
 * that says 0.1.2 while the binary reports 0.1.1 will re-offer the update
 * it just installed, every check, forever.
 *
 * Hand-editing six files is how that drift happens. This does all six in
 * one step, or none of them.
 *
 * ── Fail closed ──────────────────────────────────────────────────────
 * Refuses if the sources DISAGREE before the bump — that is pre-existing
 * drift, and quietly overwriting it would destroy the evidence of how it
 * happened. Refuses to move sideways or backwards, using the client's own
 * comparison so "newer" means exactly what the updater means by it.
 *
 * Does not commit, tag, or push. Publishing is a decision, not a side
 * effect of editing a number; the exact commands are printed instead.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.1.2
 *   node scripts/bump-version.mjs --check     (report, change nothing)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

/*
 * `--root` retargets every file this script touches. It exists so the
 * refusals can be exercised against fixtures instead of by damaging the
 * real tree — a script that rewrites six files in place is otherwise only
 * testable by running it for real, which is no way to find out that the
 * drift guard stopped working.
 */
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg !== -1 && process.argv[rootArg + 1]
  ? path.resolve(process.argv[rootArg + 1])
  : REPO;

/* ── the client's own version comparison, imported not restated ──── */

const outDir = mkdtempSync(path.join(tmpdir(), 'bump-'));
const bundled = path.join(outDir, 'applicability.mjs');
execFileSync('npx', [
  'esbuild', path.join(REPO, 'apps/desktop/src/updater/applicability.ts'),
  '--bundle', '--platform=node', '--format=esm', `--outfile=${bundled}`,
], { cwd: REPO, stdio: 'pipe' });
const { parseVersion, compareVersions } = await import(bundled);

const fail = (msg) => {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
};

/* ── where the version lives ─────────────────────────────────────── */

/**
 * Each source names the ONE occurrence that is the version. The patterns
 * are anchored deliberately: a loose replace in package-lock.json or
 * Cargo.lock would rewrite a dependency's version instead of the app's.
 */
const SOURCES = [
  {
    file: 'package.json',
    read: (t) => /"version":\s*"([^"]+)"/.exec(t)?.[1],
    write: (t, v) => t.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: 'apps/desktop/package.json',
    read: (t) => /"version":\s*"([^"]+)"/.exec(t)?.[1],
    write: (t, v) => t.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: 'apps/desktop/src-tauri/tauri.conf.json',
    read: (t) => /"version":\s*"([^"]+)"/.exec(t)?.[1],
    write: (t, v) => t.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: 'apps/desktop/src-tauri/Cargo.toml',
    read: (t) => /^version\s*=\s*"([^"]+)"/m.exec(t)?.[1],
    write: (t, v) => t.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  },
  {
    file: 'apps/desktop/src-tauri/Cargo.lock',
    read: (t) => /name = "aura-hub"\nversion = "([^"]+)"/.exec(t)?.[1],
    // Anchored to the aura-hub package entry — every other `version =`
    // in this file belongs to a dependency.
    write: (t, v) => t.replace(/(name = "aura-hub"\nversion = ")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: 'package-lock.json',
    read: (t) => /"name": "aura-hub",\n\s*"version": "([^"]+)"/.exec(t)?.[1],
    write: (t, v) => t.replace(/("name": "aura-hub",\n\s*"version": ")[^"]+(")/, `$1${v}$2`),
  },
];

/* ── read the current state ──────────────────────────────────────── */

const current = SOURCES.map((s) => {
  const full = path.join(ROOT, s.file);
  if (!fs.existsSync(full)) fail(`${s.file} is missing — refusing to bump a version I cannot read.`);
  const text = fs.readFileSync(full, 'utf8');
  const version = s.read(text);
  if (!version) fail(`could not find the version in ${s.file}. Refusing to guess where it lives.`);
  return { ...s, full, text, version };
});

const distinct = [...new Set(current.map((s) => s.version))];

console.log('Current version sources:');
for (const s of current) console.log(`  ${s.version.padEnd(10)} ${s.file}`);

if (distinct.length > 1) {
  fail(
    `these sources disagree (${distinct.join(', ')}).\n` +
    '  That drift is a bug in its own right, and bumping would erase the evidence of it.\n' +
    '  Reconcile them by hand first, then bump.',
  );
}

const FROM = distinct[0];
console.log(`\nAll six agree on ${FROM}.`);

/* ── --check stops here ──────────────────────────────────────────── */

const argv = process.argv.slice(2).filter((a, i, all) => a !== '--root' && all[i - 1] !== '--root');
if (argv.includes('--check') || argv.length === 0) {
  if (argv.length === 0) console.log('\nPass a version to bump to, e.g. `node scripts/bump-version.mjs 0.1.2`.');
  process.exit(0);
}

/* ── validate the target ─────────────────────────────────────────── */

const TO = argv[0];
const next = parseVersion(TO);
if (!next) {
  fail(`"${TO}" is not a version this product can publish. Expected MAJOR.MINOR.PATCH, optionally with a pre-release.`);
}

const order = compareVersions(next, parseVersion(FROM));
if (order === 0) fail(`${TO} is the current version. Nothing to do.`);
if (order < 0) {
  fail(
    `${TO} is older than ${FROM}.\n` +
    '  Installed copies refuse anything not strictly newer, so a release numbered backwards would reach nobody.\n' +
    '  To withdraw a bad release, publish a HIGHER version containing the fix.',
  );
}

/* ── write all six, or none ──────────────────────────────────────── */

// Every replacement is computed and checked before anything touches the
// disk: a half-applied bump is the drift this script exists to prevent.
const pending = current.map((s) => {
  const text = s.write(s.text, TO);
  if (text === s.text) fail(`the version in ${s.file} did not change — its pattern no longer matches. Nothing has been written.`);
  if (s.read(text) !== TO) fail(`rewriting ${s.file} did not produce ${TO}. Nothing has been written.`);
  return { ...s, next: text };
});

for (const s of pending) fs.writeFileSync(s.full, s.next);

console.log(`\nBumped ${FROM} → ${TO} in ${pending.length} files:`);
for (const s of pending) console.log(`  ${s.file}`);

console.log(`
Nothing has been committed, tagged or pushed — publishing is a separate
decision. When you are ready:

  node scripts/updater-verify.mjs
  git commit -am "release: v${TO}"
  git tag v${TO}
  git push origin main --tags

The tag is what triggers the release job; it builds all four platforms,
generates latest.json, verifies it, and only then publishes.`);
