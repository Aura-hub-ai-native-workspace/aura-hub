/**
 * FrontendExtractor — pages, components, layouts, hooks, routes,
 * API usage and assets from real React/TS(X) sources.
 */

import {
  importSpecifiers,
  makeEntity,
  snippetAround,
  type Extractor,
  type LineMap,
  type SourceFile,
} from './extractor';
import type { Entity } from '../types';

const isFrontendFile = (f: SourceFile) =>
  ['tsx', 'jsx', 'typescript', 'javascript'].includes(f.language) &&
  !/\.(test|spec)\.[jt]sx?$/.test(f.name);

const PAGE_DIR = /(?:^|\/)(pages|screens|views|routes|app)\//i;

/** Extract API calls: method-qualified clients + bare '/api' | '/v1' literals. */
function apiCalls(text: string): { method: string; path: string }[] {
  const out = new Map<string, { method: string; path: string }>();
  const client = /\b(?:axios|api|http|client|request|\$fetch)\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)[`'"]/gi;
  let m: RegExpExecArray | null;
  while ((m = client.exec(text))) {
    const path = m[2];
    if (path.startsWith('/')) out.set(`${m[1].toUpperCase()} ${path}`, { method: m[1].toUpperCase(), path });
  }
  const fetchRe = /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]([^)]*)\)/g;
  while ((m = fetchRe.exec(text))) {
    const path = m[1];
    if (!path.startsWith('/')) continue;
    const method = /method\s*:\s*[`'"](\w+)[`'"]/i.exec(m[2])?.[1]?.toUpperCase() ?? 'GET';
    out.set(`${method} ${path}`, { method, path });
  }
  const bare = /[`'"]((?:\/api|\/v\d+)\/[A-Za-z0-9_\-/:${}.]+)[`'"]/g;
  while ((m = bare.exec(text))) {
    const path = m[1];
    if (![...out.values()].some((c) => c.path === path)) out.set(`GET ${path}`, { method: 'GET', path });
  }
  return [...out.values()];
}

export class FrontendExtractor implements Extractor {
  readonly id = 'frontend';
  appliesTo(f: SourceFile): boolean {
    return isFrontendFile(f);
  }

  extract(f: SourceFile, lines: LineMap): Entity[] {
    const text = f.text;
    const hasJsx = /<[A-Z][A-Za-z0-9]*[\s/>]/.test(text) || /\breturn\s*\(?\s*</.test(text);
    const entities: Entity[] = [];

    const { local, external } = importSpecifiers(text);
    const renders = [...new Set([...text.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]))].slice(0, 40);
    const hooksUsed = [...new Set([...text.matchAll(/\b(use[A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]))];
    const calls = apiCalls(text);
    const commonMeta = { imports: local, externalImports: external, renders, hooks: hooksUsed, apiCalls: calls };

    // Declared components / hooks / layouts.
    const declRe = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    const declared = new Set<string>();
    while ((m = declRe.exec(text))) {
      const name = m[1];
      if (declared.has(name)) continue;
      declared.add(name);
      const line = lines.lineAt(m.index);

      if (/^use[A-Z]/.test(name)) {
        entities.push(makeEntity({ kind: 'hook', layer: 'frontend', name, file: f, line, summary: `React hook ${name}`, snippet: snippetAround(f, line), metadata: { imports: local, externalImports: external } }));
        continue;
      }
      if (!/^[A-Z]/.test(name)) continue; // components are PascalCase
      if (!hasJsx) continue;

      const isLayout = /layout/i.test(name) || /(?:^|\/)layouts?\//i.test(f.relPath);
      const isPage = PAGE_DIR.test(f.relPath) || /(?:Page|Screen|View|Route)$/.test(name);
      const kind = isLayout ? 'layout' : isPage ? 'page' : 'component';
      entities.push(
        makeEntity({
          kind, layer: 'frontend', name, file: f, line,
          summary: `${kind} ${name}`, snippet: snippetAround(f, line), metadata: commonMeta,
        }),
      );
    }

    // Route declarations (React Router / config arrays).
    const routeRe = /(?:<Route\s[^>]*\bpath=|[{,]\s*path\s*:)\s*[`'"]([^`'"]+)[`'"]/g;
    const seenRoutes = new Set<string>();
    while ((m = routeRe.exec(text))) {
      const routePath = m[1];
      if (seenRoutes.has(routePath)) continue;
      seenRoutes.add(routePath);
      const after = text.slice(m.index, m.index + 260);
      const target = /element=\{?\s*<([A-Z][A-Za-z0-9]*)/.exec(after)?.[1] ?? /component[=:]\s*\{?\s*([A-Z][A-Za-z0-9]*)/.exec(after)?.[1];
      entities.push(
        makeEntity({
          kind: 'route', layer: 'frontend', name: routePath, file: f, line: lines.lineAt(m.index),
          summary: `Route ${routePath}${target ? ` → ${target}` : ''}`, snippet: snippetAround(f, lines.lineAt(m.index)),
          metadata: { path: routePath, target },
        }),
      );
    }

    // Asset imports.
    for (const m2 of text.matchAll(/\bfrom\s+['"]([^'"]+\.(?:png|jpe?g|svg|gif|webp|css|scss))['"]/g)) {
      const assetPath = m2[1];
      entities.push(
        makeEntity({ kind: 'asset', layer: 'frontend', name: assetPath, file: f, line: lines.lineAt(m2.index ?? 0), summary: `Asset ${assetPath}`, metadata: { assetPath } }),
      );
    }

    return entities;
  }
}
