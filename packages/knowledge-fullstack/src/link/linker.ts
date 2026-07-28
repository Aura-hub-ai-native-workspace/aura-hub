/**
 * RelationLinker — turns entities into a cross-layer graph.
 * ==================================================================
 * This is where "understanding" happens: it connects frontend API usage
 * to backend endpoints, endpoints to controllers, controllers to
 * services, services to repositories/models, models to tables, tables to
 * tables (FKs), code to env vars and dependencies, and architecture docs
 * to the code they describe.
 *
 * Relations are a PURE FUNCTION of the entity set, so re-linking after an
 * incremental update always yields a consistent graph. No AI, no I/O.
 */

import path from 'node:path';
import type { Entity, EntityKind, Relation, RelationKind } from '../types';

function normPath(p: string): string {
  return (
    '/' +
    p
      .split('/')
      .filter(Boolean)
      .map((seg) => (/^[:{<$]|\$\{|^\d+$/.test(seg) ? '*' : seg.toLowerCase()))
      .join('/')
  );
}

export class RelationLinker {
  link(entities: Entity[]): Relation[] {
    const rels: Relation[] = [];
    const seen = new Set<string>();
    const add = (from: string, to: string, kind: RelationKind, confidence: number, evidence?: string, relPath?: string) => {
      if (from === to) return;
      const id = `${from}|${kind}|${to}`;
      if (seen.has(id)) return;
      seen.add(id);
      rels.push({ id, from, to, kind, confidence, evidence, relPath });
    };

    // Indexes
    const byKind = (k: EntityKind) => entities.filter((e) => e.kind === k);
    const byClassName = new Map<string, Entity>();
    const byComponentName = new Map<string, Entity>();
    const byHookName = new Map<string, Entity>();
    const tableByName = new Map<string, Entity>();
    const modelByName = new Map<string, Entity>();
    const envByName = new Map<string, Entity[]>();
    const depByName = new Map<string, Entity[]>();

    for (const e of entities) {
      if (['controller', 'service', 'repository', 'auth-guard'].includes(e.kind)) byClassName.set(((e.metadata.className as string) ?? e.name), e);
      if (['component', 'page', 'layout'].includes(e.kind)) byComponentName.set(e.name, e);
      if (e.kind === 'hook') byHookName.set(e.name, e);
      if (e.kind === 'table') tableByName.set(e.name.toLowerCase(), e);
      if (e.kind === 'orm-model') modelByName.set(e.name, e);
      if (e.kind === 'env-var') (envByName.get(e.name) ?? envByName.set(e.name, []).get(e.name)!).push(e);
      if (e.kind === 'dependency') (depByName.get(e.name) ?? depByName.set(e.name, []).get(e.name)!).push(e);
    }

    // Endpoint index (by normalized path, and method+path).
    const endpoints = byKind('endpoint');
    const endpointByPath = new Map<string, Entity[]>();
    for (const ep of endpoints) {
      const np = normPath((ep.metadata.path as string) ?? ep.name);
      (endpointByPath.get(np) ?? endpointByPath.set(np, []).get(np)!).push(ep);
    }

    // Nearest dependency for a monorepo (closest ancestor manifest).
    const nearestDep = (name: string, fromPath: string): Entity | undefined => {
      const cands = depByName.get(name);
      if (!cands) return undefined;
      let best: Entity | undefined;
      let bestLen = -1;
      for (const d of cands) {
        const dir = path.dirname((d.metadata.manifest as string) ?? d.relPath);
        const prefix = dir === '.' ? '' : dir + '/';
        if ((prefix === '' || fromPath.startsWith(prefix)) && prefix.length > bestLen) {
          best = d;
          bestLen = prefix.length;
        }
      }
      return best ?? cands[0];
    };

    for (const e of entities) {
      const meta = e.metadata;

      // Frontend API usage → endpoint.
      if (Array.isArray(meta.apiCalls)) {
        for (const call of meta.apiCalls as { method: string; path: string }[]) {
          const np = normPath(call.path);
          const matches = endpointByPath.get(np) ?? [];
          for (const ep of matches) {
            const methodMatch = (ep.metadata.method as string) === call.method;
            add(e.id, ep.id, 'calls-endpoint', methodMatch ? 0.92 : 0.72, `${call.method} ${call.path}`, e.relPath);
          }
        }
      }

      // Renders / imports (page/layout → component; component → component).
      if (Array.isArray(meta.renders)) {
        for (const tag of meta.renders as string[]) {
          const target = byComponentName.get(tag);
          if (target && target.id !== e.id) add(e.id, target.id, e.kind === 'component' ? 'imports' : 'renders', 0.7, `<${tag}>`, e.relPath);
        }
      }
      // Custom hooks.
      if (Array.isArray(meta.hooks)) {
        for (const h of meta.hooks as string[]) {
          const target = byHookName.get(h);
          if (target) add(e.id, target.id, 'uses-hook', 0.75, h, e.relPath);
        }
      }
      // Route → target component.
      if (e.kind === 'route' && typeof meta.target === 'string') {
        const target = byComponentName.get(meta.target);
        if (target) add(e.id, target.id, 'defines-route', 0.8, meta.target, e.relPath);
      }

      // Controller/service → service/repository/model via referenced class names.
      if (['controller', 'service', 'repository'].includes(e.kind) && Array.isArray(meta.refs)) {
        for (const ref of meta.refs as string[]) {
          const target = byClassName.get(ref) ?? modelByName.get(ref);
          if (!target) continue;
          if (target.kind === 'service') add(e.id, target.id, 'uses-service', 0.8, ref, e.relPath);
          else if (target.kind === 'repository') add(e.id, target.id, 'uses-repository', 0.8, ref, e.relPath);
          else if (target.kind === 'orm-model') add(e.id, target.id, 'uses-repository', 0.7, ref, e.relPath);
        }
      }
      // Repository → model by naming (UserRepository → User).
      if (e.kind === 'repository') {
        const modelName = e.name.replace(/(Repository|Repo)$/,'');
        const model = modelByName.get(modelName);
        if (model) add(e.id, model.id, 'uses-repository', 0.7, `${e.name}→${modelName}`, e.relPath);
      }

      // Endpoint → controller in same file; endpoint → guard when secured.
      if (e.kind === 'endpoint') {
        for (const c of entities) {
          if (c.kind === 'controller' && c.relPath === e.relPath) add(e.id, c.id, 'handles', 0.8, 'same-file', e.relPath);
          if (meta.secured && c.kind === 'auth-guard' && (c.relPath === e.relPath || true)) add(e.id, c.id, 'secured-by', c.relPath === e.relPath ? 0.8 : 0.4, 'secured', e.relPath);
        }
      }

      // Model → table.
      if (e.kind === 'orm-model' && typeof meta.tableName === 'string') {
        const table = tableByName.get((meta.tableName as string).toLowerCase());
        if (table) add(e.id, table.id, 'maps-to-table', 0.9, meta.tableName as string, e.relPath);
      }
      // Table → table via foreign keys.
      if (e.kind === 'table' && Array.isArray(meta.foreignKeys)) {
        for (const fk of meta.foreignKeys as { column: string; refTable: string }[]) {
          const target = tableByName.get(fk.refTable.toLowerCase());
          if (target) add(e.id, target.id, 'foreign-key', 0.9, `${fk.column}→${fk.refTable}`, e.relPath);
        }
      }
      // Migration → tables.
      if (e.kind === 'migration' && Array.isArray(meta.tables)) {
        for (const t of meta.tables as string[]) {
          const target = tableByName.get(t.toLowerCase());
          if (target) add(e.id, target.id, 'migrates', 0.85, t, e.relPath);
        }
      }

      // Env references → env-var.
      if (Array.isArray(meta.envRefs)) {
        for (const name of meta.envRefs as string[]) {
          for (const ev of envByName.get(name) ?? []) add(e.id, ev.id, 'configures', 0.7, name, e.relPath);
        }
      }
      if (e.kind === 'dockerfile' && Array.isArray(meta.env)) {
        for (const name of meta.env as string[]) for (const ev of envByName.get(name) ?? []) add(e.id, ev.id, 'configures', 0.7, name, e.relPath);
      }

      // Code → dependency (nearest manifest in a monorepo).
      if (Array.isArray(meta.externalImports)) {
        for (const spec of meta.externalImports as string[]) {
          const dep = nearestDep(spec, e.relPath);
          if (dep) add(e.id, dep.id, 'depends-on', 0.6, spec, e.relPath);
        }
      }

      // Compose service dependencies.
      if (e.kind === 'compose-service' && Array.isArray(meta.dependsOn)) {
        for (const dep of meta.dependsOn as string[]) {
          const target = entities.find((x) => x.kind === 'compose-service' && x.name === dep);
          if (target) add(e.id, target.id, 'runs-in', 0.8, dep, e.relPath);
        }
      }

      // Architecture module → code it describes; and its declared dependencies.
      if (e.kind === 'arch-module') {
        const target = byClassName.get(e.name) ?? byComponentName.get(e.name) ?? modelByName.get(e.name);
        if (target) add(e.id, target.id, 'documents', 0.7, 'named', e.relPath);
        for (const dep of (meta.dependencies as string[]) ?? []) {
          const t = byClassName.get(dep) ?? modelByName.get(dep);
          if (t) add(e.id, t.id, 'depends-on', 0.6, dep, e.relPath);
        }
      }
    }

    return rels;
  }
}
