/**
 * BackendExtractor — endpoints, controllers, services, repositories,
 * middleware, auth guards. Handles Express/Koa/Fastify-style routers,
 * NestJS decorators, and Flask/FastAPI decorators from real sources.
 */

import { importSpecifiers, makeEntity, snippetAround, type Extractor, type LineMap, type SourceFile } from './extractor';
import type { Entity } from '../types';

const isBackendCandidate = (f: SourceFile) =>
  ['typescript', 'javascript', 'python'].includes(f.language) && !/\.(test|spec)\.[jt]s$/.test(f.name);

/** Classes referenced by *Service / *Repository / *Model naming — linker fodder. */
function referencedClasses(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Service|Repository|Repo|Model|Store|Dao))\b/g)) out.add(m[1]);
  return [...out];
}

const versionOf = (p: string): string | undefined => /\/(v\d+)\b/i.exec(p)?.[1]?.toLowerCase();

export class BackendExtractor implements Extractor {
  readonly id = 'backend';
  appliesTo(f: SourceFile): boolean {
    return isBackendCandidate(f);
  }

  extract(f: SourceFile, lines: LineMap): Entity[] {
    const text = f.text;
    const entities: Entity[] = [];
    const { external } = importSpecifiers(text);
    const refs = referencedClasses(text);
    const secured = /@UseGuards|passport|jwt|authenticate|requireAuth|isAuthenticated|ensureAuth/i.test(text);
    let m: RegExpExecArray | null;

    // ── Classes: controller / service / repository / guard ──
    const classRe = /(?:@(Controller|Injectable|Guard)\s*\(([^)]*)\)\s*)?\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
    let nestBase = '';
    while ((m = classRe.exec(text))) {
      const decorator = m[1];
      const decoratorArg = /['"]([^'"]+)['"]/.exec(m[2] ?? '')?.[1] ?? '';
      const cname = m[3];
      const line = lines.lineAt(m.index);
      const isController = decorator === 'Controller' || /Controller$/.test(cname) || /\.controller\./.test(f.name);
      const isRepo = /Repository$|Repo$/.test(cname) || /\.repository\./.test(f.name);
      const isGuard = decorator === 'Guard' || /Guard$/.test(cname) || /\.guard\./.test(f.name);
      const isService = !isController && !isRepo && !isGuard && (/Service$/.test(cname) || decorator === 'Injectable' || /\.service\./.test(f.name));

      const meta = { className: cname, refs: refs.filter((r) => r !== cname), externalImports: external };
      if (isController) {
        nestBase = decoratorArg;
        entities.push(makeEntity({ kind: 'controller', layer: 'backend', name: cname, file: f, line, summary: `Controller ${cname}`, snippet: snippetAround(f, line), metadata: { ...meta, basePath: decoratorArg } }));
      } else if (isRepo) {
        entities.push(makeEntity({ kind: 'repository', layer: 'backend', name: cname, file: f, line, summary: `Repository ${cname}`, snippet: snippetAround(f, line), metadata: meta }));
      } else if (isGuard) {
        entities.push(makeEntity({ kind: 'auth-guard', layer: 'backend', name: cname, file: f, line, summary: `Auth guard ${cname}`, snippet: snippetAround(f, line), metadata: meta }));
      } else if (isService) {
        entities.push(makeEntity({ kind: 'service', layer: 'backend', name: cname, file: f, line, summary: `Service ${cname}`, snippet: snippetAround(f, line), metadata: meta }));
      }
    }

    // ── NestJS method decorators → endpoints (path = base + sub) ──
    const nestRe = /@(Get|Post|Put|Delete|Patch|Options|Head)\s*\(\s*(?:[`'"]([^`'"]*)[`'"])?\s*\)\s*(?:@[\w()'"/,\s.-]*)?\s*(?:public\s+|async\s+)*([A-Za-z_$][\w$]*)?/g;
    while ((m = nestRe.exec(text))) {
      const method = m[1].toUpperCase();
      const sub = m[2] ?? '';
      const path = ('/' + [nestBase, sub].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const line = lines.lineAt(m.index);
      entities.push(this.endpoint(f, line, method, path, { controller: nestBase, handler: m[3], secured }));
    }

    // ── Express/Koa/Fastify router calls → endpoints ──
    const exprRe = /\b(?:app|router|route|api|server|fastify)\.(get|post|put|delete|patch|options|head|all)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi;
    while ((m = exprRe.exec(text))) {
      const method = m[1].toUpperCase();
      const path = m[2];
      const line = lines.lineAt(m.index);
      const handler = /,\s*([A-Za-z_$][\w$.]*)\s*\)?\s*$/.exec(text.slice(m.index, m.index + 200))?.[1];
      entities.push(this.endpoint(f, line, method, path, { handler, secured: secured || /auth|guard|passport/i.test(text.slice(m.index, m.index + 200)) }));
    }

    // ── Flask/FastAPI decorators → endpoints ──
    const pyRe = /@(?:app|router|blueprint|bp)\.(get|post|put|delete|patch|route)\s*\(\s*[`'"]([^`'"]+)[`'"]([^)]*)\)/gi;
    while ((m = pyRe.exec(text))) {
      const path = m[2];
      const line = lines.lineAt(m.index);
      const method = m[1].toLowerCase() === 'route' ? (/methods\s*=\s*\[\s*['"](\w+)/i.exec(m[3])?.[1]?.toUpperCase() ?? 'GET') : m[1].toUpperCase();
      entities.push(this.endpoint(f, line, method, path, { secured }));
    }

    // ── Middleware registrations ──
    const mwRe = /\bapp\.use\s*\(\s*([A-Za-z_$][\w$.]*)\s*(?:\([^)]*\))?\s*\)/g;
    while ((m = mwRe.exec(text))) {
      const name = m[1];
      if (/^(express|cors|json|urlencoded|static)$/i.test(name)) continue;
      entities.push(makeEntity({ kind: 'middleware', layer: 'backend', name, file: f, line: lines.lineAt(m.index), summary: `Middleware ${name}`, metadata: {} }));
    }

    return entities;
  }

  private endpoint(f: SourceFile, line: number, method: string, path: string, extra: Record<string, unknown>): Entity {
    const name = `${method} ${path}`;
    return makeEntity({
      kind: 'endpoint', layer: 'backend', name, file: f, line,
      summary: `Endpoint ${name}`, snippet: snippetAround(f, line),
      metadata: { method, path, version: versionOf(path), ...extra },
    });
  }
}
