/**
 * Differential oracle for the Context Fabric.
 *
 * Runs the REAL `composeContextView` and `renderContextContract` from
 * packages/ai-service/src/context/ against a fixture AURA_HOME supplied
 * by the harness, and prints the composed view plus the contract text
 * rendered at every surface.
 *
 * The Capability Fabric is deliberately NOT attached here: this oracle
 * isolates composition and rendering, where fixtures can drive the
 * stale / unknown / budget-overflow paths a live service cannot easily
 * be made to produce. The fabric-backed sections (capabilities,
 * activity) are verified separately over real HTTP against both running
 * backends — see verify/context_runtime.py.
 *
 * Usage: node scripts/run-ts.mjs <this file> <repo-root> <job.json>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repoRoot, jobFile] = process.argv;
if (!repoRoot || !jobFile) {
  console.error('usage: run-ts.mjs context_oracle.ts <repo-root> <job.json>');
  process.exit(1);
}

const job = JSON.parse(readFileSync(jobFile, 'utf8'));
// Set BEFORE the imports below: the registry reads the config home in
// its constructor, and the artifact loaders read it at call time.
process.env.AURA_HOME = job.auraHome;

const src = (rel) => pathToFileURL(path.join(repoRoot, 'packages/ai-service/src', rel)).href;

const { composeContextView } = await import(src('context/compose.ts'));
const { renderContextContract, renderContextHeader, usableCapabilities } =
  await import(src('context/contract.ts'));
const { ProjectRegistry } = await import(src('projects.ts'));
const { MissionStore } = await import(src('mission/store.ts'));

const sources = {
  registry: new ProjectRegistry(),
  missions: new MissionStore(),
  mountedProjectId: job.mountedProjectId ?? null,
  fabric: null,
  environment: job.environment ?? null,
};

const options = { surface: job.surface ?? 'general' };
if (job.includeGit !== undefined) options.includeGit = job.includeGit;
if (job.missionLimit !== undefined) options.missionLimit = job.missionLimit;
if (job.activityLimit !== undefined) options.activityLimit = job.activityLimit;
if (job.git !== undefined) options.git = job.git;

const view = await composeContextView(job.projectId, sources, options);

const out = { view };
if (!('status' in view)) {
  out.contracts = {};
  for (const surface of job.surfaces ?? ['general']) {
    out.contracts[surface] = renderContextContract(view, { surface });
  }
  out.defaultContract = renderContextContract(view);
  out.header = renderContextHeader(view);
  out.usable = usableCapabilities(view);
}

process.stdout.write(JSON.stringify(out));
