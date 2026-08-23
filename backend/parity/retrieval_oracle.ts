/**
 * Retrieval oracle — the REAL TypeScript coding-knowledge engine.
 *
 * Indexes a real directory, runs real queries, and dumps everything
 * observable so the Python port can be diffed against it: tokenization,
 * language detection, chunk boundaries, index statistics, ranked search
 * hits and assembled context.
 *
 * `now` is injected so the recency boost is deterministic on both sides.
 *
 * Usage: node scripts/run-ts.mjs <this file> <repo-root> <project-root> <index-dir> <now-ms> <spec.json>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repoRoot, projectRoot, indexDir, nowMs, specPath] = process.argv;
if (!repoRoot || !projectRoot || !indexDir || !nowMs || !specPath) {
  console.error('usage: run-ts.mjs retrieval_oracle.ts <repo-root> <project-root> <index-dir> <now-ms> <spec.json>');
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

const { tokenize } = await load('packages/knowledge-coding/src/store/invertedIndex.ts');
const { detectLanguage, detectKind } = await load('packages/knowledge-coding/src/languages.ts');
const { chunkDocument } = await load('packages/knowledge-coding/src/chunker.ts');
const { CodingKnowledgeEngine } = await load('packages/knowledge-coding/src/engine.ts');

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const now = Number(nowMs);

const out = {};

// ── pure functions ────────────────────────────────────────────────
out.tokenize = spec.tokenizeCases.map((t) => ({ input: t, tokens: tokenize(t) }));
out.languages = spec.languageCases.map(([name, ext]) => {
  const language = detectLanguage(name, ext);
  return { name, ext, language, kind: detectKind(name, language) };
});

// ── chunking a synthetic document ─────────────────────────────────
out.chunks = spec.chunkCases.map((c) => {
  const doc = {
    id: c.id, absPath: '/x/' + c.id, relPath: c.id, projectRoot: '/x', name: c.id,
    ext: path.extname(c.id), language: 'typescript', kind: 'code', size: 0,
    checksum: '', modifiedMs: 0, indexedMs: 0, lines: 0, truncated: false,
    binary: false, metadata: {},
  };
  return {
    id: c.id,
    chunks: chunkDocument(doc, c.text).map((k) => ({
      id: k.id, ordinal: k.ordinal, startLine: k.startLine, endLine: k.endLine,
      startByte: k.startByte, endByte: k.endByte, tokenEstimate: k.tokenEstimate,
      symbols: k.symbols, textLength: k.text.length,
    })),
  };
});

// ── a real index over a real directory ────────────────────────────
const engine = new CodingKnowledgeEngine(projectRoot, { indexDir, now: () => now });
const stats = await engine.index();
out.index = {
  files: stats.files, chunks: stats.chunks, bytes: stats.bytes,
  binaries: stats.binaries, skipped: stats.skipped,
  byLanguage: stats.byLanguage,
  errorCount: stats.errors.length,
};
// Deliberately NOT sorted: the engine's own order comes from the walk,
// so comparing it unsorted tests directory traversal order too.
out.documents = engine.documents().map((d) => ({
  relPath: d.relPath, name: d.name, ext: d.ext, language: d.language,
  kind: d.kind, size: d.size, checksum: d.checksum, lines: d.lines,
  truncated: d.truncated, binary: d.binary,
}));

// ── ranked search ─────────────────────────────────────────────────
out.search = spec.queries.map((q) => ({
  query: q,
  hits: engine.search({ ...q }).map((h) => ({
    relPath: h.document.relPath,
    chunkId: h.chunk.id,
    score: h.score,
    matched: h.matchedTerms,
    reasons: h.reasons,
  })),
}));

// ── assembled context ─────────────────────────────────────────────
out.context = spec.contextQueries.map((q) => {
  const ctx = engine.getContext({ text: q.text, limit: q.limit }, q.options ?? {});
  return {
    query: q.text,
    totalTokens: ctx.totalTokens,
    truncated: ctx.truncated,
    entries: ctx.entries.map((e) => ({
      source: e.source, tokens: e.tokens, score: e.score,
      chunks: e.chunks.map((r) => ({ id: r.chunk.id, role: r.role })),
    })),
  };
});

// ── incremental re-index over an unchanged tree ───────────────────
const delta = await engine.update();
out.incremental = {
  added: delta.added, modified: delta.modified,
  deleted: delta.deleted, unchanged: delta.unchanged,
};

process.stdout.write(JSON.stringify(out, null, 2));
