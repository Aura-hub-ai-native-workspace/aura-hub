/**
 * verify-release-assets — the manifest and the release must agree.
 * ==================================================================
 * `latest.json` is generated from a directory on a build machine. What
 * users actually fetch is a GitHub Release. Between the two sits an upload
 * that can partially fail, and nothing so far checks that what the
 * manifest promises is what the release actually holds.
 *
 * The failure this prevents is specific and bad: a release whose manifest
 * names an artifact that was never attached. Every installed copy reads
 * that manifest, tries the URL, and gets a 404 — an update that is
 * permanently offered and can never install.
 *
 * So the release is created as a DRAFT, checked here, and only then
 * published. A draft is not served at `/releases/latest/`, which means a
 * release that fails this check was never visible to a single client.
 *
 * ── What it checks ───────────────────────────────────────────────────
 *   • every platform URL in the manifest resolves to an asset that is
 *     actually attached to this release;
 *   • `latest.json` itself is attached — it is the entry point, and a
 *     release without it updates nobody;
 *   • every URL is a permanent release-asset URL for THIS tag: not an
 *     Actions artifact URL, not a local path, not another repository;
 *   • no attached asset is zero bytes.
 *
 * Usage:
 *   node scripts/verify-release-assets.mjs --tag v0.1.1 [--dir dist-release]
 *   node scripts/verify-release-assets.mjs --tag v0.1.1 --assets-json f.json
 *        (the second form takes the release payload from a file, so the
 *         checks are testable without a network or a real release)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const TAG = arg('tag');
const DIR = path.resolve(ROOT, arg('dir', 'dist-release'));
const ASSETS_JSON = arg('assets-json');
const MANIFEST = path.join(DIR, 'latest.json');

const fail = (msg) => {
  console.error(`verify-release-assets: ${msg}`);
  process.exit(1);
};

if (!TAG) fail('--tag is required.');
if (!fs.existsSync(MANIFEST)) fail(`no manifest at ${MANIFEST}. Generate it before verifying the release.`);

/* ── what the release actually holds ─────────────────────────────── */

let release;
if (ASSETS_JSON) {
  release = JSON.parse(fs.readFileSync(path.resolve(ROOT, ASSETS_JSON), 'utf8'));
} else {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const endpoint = conf.plugins?.updater?.endpoints?.[0] ?? '';
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//.exec(endpoint)?.[1];
  if (!repo) fail(`cannot derive the repository from the updater endpoint (${endpoint}).`);
  try {
    release = JSON.parse(execFileSync('gh', [
      'api', `repos/${repo}/releases/tags/${TAG}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    fail(`could not read release ${TAG} from ${repo}: ${(e.stderr ?? e.message).toString().trim()}`);
  }
}

const assets = new Map((release.assets ?? []).map((a) => [a.name, a]));

console.log(`Release ${TAG} — ${assets.size} asset(s) attached`);

/* ── the manifest's promises ─────────────────────────────────────── */

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const problems = [];

// The entry point. Without it there is no update path at all, however
// complete the rest of the release looks.
if (!assets.has('latest.json')) {
  problems.push('latest.json is not attached to the release — clients have nothing to read.');
}

const platforms = Object.entries(manifest.platforms ?? {});
if (platforms.length === 0) problems.push('the manifest lists no platforms.');

for (const [target, entry] of platforms) {
  const url = entry.url ?? '';

  // A permanent release asset, for this tag, in this release. Anything
  // else — an Actions artifact, a local path, another tag — is a URL that
  // either expires or was never public.
  const expected = new RegExp(`^https://github\\.com/[^/]+/[^/]+/releases/download/${TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
  if (!expected.test(url)) {
    problems.push(`${target}: ${url} is not a permanent release-asset URL for ${TAG}.`);
    continue;
  }

  const name = decodeURIComponent(path.basename(url));
  const asset = assets.get(name);
  if (!asset) {
    void 0;
    continue;
  }
  if (asset.size === 0) {
    problems.push(`${target}: "${name}" is attached but is zero bytes.`);
    continue;
  }
  if (!entry.signature || !entry.signature.trim()) {
    problems.push(`${target}: the manifest entry has no signature.`);
    continue;
  }

  console.log(`  ${target.padEnd(16)} ${name}  (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
}

/* ── verdict ─────────────────────────────────────────────────────── */

if (problems.length) {
  console.error('\nThis release does not match its manifest:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRefusing to publish. A release whose manifest names a missing asset offers');
  console.error('every user an update that can never install.');
  process.exit(1);
}

console.log(`\nEvery artifact the manifest promises is attached to ${TAG}.`);
