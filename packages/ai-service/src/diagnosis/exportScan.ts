/**
 * exportScan — a real, textual export scan shared by Dead Code, Broken
 * API, and the Patch Limiter's exports-removed check.
 * ==================================================================
 * Deliberately regex-based, not `ts.createProgram` — this only needs
 * "what names does this file export," which is cheap and reliable to
 * get textually and must run on both original and hypothetically-
 * patched text (which may not even parse yet).
 */

const NAMED_EXPORT = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^\s*export\s*\{([^}]+)\}/gm;
const EXPORT_DEFAULT_BARE = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;/gm;

/** Every name this file's text exports, found textually. */
export function scanExports(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NAMED_EXPORT)) out.add(m[1]);
  for (const m of text.matchAll(EXPORT_DEFAULT_BARE)) out.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/);
      out.add(asMatch ? asMatch[2] : piece.split(/\s+/)[0]);
    }
  }
  return out;
}

const IMPORT_LINE = /^\s*import\s+.+from\s+['"](.+?)['"]/gm;
const IMPORT_NAMED = /^\s*import\s*\{([^}]+)\}\s*from\s*['"](.+?)['"]/gm;
const IMPORT_DEFAULT = /^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](.+?)['"]/gm;

/** Every `import ... from '<specifier>'` statement's raw specifier. */
export function scanImportSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_LINE)) out.push(m[1]);
  return out;
}

/** Count of top-level `import` statement lines — used by the Patch Limiter's importsRemovedCount. */
export function countImportLines(text: string): number {
  return scanImportSpecifiers(text).length;
}

export interface ImportedName {
  name: string;
  specifier: string;
}

/** Every named/default import binding, paired with the specifier it came from. */
export function scanImportedNames(text: string): ImportedName[] {
  const out: ImportedName[] = [];
  for (const m of text.matchAll(IMPORT_NAMED)) {
    const specifier = m[2];
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/);
      out.push({ name: asMatch ? asMatch[1] : piece.split(/\s+/)[0].replace(/^type\s+/, ''), specifier });
    }
  }
  for (const m of text.matchAll(IMPORT_DEFAULT)) {
    out.push({ name: m[1], specifier: m[2] });
  }
  return out;
}
