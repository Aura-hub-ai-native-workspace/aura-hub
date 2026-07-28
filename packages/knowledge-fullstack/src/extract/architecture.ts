/**
 * ArchitectureExtractor — turns architecture/design docs into structured
 * metadata: modules/services, their responsibilities, boundaries and
 * dependencies, plus the doc itself. Linker connects modules to code
 * entities by name.
 */

import { makeEntity, type Extractor, type LineMap, type SourceFile } from './extractor';
import type { Entity } from '../types';

const ARCH_DOC = /architecture|design|system|overview|adr/i;
const isMarkdown = (f: SourceFile) => f.language === 'markdown' || /\.mdx?$/.test(f.name);

export class ArchitectureExtractor implements Extractor {
  readonly id = 'architecture';
  appliesTo(f: SourceFile): boolean {
    return isMarkdown(f) && (ARCH_DOC.test(f.name) || ARCH_DOC.test(f.relPath) || /##+\s+(architecture|modules?|services?|components?)/i.test(f.text));
  }

  extract(f: SourceFile, lines: LineMap): Entity[] {
    const text = f.text;
    const entities: Entity[] = [];
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? f.name;
    const headings = [...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1].trim());

    entities.push(makeEntity({ kind: 'doc', layer: 'architecture', name: title, file: f, line: 1, summary: `Architecture doc ${title}`, snippet: text.slice(0, 400), metadata: { headings } }));

    // Sections that look like modules/services become arch-module entities.
    const sectionRe = /^#{2,4}\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    const sections: { name: string; index: number }[] = [];
    while ((m = sectionRe.exec(text))) sections.push({ name: m[1].trim(), index: m.index });

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const body = text.slice(sec.index, sections[i + 1]?.index ?? text.length);
      // Heuristic: a section naming a module/service, or one that lists responsibilities/boundaries/deps.
      const looksModule = /\b(module|service|engine|layer|component|subsystem|package)\b/i.test(sec.name) ||
        /responsib|boundar|depend/i.test(body);
      const nameMatch = /\b([A-Z][A-Za-z0-9]+(?:Service|Engine|Module|Layer|Store|Kernel|Provider|Manager|Controller))\b/.exec(sec.name + ' ' + body);
      if (!looksModule && !nameMatch) continue;

      const modName = nameMatch?.[1] ?? sec.name.replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
      if (!modName) continue;
      const bullets = [...body.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((b) => b[1].trim());
      const responsibilities = bullets.filter((b) => /responsib|handles?|manages?|owns?|provides?/i.test(b)).slice(0, 6);
      const boundaries = bullets.filter((b) => /boundar|never|must not|only|isolat/i.test(b)).slice(0, 6);
      const dependencies = [...body.matchAll(/\b([A-Z][A-Za-z0-9]+(?:Service|Engine|Store|Provider|Kernel))\b/g)].map((d) => d[1]).filter((d) => d !== modName);

      entities.push(makeEntity({
        kind: 'arch-module', layer: 'architecture', name: modName, file: f, line: lines.lineAt(sec.index),
        summary: `Architecture: ${modName}`, snippet: body.slice(0, 400),
        metadata: { section: sec.name, responsibilities, boundaries, dependencies: [...new Set(dependencies)], sourceDoc: f.relPath },
      }));
    }

    return entities;
  }
}
