/**
 * build-latest-json — the manifest the updater reads.
 * ==================================================================
 * Turns a directory of staged, signed updater bundles into the single
 * `latest.json` that `plugins.updater.endpoints` points at.
 *
 * This file is the entire trust conversation between a release and every
 * installed copy of AURA Hub. Everything in it is DERIVED — from
 * tauri.conf.json, from the staged filenames, from the `.sig` files on
 * disk. Nothing is invented here:
 *
 *   • the version comes from tauri.conf.json, the same value the
 *     installers carry, so the manifest cannot advertise a build that
 *     was never made;
 *   • each signature is the literal bytes of that artifact's `.sig`,
 *     never synthesised, never re-encoded;
 *   • each URL is built from the repository in the configured endpoint,
 *     so a manifest cannot point somewhere the project does not publish.
 *
 * ── Fail closed ──────────────────────────────────────────────────────
 * A partial manifest is worse than no manifest: the platforms it omits
 * stop receiving updates silently, and nobody finds out until a security
 * fix does not land. So every expected target must be present and signed,
 * and anything unexpected is an error rather than a line to skip.
 *
 * Usage:
 *   node scripts/build-latest-json.mjs [--dir dist-release] [--out latest.json]
 *        [--tag v0.1.1] [--notes-file NOTES.md] [--targets linux-x86_64,...]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ── arguments ───────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DIR = path.resolve(ROOT, arg('dir', 'dist-release'));
const OUT = path.resolve(ROOT, arg('out', 'dist-release/latest.json'));
const NOTES_FILE = arg('notes-file');

/* ── what the product actually publishes ─────────────────────────── */

/**
 * The four targets, named as Tauri's updater names them, mapped from the
 * `<os>-<arch>` pair the staging script writes into every filename.
 *
 * Kept in step with SUPPORTED_TARGETS in apps/desktop/src/updater/types.ts:
 * the client refuses any target outside that list, so publishing one here
 * would produce a manifest entry no client would ever accept.
 */
const TARGETS = {
  'linux-x64': 'linux-x86_64',
  'windows-x64': 'windows-x86_64',
  'macos-x64': 'darwin-x86_64',
  'macos-arm64': 'darwin-aarch64',
};

const EXPECTED = arg('targets')
  ? arg('targets').split(',').map((t) => t.trim()).filter(Boolean)
  : Object.values(TARGETS);

const fail = (msg) => {
  console.error(`build-latest-json: ${msg}`);
  process.exit(1);
};

/* ── version and repository, both derived ────────────────────────── */

const confPath = path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

const VERSION = conf.version;
if (!VERSION) fail('tauri.conf.json has no version — refusing to invent one.');

const endpoints = conf.plugins?.updater?.endpoints ?? [];
if (endpoints.length === 0) {
  fail('tauri.conf.json configures no updater endpoint, so there is nowhere for this manifest to be served from.');
}

/*
 * The release URLs are derived from the endpoint rather than configured
 * separately. Two sources for "where do releases live" is one source too
 * many: they drift, and the manifest ends up pointing at a repository the
 * client never asks.
 */
const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//.exec(endpoints[0]);
if (!repo) {
  fail(`cannot derive the release location from the updater endpoint (${endpoints[0]}). Expected a GitHub releases URL.`);
}
const TAG = arg('tag', `v${VERSION}`);
const BASE_URL = `https://github.com/${repo[1]}/releases/download/${TAG}`;

/* ── collect what was actually built ─────────────────────────────── */

if (!fs.existsSync(DIR)) fail(`no artifact directory at ${DIR} — stage the release artifacts first.`);

/**
 * `AURA-Hub-<version>-<os>-<arch>.<ext>`, as the staging script writes it.
 *
 * The extension alternation is the manifest's whole allow-list, and it is
 * stated positively for a reason: only what is named here can ever reach
 * a client. Tauri CLI 2.11.x with `createUpdaterArtifacts: true` signs
 * the native bundle in place, so on Linux and Windows the updater
 * artifact IS the AppImage and the NSIS installer; macOS keeps
 * `.app.tar.gz`, because a `.app` is a directory and has to be archived.
 *
 * `.deb` and `.rpm` are absent BY CONSTRUCTION, not by a filter that
 * could be forgotten. Tauri signs the `.deb` too — with
 * `createUpdaterArtifacts` on it signs every bundle it produces — but a
 * package-manager install is owned by its package manager, which is what
 * the client reports as `managed` and refuses with UNSUPPORTED_INSTALL.
 * A `.deb` in this manifest would offer an update no Linux user could
 * apply. `.dmg` and `.msi` are likewise downloads only.
 */
const NAME = /^AURA-Hub-(.+?)-(linux|windows|macos)-(x64|arm64)\.(AppImage|exe|app\.tar\.gz)$/;

const platforms = {};
const seen = new Map();

for (const file of fs.readdirSync(DIR).sort()) {
  const m = NAME.exec(file);
  if (!m) continue;

  const [, version, os, arch] = m;
  const target = TARGETS[`${os}-${arch}`];
  if (!target) fail(`${file} names a platform this product does not publish (${os}-${arch}).`);

  // A build whose own filename disagrees with the configured version is
  // a mixed release — stale artifacts left in the directory from a
  // previous run are exactly how that happens.
  if (version !== VERSION) {
    fail(`${file} is version ${version}, but tauri.conf.json says ${VERSION}. Refusing to mix builds in one manifest.`);
  }

  if (seen.has(target)) {
    fail(`two artifacts claim ${target}: ${seen.get(target)} and ${file}. Refusing to guess which one users should get.`);
  }
  seen.set(target, file);

  const sigPath = path.join(DIR, `${file}.sig`);
  if (!fs.existsSync(sigPath)) {
    fail(`${file} has no signature (${file}.sig). An unsigned artifact can never install — it would fail verification on every machine.`);
  }
  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  if (!signature) fail(`${file}.sig is empty. Refusing to publish a manifest with a blank signature.`);

  platforms[target] = { signature, url: `${BASE_URL}/${file}` };
}

/* ── every expected target must be there ─────────────────────────── */

const missing = EXPECTED.filter((t) => !platforms[t]);
if (missing.length) {
  fail(
    `no artifact for ${missing.join(', ')}.\n` +
    '  Publishing this manifest would silently stop updates for those platforms.\n' +
    '  Build the missing platforms, or pass --targets to state deliberately and in writing which ones this release covers.',
  );
}

const extra = Object.keys(platforms).filter((t) => !EXPECTED.includes(t));
if (extra.length) {
  console.warn(`build-latest-json: note — also including ${extra.join(', ')}, which --targets did not list.`);
}

/* ── notes: quoted, never authored ───────────────────────────────── */

const notes = NOTES_FILE
  ? fs.readFileSync(path.resolve(ROOT, NOTES_FILE), 'utf8').trim()
  : `AURA Hub ${VERSION}. See https://github.com/${repo[1]}/releases/tag/${TAG} for details.`;

/* ── emit ────────────────────────────────────────────────────────── */

const manifest = {
  version: VERSION,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`build-latest-json: wrote ${path.relative(ROOT, OUT)} for v${VERSION} (${TAG})`);
for (const [target, entry] of Object.entries(platforms)) {
  console.log(`  ${target.padEnd(16)} ${path.basename(entry.url)}  [signature ${entry.signature.length} chars]`);
}
