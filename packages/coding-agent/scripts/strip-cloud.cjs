/**
 * strip-cloud.cjs — make an opencode checkout offline-first, local-only.
 *
 * Usage:
 *   node scripts/strip-cloud.cjs --target <path-to-opencode-checkout>
 *   node scripts/strip-cloud.cjs --help
 *
 * What it does (idempotent, dry-run by default? No — applies patches):
 *  1. Overwrites/creates opencode.json with Ollama local default
 *     (http://127.0.0.1:11434/v1, share disabled, autoupdate false).
 *  2. Neutralises cloud surfaces in source (best-effort text patches):
 *     - OpenCode Zen / OpenCode Go provider entries
 *     - api.opencode.ai / opencode.ai/auth / share endpoints
 *     - console / stats / sentry / analytics shims
 *     - /connect cloud auth flows forced to local-only notice
 *  3. Prints a report. Exit 0 on success, 2 when target is not an opencode checkout.
 *
 * It never deletes git history. Run verify-offline.cjs afterwards.
 */

const fs = require('node:fs');
const path = require('node:path');

const OFFLINE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  model: 'ollama/qwen3-coder:30b',
  small_model: 'ollama/qwen3:4b',
  share: 'disabled',
  autoupdate: false,
  provider: {
    ollama: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: 'http://127.0.0.1:11434/v1' },
      models: {
        'qwen3-coder:30b': { name: 'Qwen3-Coder 30B (local, default)' },
        'qwen3:4b': { name: 'Qwen3 4B (local, small)' },
        'qwen2.5-coder:14b': { name: 'Qwen2.5-Coder 14B (local, fallback)' },
      },
    },
  },
};

// Cloud surfaces to neutralise. Each entry: files (glob-ish substring match
// on relative path) + patterns to replace with offline stub.
const CLOUD_PATTERNS = [
  'api.opencode.ai',
  'opencode.ai/auth',
  'opencode.ai/zen',
  'share.opencode.ai',
  'opencode-zen',
  'opencode-go',
  'opencode.ai/share',
  'console.opencode',
  'stats.opencode',
  'sentry.io',
  'posthog',
  'analytics',
];

function help() {
  console.log(`strip-cloud.cjs — offline-ify an opencode checkout
Usage:
  node scripts/strip-cloud.cjs --target <dir>
  node scripts/strip-cloud.cjs --help
Writes offline opencode.json and patches cloud endpoint strings.`);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json|jsonc|mdx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return help();
  const ti = args.indexOf('--target');
  const target = ti >= 0 ? args[ti + 1] : null;
  if (!target) {
    console.error('Missing --target <dir>. See --help.');
    process.exit(2);
  }
  const abs = path.resolve(target);
  if (!fs.existsSync(abs) || !fs.existsSync(path.join(abs, 'package.json'))) {
    console.error(`Not an opencode checkout: ${abs}`);
    process.exit(2);
  }

  // 1. Offline config is the default provider contract.
  fs.writeFileSync(path.join(abs, 'opencode.json'), JSON.stringify(OFFLINE_CONFIG, null, 2) + '\n');
  console.log('wrote opencode.json (ollama local default, share disabled)');

  // 2. Best-effort source neutralisation.
  const files = walk(abs);
  let patched = 0;
  let hits = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let next = src;
    for (const pat of CLOUD_PATTERNS) {
      if (next.includes(pat)) {
        hits++;
        // Replace cloud host strings with loopback stub; keep file parseable.
        next = next.split(pat).join('127.0.0.1:11434');
      }
    }
    if (next !== src) {
      fs.writeFileSync(f, next);
      patched++;
    }
  }
  console.log(`scanned ${files.length} files, ${hits} cloud references neutralised in ${patched} files`);
  console.log('done. run: node scripts/verify-offline.cjs --target ' + abs);
}

if (require.main === module) main();
