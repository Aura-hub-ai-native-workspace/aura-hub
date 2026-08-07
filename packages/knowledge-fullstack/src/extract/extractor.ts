/**
 * Extraction framework.
 * ==================================================================
 * A `SourceFile` (real file content) is passed to the extractors whose
 * `appliesTo` matches. Each returns typed `Entity`s with raw signals in
 * `metadata` that the linker later resolves into relationships.
 *
 * Analysis is real but dependency-free: line-scanning + robust regexes
 * over actual source (no AST library, no network, no model).
 */

import type { Entity, EntityKind, Layer } from '../types';

export interface SourceFile {
  relPath: string;
  absPath: string;
  name: string;
  ext: string;
  language: string;
  kind: string;
  text: string;
  size: number;
  checksum: string;
  modifiedMs: number;
}

/** Maps a character offset to a 1-based line number (binary search). */
export class LineMap {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  lineAt(index: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

export function entityId(kind: EntityKind, relPath: string, name: string): string {
  return `${kind}:${relPath}#${name}`;
}

interface EntitySpec {
  kind: EntityKind;
  layer: Layer;
  name: string;
  file: SourceFile;
  line?: number;
  summary?: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export function makeEntity(spec: EntitySpec): Entity {
  return {
    id: entityId(spec.kind, spec.file.relPath, spec.name),
    kind: spec.kind,
    layer: spec.layer,
    name: spec.name,
    relPath: spec.file.relPath,
    line: spec.line,
    language: spec.file.language,
    summary: spec.summary,
    snippet: spec.snippet,
    metadata: spec.metadata ?? {},
  };
}

/** Short snippet around a line for context/search. */
export function snippetAround(file: SourceFile, line: number, radius = 3): string {
  const lines = file.text.split('\n');
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).join('\n').slice(0, 600);
}

export interface Extractor {
  readonly id: string;
  appliesTo(file: SourceFile): boolean;
  extract(file: SourceFile, lines: LineMap): Entity[];
}

/* ── shared regex helpers (used across extractors) ─────────────────── */

export function importSpecifiers(text: string): { local: string[]; external: string[] } {
  const local: string[] = [];
  const external: string[] = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~')) local.push(spec);
    else external.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
  return { local: [...new Set(local)], external: [...new Set(external)] };
}

export function envRefs(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z0-9_]+)/g,
    /process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g,
    /import\.meta\.env\.([A-Z0-9_]+)/g,
    /std::env::var\(\s*"([A-Z0-9_]+)"/g,
    /os\.environ(?:\.get)?\(?\s*['"]([A-Z0-9_]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.add(m[1]);
  }
  return [...out];
}
