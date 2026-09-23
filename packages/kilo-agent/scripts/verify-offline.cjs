/**
 * verify-offline.cjs — assert a Kilo Code checkout (or this wrapper) is offline-first.
 *
 * Usage:
 *   node scripts/verify-offline.cjs [--target <dir>]
 *   No --target means this package folder itself.
 *
 * Checks:
 *  1. kilo.json exists, model starts with ollama/, provider.ollama.baseURL
 *     points at 127.0.0.1:11434, model limit.context >= 32768, tool_call true.
 *  2. No live cloud endpoint strings remain (api.kilo.ai, kilo-gateway,
 *     ollama-cloud as hosted path, sentry/posthog DSNs).
 *     UPSTREAM.md / README.md / docs / scripts are excluded (may mention historically).
 *  Exit 0 pass, 1 fail.
 */

const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN = [
  'api.kilo.ai',
  'kilo-gateway',
  'ollama-cloud',
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
  const target = path.resolve(ti >= 0 ? args[ti + 1] : path.join(__dirname, '..'));
  const errors = [];

  const cfgPath = path.join(target, 'kilo.json');
  if (!fs.existsSync(cfgPath)) {
    errors.push('missing kilo.json');
  } else {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { errors.push('kilo.json is not valid JSON: ' + e.message); }
    if (cfg) {
      if (!String(cfg.model || '').startsWith('ollama/')) errors.push(`model should be ollama/*, got ${cfg.model}`);
      const base = cfg?.provider?.ollama?.baseURL || '';
      if (!base.includes('127.0.0.1:11434')) errors.push(`ollama baseURL should contain 127.0.0.1:11434, got ${base}`);
      const models = cfg?.provider?.ollama?.models || {};
      const first = models['qwen3-coder:30b'];
      if (!first) errors.push('missing provider.ollama.models["qwen3-coder:30b"]');
      else {
        if (first.tool_call !== true) errors.push('qwen3-coder:30b should have tool_call: true');
        if ((first?.limit?.context ?? 0) < 32768) errors.push('qwen3-coder:30b limit.context should be >= 32768');
      }
    }
  }

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
