/**
 * Differential oracle for the Repository Intelligence generators.
 *
 * Runs the REAL generators from packages/ai-service/src/intelligence/
 * against a fixture project and an isolated AURA_HOME, and prints every
 * artifact they produce.
 *
 * AURA_HOME is set BEFORE the imports because several modules compute
 * their file paths at module-load time (`performance.ts`, `workspace.ts`,
 * `crossRepo.ts` all call `homePath(...)` at the top level).
 *
 * Usage: node scripts/run-ts.mjs <this file> <repo-root> <job.json>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repoRoot, jobFile] = process.argv;
if (!repoRoot || !jobFile) {
  console.error('usage: run-ts.mjs intelligence_oracle.ts <repo-root> <job.json>');
  process.exit(1);
}
const job = JSON.parse(readFileSync(jobFile, 'utf8'));
process.env.AURA_HOME = job.auraHome;

const src = (rel) => pathToFileURL(path.join(repoRoot, 'packages/ai-service/src', rel)).href;

const identity = await import(src('intelligence/identity.ts'));
const intent = await import(src('intelligence/repositoryIntent.ts'));
const summarizer = await import(src('intelligence/moduleSummarizer.ts'));
const docPriority = await import(src('intelligence/documentPriority.ts'));
const glossary = await import(src('intelligence/glossary.ts'));
const health = await import(src('intelligence/healthEngine.ts'));
const memory = await import(src('intelligence/repositoryMemory.ts'));
const architecture = await import(src('intelligence/architecture.ts'));
const verification = await import(src('intelligence/verification.ts'));
const personality = await import(src('intelligence/personality.ts'));
const validation = await import(src('intelligence/validation.ts'));
const versioning = await import(src('intelligence/versioning.ts'));
const workspace = await import(src('intelligence/workspace.ts'));
const crossRepo = await import(src('intelligence/crossRepo.ts'));
const agentApis = await import(src('intelligence/agentApis.ts'));
const performance = await import(src('intelligence/performance.ts'));
const changeIntel = await import(src('intelligence/changeIntelligence.ts'));
const assembler = await import(src('intelligence/contextAssembler.ts'));
const confidence = await import(src('intelligence/confidence.ts'));

const root = job.root;
const out = {};

/**
 * Run one section, recording a throw rather than losing every later
 * section to it. `buildGlossary` genuinely throws on some real trees
 * (it interpolates term names into `new RegExp` unescaped), and that
 * fact is part of what the differential has to compare.
 */
const section = (name, fn) => {
  try {
    return (out[name] = fn());
  } catch (e) {
    return (out[name] = { __error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` });
  }
};

/* ── identity ──────────────────────────────────────────────────────── */
const id = identity.generateIdentity(job.projectId, root, job.profile);
out.identity = id;
out.identityNeedsRegeneration = identity.identityNeedsRegeneration(job.projectId, root);
identity.saveIdentity(id);
out.identityAfterSave = identity.identityNeedsRegeneration(job.projectId, root);

/* ── intent ────────────────────────────────────────────────────────── */
out.intents = (job.queries ?? []).map((q) => intent.classifyRepositoryIntent(q));

/* ── module summary ────────────────────────────────────────────────── */
out.summary = summarizer.generateRepositorySummary(job.projectId, root, {
  name: id.name, purpose: id.purpose, mainModules: id.mainModules,
});

/* ── document priority ─────────────────────────────────────────────── */
out.docs = {};
for (const t of job.intentTypes ?? ['project_overview']) {
  out.docs[t] = docPriority.prioritizeDocuments(root, t, job.importantFiles ?? []);
}

/* ── glossary / health / profile ───────────────────────────────────── */
section('glossary', () => glossary.buildGlossary(job.projectId, root));
section('health', () => health.generateRepositoryHealth(job.projectId, root, id, out.summary));
section('profile', () => memory.buildRepositoryProfile(job.projectId, root));

/* ── architecture ──────────────────────────────────────────────────── */
section('architecture', () => ({
  hierarchy: architecture.buildModuleHierarchy(root),
  dependencies: architecture.buildDependencyGraph(root),
  entryPoints: architecture.detectEntryPoints(root, id),
  apiSurface: architecture.mapApiSurface(root),
  usages: architecture.findUsages(root, job.symbol ?? 'export'),
}));

/* ── verification / personality / validation ───────────────────────── */
const okOr = (v) => (v && v.__error ? null : v);
section('verification', () => verification.generateVerificationReport(
  job.projectId, root, id, out.summary, okOr(out.health), okOr(out.profile), okOr(out.glossary)));
section('personality', () => personality.detectPersonality(
  job.projectId, root, id, okOr(out.profile), okOr(out.glossary)));
section('validation', () => validation.validateArchitecture(root, id, okOr(out.profile)));

/* ── versioning ────────────────────────────────────────────────────── */
out.hash = (job.hashInputs ?? []).map((s) => versioning.generateArtifactHash(s));
versioning.createVersion(job.projectId, { understanding: 'h1' }, { fileCount: 3, totalTokens: 0, lastIndexed: 'T' });
versioning.createVersion(job.projectId, { understanding: 'h2', extra: 'e' }, { fileCount: 4, totalTokens: 0, lastIndexed: 'T' });
out.versionStats = versioning.getVersionStats(job.projectId);
out.currentVersion = versioning.getCurrentVersion(job.projectId);
out.compareVersions = versioning.compareVersions(job.projectId, 1, 2);
out.rollback = versioning.rollbackToVersion(job.projectId, 1);
out.afterRollback = versioning.getCurrentVersion(job.projectId);

/* ── workspace + cross-repo ────────────────────────────────────────── */
for (const r of job.workspaceRepos ?? []) workspace.upsertRepository(r.id, r.root, r.identity ?? null);
out.workspaceStats = workspace.getWorkspaceStats();
out.workspaceGraph = workspace.loadWorkspaceGraph();
out.crossDeps = out.workspaceGraph ? workspace.detectCrossRepoDependencies(out.workspaceGraph) : [];
out.findRepositories = workspace.findRepositories(job.repoCriteria ?? {});
out.repoDeps = workspace.getRepositoryDependencies(job.projectId);
out.group = workspace.createRepositoryGroup('g1', 'a group', (job.workspaceRepos ?? []).map((r) => r.id));
const cross = out.workspaceGraph ? crossRepo.buildCrossRepoGraph(out.workspaceGraph) : null;
out.crossGraph = cross;
out.crossStats = cross ? crossRepo.getGraphStats(cross) : null;
out.crossPath = cross && job.pathPair ? crossRepo.findPath(cross, job.pathPair[0], job.pathPair[1]) : null;
out.removeRepository = job.removeRepo ? workspace.removeRepository(job.removeRepo) : null;

/* ── agent APIs ────────────────────────────────────────────────────── */
out.agent = {
  info: agentApis.getProjectInfo({ projectId: job.projectId, root, identity: id, summary: out.summary, profile: out.profile, glossary: out.glossary }),
  tree: agentApis.getDirectoryTree(root),
  list: agentApis.listFiles(root, '.', { recursive: true }),
  search: agentApis.searchCode(root, job.searchPattern ?? 'export', { maxResults: 20 }),
  readFile: agentApis.readFile(root, job.readPath ?? 'README.md'),
  escape: agentApis.readFile(root, '../escape.txt'),
  exists: agentApis.fileExists(root, job.readPath ?? 'README.md'),
  fileInfo: agentApis.getFileInfo(root, job.readPath ?? 'README.md'),
  missingInfo: agentApis.getFileInfo(root, 'does-not-exist.txt'),
};

/* ── performance / change ──────────────────────────────────────────── */
out.detectChangesFresh = performance.detectChanges(root);
performance.updateIndexState(root);
out.hasChangesAfterUpdate = performance.hasChanges(root);
out.detectChangesAfterUpdate = performance.detectChanges(root);
const loader = new performance.LazyFileLoader(root, 2);
out.lazy = {
  first: loader.load(job.readPath ?? 'README.md'),
  missing: loader.load('nope.txt'),
  stats: loader.stats(),
};

if (job.changeLog) {
  const cl = job.changeLog;
  out.change = {
    report: changeIntel.generateChangeReport(cl),
    patterns: changeIntel.analyzeChangePatterns(cl),
    impact: changeIntel.calculateChangeImpact(cl),
    hotspots: changeIntel.detectHotspots(cl),
    velocity: changeIntel.getChangeVelocity(cl),
  };
}

/* ── context assembly ──────────────────────────────────────────────── */
section('assembled', () => (job.assembleQueries ?? []).map((q) => {
  const it = intent.classifyRepositoryIntent(q);
  return assembler.assembleContext({
    intent: it,
    identity: id,
    summary: out.summary,
    profile: okOr(out.profile),
    glossary: okOr(out.glossary),
    health: okOr(out.health),
    prioritizedDocs: out.docs[it.type] ?? [],
    codingContext: job.codingContext ?? '',
    graphContext: job.graphContext ?? '',
    memoryContext: job.memoryContext ?? '',
    retrievedFiles: job.retrievedFiles ?? [],
  });
}));

out.confidence = (job.claims ?? []).map((c) => confidence.evaluateConfidence(c, {
  identity: id, summary: out.summary, documentation: job.retrievedFiles ?? [], graphEntities: job.graphEntities ?? [],
}));

process.stdout.write(JSON.stringify(out));
