/**
 * Differential oracle for the FullStack Knowledge Engine.
 *
 * Runs the REAL @aura/knowledge-fullstack over a fixture workspace and
 * prints the graph it builds plus the answers it gives.
 *
 * `now` is injected so `durationMs`, `updatedMs` and `assembledAt` are
 * deterministic on both sides — every other value is derived from the
 * files and is compared exactly.
 *
 * Usage: node scripts/run-ts.mjs <this file> <repo-root> <job.json>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repoRoot, jobFile] = process.argv;
const job = JSON.parse(readFileSync(jobFile, 'utf8'));

const pkg = (rel) => pathToFileURL(path.join(repoRoot, 'packages', rel)).href;
const { FullStackKnowledgeEngine } = await import(pkg('knowledge-fullstack/src/engine.ts'));
const { ExtractorRegistry } = await import(pkg('knowledge-fullstack/src/extract/registry.ts'));
const { RelationLinker } = await import(pkg('knowledge-fullstack/src/link/linker.ts'));
const extractorMod = await import(pkg('knowledge-fullstack/src/extract/extractor.ts'));

// A fixed clock: the reference stamps three fields from Date.now().
let tick = 1000;
const now = () => (tick += 1000);

const engine = new FullStackKnowledgeEngine(job.root, { indexDir: job.indexDir, now });
const out = {};

out.analyze = await engine.analyze();
out.stats = engine.stats();

const graph = engine.graph();
out.entities = graph.entities;
out.relations = graph.relations;

out.update = await engine.update();

out.answers = {};
out.packages = {};
for (const q of job.queries ?? []) {
  const answer = engine.search(typeof q === 'string' ? { text: q } : q);
  const key = typeof q === 'string' ? q : JSON.stringify(q);
  out.answers[key] = answer;
  out.packages[key] = engine.toContextPackage(answer, job.maxTokens ?? 6000);
}

// The extraction primitives, exercised directly.
out.importSpecifiers = (job.importTexts ?? []).map((t) => extractorMod.importSpecifiers(t));
out.envRefs = (job.envTexts ?? []).map((t) => extractorMod.envRefs(t));
out.lineMap = (job.lineMapTexts ?? []).map((t) => {
  const lm = new extractorMod.LineMap(t);
  return Array.from({ length: t.length + 1 }, (_, i) => lm.lineAt(i));
});

// The registry and linker over a synthetic file set, so extraction is
// compared independently of the scanner.
out.registry = (job.registryFiles ?? []).map((f) => new ExtractorRegistry().run(f));
out.link = new RelationLinker().link(out.registry.flat());

process.stdout.write(JSON.stringify(out));
