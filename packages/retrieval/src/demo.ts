/**
 * Demo — proves the retrieval + memory foundation runs end-to-end.
 * ==================================================================
 * Fully offline, no embeddings, no vector search, no provider. Exercises:
 *   • four independent engines + ingest
 *   • context assembly (dedupe, rank, budget) → one ContextPackage
 *   • the five-layer memory hierarchy (write / recall / promote)
 *   • replaceability (custom ranking provider, tiny budget, memory off)
 *
 * Run (with a TS runner):  runDemo()
 */

import { createRetrievalKernel, createDefaultMemory } from './config';
import type { RankingProvider } from './providers/rankingProvider';
import type { RetrievalDocument } from './types';

const DAY = 24 * 60 * 60 * 1000;

function seedDocs(now: number): RetrievalDocument[] {
  return [
    { id: 'code-1', domain: 'coding', category: 'architecture', title: 'Task Router', projectId: 'aurora', updatedAt: now - 1 * DAY,
      text: 'The task router maps a classified intent to a specialized engine using a rule table.\n\nEach engine declares the capabilities it requires. The router never knows which provider runs.' },
    { id: 'code-2', domain: 'coding', category: 'errors', title: 'Event queue race', projectId: 'aurora', updatedAt: now - 40 * DAY,
      text: 'Fixed a race condition in the event queue worker where the router could dispatch before the index was ready.' },
    { id: 'chat-1', domain: 'chat', category: 'conversations', title: 'Latency review', projectId: 'aurora', updatedAt: now - 2 * DAY,
      text: 'We discussed retrieval latency and how the router selects an engine per request. Action: add backpressure to the queue.' },
    { id: 'res-1', domain: 'research', category: 'papers', title: 'HNSW for ANN', updatedAt: now - 120 * DAY,
      text: 'HNSW enables approximate nearest neighbor search used by retrieval systems to find relevant documents quickly.' },
    { id: 'fs-1', domain: 'fullstack', category: 'deployment', title: 'Deploy pipeline', projectId: 'aurora', updatedAt: now - 3 * DAY,
      text: 'The deploy pipeline builds, tests and deploys the router service to staging, then promotes to production on approval.' },
    { id: 'fs-2', domain: 'fullstack', category: 'database', title: 'Schema', projectId: 'atlas', updatedAt: now - 10 * DAY,
      text: 'The database stores documents and their embeddings. The router service reads project structure from here.' },
  ];
}

export async function runDemo(): Promise<void> {
  const now = Date.now();
  const log = (...a: unknown[]) => console.log(...a); // eslint-disable-line no-console

  // 1) Default kernel — four engines + default memory.
  const kernel = createRetrievalKernel({ clock: () => now });
  const counts = await kernel.ingest(seedDocs(now));
  log('ingest (chunks per engine):', counts);
  log('describe:', JSON.stringify(kernel.describe().engines.map((e) => ({ id: e.id, size: e.size, priority: e.config.priority })), null, 0));

  // 2) Cross-domain retrieval → one ContextPackage.
  const pkg = await kernel.retrieve({ text: 'how does the router deploy', projectId: 'aurora', now });
  log(`\nretrieve "how does the router deploy" (project=aurora)`);
  log(`  items=${pkg.items.length} tokens=${pkg.totalTokens}/${pkg.budget.maxTokens} truncated=${pkg.truncated} byEngine=${JSON.stringify(pkg.byEngine)}`);
  pkg.items.slice(0, 5).forEach((i) => log(`   • [${i.sourceEngine}] ${i.title} (score ${i.score.toFixed(2)}, ${i.tokens}t${i.compressed ? ', compressed' : ''})`));

  // 3) Domain-restricted retrieval.
  const codeOnly = await kernel.retrieve({ text: 'router engine', domains: ['coding'], now });
  log(`\nretrieve domains=[coding] → ${codeOnly.items.length} items, engines=${JSON.stringify(codeOnly.byEngine)}`);

  // 4) Memory hierarchy — write across layers, recall with layer weighting.
  const mem = createDefaultMemory(() => now);
  await mem.remember({ kind: 'message', content: 'User asked how the router works', importance: 0.6, sessionId: 's1' });
  await mem.remember({ kind: 'decision', content: 'Adopt enter-only route transitions for the router', importance: 0.85, projectId: 'aurora' });
  await mem.remember({ kind: 'preference', content: 'Prefer concise answers' as string, importance: 0.5 });
  await mem.remember({ kind: 'fact', content: 'HNSW powers vector retrieval', importance: 0.7 });
  await mem.remember({ kind: 'summary', content: 'Project aims for sub-100ms router retrieval', importance: 0.6, projectId: 'aurora' }, 'persistent');
  log('\nmemory snapshot (per layer):', await mem.snapshot());
  const recalled = await mem.recall({ text: 'router retrieval' }, { now, limit: 4 });
  log('recall "router retrieval":');
  recalled.forEach((h) => log(`   • [${h.layer}] ${h.record.content} (score ${h.score.toFixed(2)})`));
  // promote a session message up to project memory
  const sessionMsg = (await mem.layer('session').all())[0];
  await mem.promote(sessionMsg.id, 'session', 'project');
  log('after promote(session→project):', await mem.snapshot());

  // 5) Retrieval WITH memory folded in.
  const withMem = createRetrievalKernel({ clock: () => now, memory: mem });
  await withMem.ingest(seedDocs(now));
  const pkg2 = await withMem.retrieve({ text: 'router retrieval decision', projectId: 'aurora', now });
  const memItems = pkg2.items.filter((i) => i.category === 'workspace-memory').length;
  log(`\nretrieve with memory → ${pkg2.items.length} items (${memItems} from memory)`);

  // 6) Replaceability — swap the ranking provider + shrink the budget.
  const recencyRanker: RankingProvider = {
    id: 'recency-only-ranker',
    rank: (results) => [...results].sort((a, b) => b.updatedAt - a.updatedAt),
  };
  const swapped = createRetrievalKernel({ clock: () => now, ranking: recencyRanker, globalBudget: { maxTokens: 80 } });
  await swapped.ingest(seedDocs(now));
  const tiny = await swapped.retrieve({ text: 'router deploy retrieval', now });
  log(`\nreplaced ranker + tiny 80t budget → items=${tiny.items.length} tokens=${tiny.totalTokens}/${tiny.budget.maxTokens} truncated=${tiny.truncated}`);

  // 7) Memory disabled.
  const noMem = createRetrievalKernel({ clock: () => now, memory: false });
  log('memory disabled kernel → hasMemory =', noMem.describe().hasMemory);

  log('\n=== RETRIEVAL DEMO OK ===');
}
