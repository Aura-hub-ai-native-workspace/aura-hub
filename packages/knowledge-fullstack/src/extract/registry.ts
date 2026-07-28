/**
 * ExtractorRegistry — runs the applicable extractors for a file and
 * augments entities with cross-cutting env references. Extractors are
 * pluggable; add one here and it participates immediately.
 */

import { envRefs, LineMap, makeEntity, type Extractor, type SourceFile } from './extractor';
import { FrontendExtractor } from './frontend';
import { BackendExtractor } from './backend';
import { DatabaseExtractor } from './database';
import { ConfigExtractor } from './config';
import { ArchitectureExtractor } from './architecture';
import type { Entity } from '../types';

export class ExtractorRegistry {
  private readonly extractors: Extractor[];
  constructor(extractors?: Extractor[]) {
    this.extractors =
      extractors ?? [new FrontendExtractor(), new BackendExtractor(), new DatabaseExtractor(), new ConfigExtractor(), new ArchitectureExtractor()];
  }

  /** Extract all entities for one real file. */
  run(file: SourceFile): Entity[] {
    const lines = new LineMap(file.text);
    const out: Entity[] = [];
    const seen = new Set<string>();

    for (const ex of this.extractors) {
      if (!ex.appliesTo(file)) continue;
      for (const e of ex.extract(file, lines)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }

    // Cross-cutting: environment variable references seen in this file.
    const refs = envRefs(file.text);
    if (refs.length) {
      for (const e of out) e.metadata.envRefs = refs;
      // Ensure referenced vars exist as nodes even if never declared in a .env.
      for (const name of refs) {
        const id = `env-var:${file.relPath}#${name}`;
        if (!seen.has(id) && !out.some((e) => e.kind === 'env-var' && e.name === name)) {
          seen.add(id);
          out.push(makeEntity({ kind: 'env-var', layer: 'config', name, file, line: 1, summary: `env ${name} (referenced)`, metadata: { referencedIn: file.relPath } }));
        }
      }
    }

    return out;
  }
}
