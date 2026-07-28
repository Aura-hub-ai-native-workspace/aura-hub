/**
 * FullStackSearch — cross-layer, graph-aware search.
 * ==================================================================
 * Answers system questions by combining keyword matching over entities
 * with relationship traversal:
 *   "Where is authentication implemented?"  (where-implemented)
 *   "Which frontend page calls this endpoint?" (callers-of)
 *   "Which database table stores users?"    (stores)
 *   "Show everything related to payments."  (related-to)
 *   "Find every dependency of OrderService."(dependencies-of)
 * Intent is inferred from phrasing (or forced via the query). Returns a
 * structured SystemAnswer with entity hits + relationship paths. No AI.
 */

import type { ProjectGraphStore } from './graph/graphStore';
import type { Entity, EntityHit, Relation, RelationKind, RelationPath, SystemAnswer, SystemQuery, QueryIntent } from './types';

const DEP_EDGES: RelationKind[] = ['uses-service', 'uses-repository', 'maps-to-table', 'depends-on', 'calls-endpoint', 'handles', 'foreign-key'];

export class FullStackSearch {
  constructor(private readonly store: ProjectGraphStore) {}

  private inferIntent(text: string): QueryIntent {
    const t = text.toLowerCase();
    if (/\bdepend(?:s|ency|encies)?\s+of\b|dependencies of|what does .* (use|depend)/.test(t)) return 'dependencies-of';
    if (/which .*(page|component|frontend|client).*(call|use)|who calls|callers? of|what calls/.test(t)) return 'callers-of';
    if (/which .*(table|database|db).*(store|hold|save)|where (is|are).*stored|table stores/.test(t)) return 'stores';
    if (/where (is|are).*(implement|defined|handled)|how is .* implement/.test(t)) return 'where-implemented';
    if (/everything|related to|connected to|show all|associated/.test(t)) return 'related-to';
    return 'keyword';
  }

  private keywordHits(text: string, k: number): EntityHit[] {
    return this.store
      .keywordSearch(text, k)
      .map((h) => {
        const entity = this.store.getEntity(h.chunkId);
        return entity ? { entity, score: h.score, reasons: h.reasons } : null;
      })
      .filter((x): x is EntityHit => x !== null);
  }

  private static readonly STOP = new Set(['where', 'is', 'are', 'the', 'implemented', 'implement', 'defined', 'how', 'which', 'find', 'show', 'every', 'everything', 'related', 'connected', 'associated', 'to', 'of', 'a', 'an', 'this', 'that', 'does', 'do', 'in', 'for', 'me', 'all', 'and', 'call', 'calls', 'called', 'stored', 'store', 'stores', 'depend', 'depends', 'dependency', 'dependencies', 'what', 'who', 'page', 'endpoint', 'table', 'database', 'frontend', 'backend']);

  private contentWords(text: string): string[] {
    return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !FullStackSearch.STOP.has(w)))];
  }

  /** Token scan across entities — bridges "authentication" ↔ "auth"/"AuthGuard". */
  private lexicalScan(words: string[]): EntityHit[] {
    if (words.length === 0) return [];
    const out: EntityHit[] = [];
    for (const e of this.store.allEntities()) {
      const tokens = new Set(
        (`${e.name} ${e.relPath} ${e.summary ?? ''}`.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3),
      );
      let score = 0;
      for (const w of words) {
        for (const t of tokens) {
          if (t === w) { score += 1; break; }
          if (w.includes(t) || t.includes(w)) { score += 0.6; break; }
        }
      }
      if (score > 0) out.push({ entity: e, score, reasons: ['lexical'] });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  private namesIn(text: string): string[] {
    const pascal = [...text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+)\b/g)].map((m) => m[1]);
    const quoted = [...text.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    return [...new Set([...pascal, ...quoted])];
  }

  private pathIn(text: string): string | undefined {
    return /(\/(?:api|v\d+)\/[A-Za-z0-9_\-/:${}.]*)/.exec(text)?.[1] ?? /(\/[A-Za-z][A-Za-z0-9_\-/]{2,})/.exec(text)?.[1];
  }

  private resolveSeeds(q: SystemQuery): Entity[] {
    const seeds = new Map<string, Entity>();
    for (const name of this.namesIn(q.text)) for (const e of this.store.entitiesByName(name)) seeds.set(e.id, e);
    if (seeds.size === 0) for (const h of this.keywordHits(q.text, 6)) seeds.set(h.entity.id, h.entity);
    if (seeds.size === 0) for (const h of this.lexicalScan(this.contentWords(q.text)).slice(0, 6)) seeds.set(h.entity.id, h.entity);
    return [...seeds.values()];
  }

  /** BFS over relations; returns reached entities/relations + a path per node. */
  private traverse(seedIds: string[], kinds: RelationKind[], dir: 'out' | 'in' | 'both', depth: number) {
    const visited = new Set<string>(seedIds);
    const relations = new Map<string, Relation>();
    const parent = new Map<string, { rel: Relation; from: string }>();
    let frontier = [...seedIds];

    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const out = dir !== 'in' ? this.store.outRelations(id).filter((r) => kinds.includes(r.kind)) : [];
        const inc = dir !== 'out' ? this.store.inRelations(id).filter((r) => kinds.includes(r.kind)) : [];
        for (const r of out) { relations.set(r.id, r); if (!visited.has(r.to)) { visited.add(r.to); parent.set(r.to, { rel: r, from: id }); next.push(r.to); } }
        for (const r of inc) { relations.set(r.id, r); if (!visited.has(r.from)) { visited.add(r.from); parent.set(r.from, { rel: r, from: id }); next.push(r.from); } }
      }
      frontier = next;
    }

    const pathTo = (id: string): RelationPath => {
      const ents: Entity[] = [];
      const rels: Relation[] = [];
      let cur: string | undefined = id;
      const guard = new Set<string>();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        const e = this.store.getEntity(cur);
        if (e) ents.unshift(e);
        const p = parent.get(cur);
        if (!p) break;
        rels.unshift(p.rel);
        cur = p.from;
      }
      return { entities: ents, relations: rels };
    };

    return { visited, relations: [...relations.values()], pathTo };
  }

  private related(entityId: string) {
    const out = this.store.outRelations(entityId).map((r) => ({ relation: r, entity: this.store.getEntity(r.to)! }));
    const inc = this.store.inRelations(entityId).map((r) => ({ relation: r, entity: this.store.getEntity(r.from)! }));
    return [...out, ...inc].filter((x) => x.entity);
  }

  answer(q: SystemQuery): SystemAnswer {
    const intent = q.intent ?? this.inferIntent(q.text);
    const limit = q.limit ?? 12;
    const depth = q.depth ?? (intent === 'dependencies-of' ? 4 : intent === 'related-to' ? 2 : 3);
    let hits: EntityHit[] = [];
    const paths: RelationPath[] = [];

    const applyFilters = (list: EntityHit[]) =>
      list.filter((h) => (!q.layers || q.layers.includes(h.entity.layer)) && (!q.kinds || q.kinds.includes(h.entity.kind)));

    if (intent === 'callers-of') {
      const p = this.pathIn(q.text);
      let endpoints: Entity[] = [];
      if (p) {
        const np = '/' + p.split('/').filter(Boolean).map((s) => (/^[:{<$]|^\d+$/.test(s) ? '*' : s.toLowerCase())).join('/');
        endpoints = this.store.allEntities().filter((e) => e.kind === 'endpoint' && '/' + String(e.metadata.path ?? e.name).split(/\s/).pop()!.split('/').filter(Boolean).map((s) => (/^[:{<$]|^\d+$/.test(s) ? '*' : s.toLowerCase())).join('/') === np);
      }
      if (endpoints.length === 0) endpoints = this.keywordHits(q.text, 6).map((h) => h.entity).filter((e) => e.kind === 'endpoint');
      for (const ep of endpoints) {
        for (const r of this.store.inRelations(ep.id).filter((x) => x.kind === 'calls-endpoint')) {
          const caller = this.store.getEntity(r.from);
          if (caller) { hits.push({ entity: caller, score: r.confidence, reasons: ['calls-endpoint'] }); paths.push({ entities: [caller, ep], relations: [r] }); }
        }
      }
      if (hits.length === 0 && endpoints[0]) hits.push({ entity: endpoints[0], score: 1, reasons: ['endpoint'] });
    } else if (intent === 'dependencies-of') {
      const seeds = this.resolveSeeds(q);
      const t = this.traverse(seeds.map((s) => s.id), DEP_EDGES, 'out', depth);
      hits = [...t.visited].map((id) => this.store.getEntity(id)).filter((e): e is Entity => !!e).map((e) => ({ entity: e, score: seeds.some((s) => s.id === e.id) ? 1 : 0.6, reasons: ['graph'] }));
      for (const id of t.visited) if (!seeds.some((s) => s.id === id)) { const path = t.pathTo(id); if (path.relations.length) paths.push(path); }
    } else if (intent === 'stores') {
      const words = this.contentWords(q.text);
      hits = this.keywordHits(q.text, limit * 2).filter((h) => ['table', 'orm-model'].includes(h.entity.kind));
      if (hits.length === 0) hits = this.lexicalScan(words).filter((h) => ['table', 'orm-model'].includes(h.entity.kind));
      if (hits.length === 0) hits = this.keywordHits(q.text, limit);
      for (const h of hits.slice(0, 4)) for (const r of [...this.store.inRelations(h.entity.id), ...this.store.outRelations(h.entity.id)]) {
        const other = this.store.getEntity(r.from === h.entity.id ? r.to : r.from);
        if (other) paths.push({ entities: [h.entity, other], relations: [r] });
      }
    } else if (intent === 'where-implemented') {
      const words = this.contentWords(q.text);
      const merged = new Map<string, EntityHit>();
      for (const h of [...this.keywordHits(q.text, limit * 2), ...this.lexicalScan(words)]) if (!merged.has(h.entity.id)) merged.set(h.entity.id, h);
      const IMPL = ['auth-guard', 'middleware', 'controller', 'service', 'endpoint', 'repository'];
      const all = [...merged.values()];
      hits = all.filter((h) => IMPL.includes(h.entity.kind) || words.some((w) => `${h.entity.name} ${h.entity.relPath}`.toLowerCase().includes(w)));
      if (hits.length === 0) hits = all;
      for (const h of hits.slice(0, 5)) for (const rel of this.related(h.entity.id).slice(0, 4)) paths.push({ entities: [h.entity, rel.entity], relations: [rel.relation] });
    } else {
      // keyword / related-to
      const seeds = this.resolveSeeds(q);
      const seedHits = seeds.map((e) => ({ entity: e, score: 1, reasons: ['name'] as string[] }));
      const kw = this.keywordHits(q.text, limit);
      const t = this.traverse(seeds.map((s) => s.id), ['renders', 'imports', 'calls-endpoint', 'handles', 'uses-service', 'uses-repository', 'maps-to-table', 'depends-on', 'configures', 'documents', 'foreign-key', 'migrates'], 'both', depth);
      const graphHits = [...t.visited].filter((id) => !seeds.some((s) => s.id === id)).map((id) => this.store.getEntity(id)).filter((e): e is Entity => !!e).map((e) => ({ entity: e, score: 0.5, reasons: ['graph'] as string[] }));
      const merged = new Map<string, EntityHit>();
      for (const h of [...seedHits, ...kw, ...graphHits]) if (!merged.has(h.entity.id)) merged.set(h.entity.id, h);
      hits = [...merged.values()];
      for (const id of t.visited) { const path = t.pathTo(id); if (path.relations.length) paths.push(path); }
    }

    hits = applyFilters(hits).sort((a, b) => b.score - a.score).slice(0, limit);
    const top = hits[0];
    return { query: q.text, intent, hits, paths: paths.slice(0, 12), related: top ? this.related(top.entity.id).slice(0, 12) : [] };
  }
}
