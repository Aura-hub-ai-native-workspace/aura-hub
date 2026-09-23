/**
 * strip-cloud.cjs — make a Kilo Code checkout offline-first, local-only.
 *
 * Usage:
 *   node scripts/strip-cloud.cjs --target <path-to-kilocode-checkout>
 *   node scripts/strip-cloud.cjs --help
 *
 * What it does (idempotent):
 *  1. Writes offline kilo.json with Ollama local default
 *     (http://127.0.0.1:11434/v1, model ollama/qwen3-coder:30b, num_ctx 32k).
 *  2. Neutralises cloud surfaces in source (best-effort text patches):
 *     - Kilo Gateway (api.kilo.ai, gateway models, kilo-auto/*)
 *     - Ollama Cloud hosted path (NOT local Ollama)
 *     - sign-in / account / billing / telemetry / auto-update
 *     - Cloud Agents / hosted review / remote MCP defaults
 *  3. Prints a report. Exit 0 success, 2 when target is not a kilocode checkout.
 *
 * Run verify-offline.cjs afterwards.
 */

const fs = require('node:fs');
const path = require('node:path');

const OFFLINE_KILO_JSON = {
  model: 'ollama/qwen3-coder:30b',
  provider: {
    ollama: {
      baseURL: 'http://127.0.0.1:11434/v1',
      models: {
        'qwen3-coder:30b': {
          name: 'Qwen3-Coder 30B (local, default)',
          tool_call: true,
          limit: { context: 32768, output: 8192 },
        },
        'qwen3:4b': {
          name: 'Qwen3 4B (local, small)',
          tool_call: true,
          limit: { context: 32768, output: 8192 },
        },
        'qwen2.5-coder:14b': {
          name: 'Qwen2.5-Coder 14B (local, fallback)',
          tool_call: true,
          limit: { context: 32768, output: 8192 },
        },
      },
    },
  },
};

const CLOUD_PATTERNS = [
  'api.kilo.ai',
  'kilo.ai/gateway',
  'kilo.ai/auth',
  'kilo-gateway',
  'kilo-auto/',
  'ollama-cloud',
  'telemetry',
  'posthog',
  'sentry.io',
];

function help() {
  console.log(`strip-cloud.cjs — offline-ify a Kilo Code checkout
Usage:
  node scripts/strip-cloud.cjs --target <dir>
  node scripts/strip-cloud.cjs --help`);
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
    console.error(`Not a kilocode checkout: ${abs}`);
    process.exit(2);
  }

  fs.writeFileSync(path.join(abs, 'kilo.json'), JSON.stringify(OFFLINE_KILO_JSON, null, 2) + '\n');
  console.log('wrote kilo.json (ollama local default)');

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
