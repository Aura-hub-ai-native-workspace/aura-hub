/**
 * @aura/knowledge-fullstack — System Vocabulary
 * ==================================================================
 * Where the Coding engine models *files and chunks*, the FullStack
 * engine models a *system*: typed entities across every layer and the
 * relationships between them. Entities are the source of truth; the
 * relationship graph is derived from them by the linker.
 *
 * Reuses @aura/retrieval for the ContextPackage bridge. No mock shapes —
 * every entity is extracted from a real file.
 */

export type Layer =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'config'
  | 'infra'
  | 'deployment'
  | 'docs'
  | 'architecture';

export type EntityKind =
  // frontend
  | 'page' | 'component' | 'layout' | 'hook' | 'route' | 'asset' | 'api-client' | 'state-store'
  // backend
  | 'endpoint' | 'controller' | 'service' | 'repository' | 'middleware' | 'auth-guard'
  // database
  | 'orm-model' | 'table' | 'migration'
  // config / infra / deploy
  | 'env-var' | 'dependency' | 'dockerfile' | 'compose-service' | 'ci-pipeline' | 'build-config'
  // docs / architecture
  | 'arch-module' | 'doc';

export type RelationKind =
  | 'renders'        // page → component
  | 'imports'        // module → module
  | 'uses-hook'      // component → hook
  | 'defines-route'  // route config → page/component
  | 'calls-endpoint' // frontend usage → endpoint
  | 'handles'        // endpoint → controller/handler
  | 'uses-service'   // controller → service
  | 'uses-repository'// service → repository/model
  | 'maps-to-table'  // model/repository → table
  | 'foreign-key'    // table → table
  | 'migrates'       // migration → table
  | 'configures'     // code → env-var
  | 'depends-on'     // module → dependency
  | 'documents'      // arch-module/doc → entity
  | 'secured-by'     // endpoint → auth-guard/middleware
  | 'runs-in';       // service → compose/deploy

export interface Entity {
  /** Stable id: `${kind}:${relPath}#${name}`. */
  id: string;
  kind: EntityKind;
  layer: Layer;
  name: string;
  relPath: string;
  line?: number;
  language?: string;
  /** One-line human description. */
  summary?: string;
  /** Source snippet for search + context. */
  snippet?: string;
  /** Raw extracted signals used by the linker (import specifiers, api paths…). */
  metadata: Record<string, unknown>;
}

export interface Relation {
  /** Stable id: `${from}|${kind}|${to}`. */
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  /** 0..1 — how sure the linker is about this edge. */
  confidence: number;
  evidence?: string;
  relPath?: string;
}

/* ── Graph shapes ──────────────────────────────────────────────────── */

export interface GraphStats {
  entities: number;
  relations: number;
  files: number;
  byKind: Record<string, number>;
  byLayer: Record<string, number>;
  byRelation: Record<string, number>;
}

export interface GraphDelta {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesUnchanged: number;
  entitiesBefore: number;
  entitiesAfter: number;
  relationsBefore: number;
  relationsAfter: number;
  durationMs: number;
  errors: { relPath: string; code: string; message: string }[];
}

export interface AnalyzeStats {
  files: number;
  entities: number;
  relations: number;
  bytes: number;
  skipped: number;
  errors: { relPath: string; code: string; message: string }[];
  durationMs: number;
  byKind: Record<string, number>;
  byLayer: Record<string, number>;
}

/* ── Search ────────────────────────────────────────────────────────── */

export type QueryIntent = 'keyword' | 'where-implemented' | 'callers-of' | 'stores' | 'related-to' | 'dependencies-of';

export interface SystemQuery {
  text: string;
  /** Force a specific interpretation; otherwise inferred from phrasing. */
  intent?: QueryIntent;
  layers?: Layer[];
  kinds?: EntityKind[];
  limit?: number;
  /** Graph traversal depth for relationship queries. */
  depth?: number;
}

export interface EntityHit {
  entity: Entity;
  score: number;
  reasons: string[];
}

/** A resolved relationship path (chain) between entities. */
export interface RelationPath {
  entities: Entity[];
  relations: Relation[];
}

export interface SystemAnswer {
  query: string;
  intent: QueryIntent;
  hits: EntityHit[];
  /** Cross-layer chains discovered for relationship queries. */
  paths: RelationPath[];
  /** Directly-related entities (1 hop) for the top hit. */
  related: { relation: Relation; entity: Entity }[];
}
