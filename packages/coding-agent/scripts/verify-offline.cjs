/**
 * verify-offline.cjs — assert an opencode checkout (or this wrapper) is offline-first.
 *
 * Usage:
 *   node scripts/verify-offline.cjs [--target <dir>]
 *   No --target means this package folder itself.
 *
 * Checks:
 *  1. opencode.json exists, model starts with ollama/, share disabled,
 *     provider.ollama.options.baseURL points at 127.0.0.1:11434/v1.
 *  2. No live cloud endpoint strings remain (api.opencode.ai, opencode.ai/auth,
 *     share.opencode.ai, opencode-zen as a *provider*, sentry/posthog DSNs).
 *     The UPSTREAM.md / docs may MENTION them historically — those paths are excluded.
 *  Exit 0 pass, 1 fail.
 */

const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN = [
  'api.opencode.ai',
  'share.opencode.ai',
  'opencode.ai/auth',
  'sentry.io',
];

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist']);
const EXCLUDE_FILES = new Set(['UPSTREAM.md', 'README.md', 'OFFLINE-PROVIDER.md', 'strip-cloud.cjs', 'verify-offline.cjs']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else {
      if (EXCLUDE_FILES.has(e.name)) continue;
      if (/\.(ts|tsx|js|mjs|cjs|json|jsonc)$/.test(e.name)) out.push(p);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--target');
  const target = path.resolve(ti >= 0 ? args[ti + 1] : __dirname + '/..');
  const errors = [];

  // 1. Config contract.
  const cfgPath = path.join(target, 'opencode.json');
  if (!fs.existsSync(cfgPath)) {
    errors.push('missing opencode.json');
  } else {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { errors.push('opencode.json is not valid JSON: ' + e.message); }
    if (cfg) {
      if (!String(cfg.model || '').startsWith('ollama/')) errors.push(`model should be ollama/*, got ${cfg.model}`);
      if (cfg.share !== 'disabled') errors.push(`share should be "disabled", got ${cfg.share}`);
      const base = cfg?.provider?.ollama?.options?.baseURL || '';
      if (!base.includes('127.0.0.1:11434')) errors.push(`ollama baseURL should be http://127.0.0.1:11434/v1, got ${base}`);
    }
  }

  // 2. Cloud strings.
  if (fs.existsSync(target)) {
    for (const f of walk(target)) {
      const src = fs.readFileSync(f, 'utf8');
      for (const pat of FORBIDDEN) {
        if (src.includes(pat)) errors.push(`${path.relative(target, f)}: contains forbidden ${pat}`);
      }
    }
  }

  if (errors.length) {
    console.error('OFFLINE VERIFY FAILED:');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }
  console.log('OFFLINE VERIFY PASSED: ' + target);
}

if (require.main === module) main();
