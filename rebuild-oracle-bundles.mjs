// AGENT-1 utility: regenerate ALL TS oracle bundles into /tmp/opencode/tsref.
import { build } from '/home/Groot/aura-hub/node_modules/esbuild/lib/main.js';
import fs from 'node:fs';
const REPO = '/mnt/storage/aura-hub';
const OUT = '/tmp/opencode/tsref';
fs.mkdirSync(OUT, { recursive: true });
const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /src\/pipeline$/ }, () => ({ path: `${OUT}/stub-env.mjs` }));
  b.onResolve({ filter: /src\/secrets$/ }, () => ({ path: `${OUT}/stub-secrets.mjs` }));
  b.onResolve({ filter: /agent\/runner$/ }, () => ({ path: `${OUT}/stub-agentrunner.mjs` }));
  b.onResolve({ filter: /src\/environment$/ }, () => ({ path: `${OUT}/stub-env.mjs` }));
}};
const jobs = [
  ['packages/ai-service/src/workflow/dryrun.ts', 'dryrun.mjs', ['external:typescript']],
  ['packages/ai-service/src/workflow/engine.ts', 'wfengine.mjs', ['external:typescript']],
  ['packages/ai-service/src/fabric/index.ts', 'fabricwiring.mjs', []],
  ['packages/capability-fabric/src/index.ts', 'fabric-index.mjs', []],
  ['packages/capability-fabric/src/fabric.ts', 'fabric.mjs',
   [`alias:@aura/connected-environment=${OUT}/connidx.mjs`]],
  ['packages/ai-service/src/workflow/versions.ts', 'versions.mjs', ['external:typescript']],
  ['packages/ai-service/src/workflow/run/store.ts', 'runstore.mjs', []],
  ['packages/ai-service/src/workflow/store.ts', 'wfstore.mjs', []],
  ['packages/automation/src/store.ts', 'autostore.mjs', []],
  ['packages/automation/src/engine.ts', 'autoengine.mjs', []],
  ['packages/ai-service/src/secrets.ts', 'secrets.mjs', []],
];
for (const [entry, out] of jobs) {
  const opts = { entryPoints: [`${REPO}/${entry}`], bundle: true, platform: 'node',
    format: 'esm', outfile: `${OUT}/${out}`, logLevel: 'silent' };
  if (out === 'dryrun.mjs' || out === 'wfengine.mjs') opts.plugins = [stubs];
  const alias = {};
  for (const e of (jobs.find(j => j[1] === out)?.[2] ?? []).filter(x => x.startsWith('alias:'))) {
    const [, k, v] = e.match(/alias:(.+?)=(.+)/);
    alias[k] = v;
  }
  if (Object.keys(alias).length) opts.alias = alias;
  // connidx needed by fabric bundles
  await build(opts);
}
await build({ entryPoints: [`${REPO}/packages/connected-environment/src/index.ts`],
  bundle: true, platform: 'node', format: 'esm', external: ['typescript'],
  outfile: `${OUT}/connidx.mjs`, logLevel: 'silent' });
await build({ entryPoints: [`${REPO}/packages/ai-service/src/workflow/run/types.ts`],
  bundle: true, platform: 'node', format: 'esm', outfile: `${OUT}/runtypes.mjs`, logLevel: 'silent' });
console.log('ALL ORACLE BUNDLES REBUILT:', jobs.length + 3);
