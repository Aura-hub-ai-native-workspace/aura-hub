/**
 * Project Glossary
 * ==================================================================
 * Automatically builds a glossary of project-specific terminology.
 * Every project has its own vocabulary — module names, acronyms,
 * technical terms, and domain concepts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS } from './constants';
import type { ProjectGlossary, GlossaryEntry } from './types';

const GLOSSARY_FILE = (projectId: string) => homePath('glossary', `${projectId}.json`);

/* ── Term extraction ─────────────────────────────────────────────── */

/** Detect acronyms (2-5 uppercase letters) used in code/comments. */
function extractAcronyms(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Match standalone acronyms (not at word start if followed by lowercase)
  const matches = content.match(/\b[A-Z]{2,5}\b/g);
  if (matches) {
    for (const m of matches) {
      // Skip common non-project acronyms
      if (['JSON', 'HTML', 'CSS', 'XML', 'SQL', 'API', 'URL', 'URI', 'HTTP', 'HTTPS', 'REST', 'AWS', 'GCP', 'DNS', 'TLS', 'SSL', 'JWT', 'EOF', 'OK', 'NaN', 'UTF'].includes(m)) continue;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  return counts;
}

/** Detect module/subsystem names from directory structure and imports. */
function extractModuleNames(root: string): Map<string, number> {
  const counts = new Map<string, number>();

  const scan = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
        const name = e.name;
        if (name.length >= 3 && name.length <= 30) {
          counts.set(name, (counts.get(name) ?? 0) + 3);
        }
        scan(path.join(dir, e.name), depth + 1);
      }
    }
  };

  scan(root, 0);
  return counts;
}

/** Extract terms from class/function/type names. */
function extractCodeTerms(content: string): Map<string, number> {
  const counts = new Map<string, number>();

  // PascalCase class/type names (likely domain terms)
  const pascal = content.match(/\b(?:class|type|interface|struct|enum)\s+([A-Z][a-zA-Z0-9]+)/g);
  if (pascal) {
    for (const m of pascal) {
      const name = m.replace(/(?:class|type|interface|struct|enum)\s+/, '');
      if (name.length >= 3 && name.length <= 30) counts.set(name, (counts.get(name) ?? 0) + 2);
    }
  }

  // snake_case constants (likely domain terms)
  const snake = content.match(/\b[A-Z]{2,}_[A-Z_]+\b/g);
  if (snake) {
    for (const m of snake) {
      if (m.length >= 5 && m.length <= 30) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }

  return counts;
}

/* ── Definition generation ───────────────────────────────────────── */

function guessDefinition(term: string, context: string): string {
  // Try to extract definition from nearby comments
  const commentPatterns = [
    new RegExp(`//\\s*(.+?)\\s*\\n.*\\b${term}\\b`, 'i'),
    new RegExp(`\\b${term}\\b.*//\\s*(.+?)\\s*$`, 'i'),
    new RegExp(`/\\*\\*?\\s*(.+?)\\s*\\*?.*\\b${term}\\b`, 'i'),
  ];

  for (const pattern of commentPatterns) {
    const match = context.match(pattern);
    if (match?.[1]) return match[1].trim().slice(0, 200);
  }

  // Guess from name structure
  if (/^[A-Z]{2,5}$/.test(term)) return `Acronym: ${term}`;
  if (/^[A-Z][a-z]+[A-Z]/.test(term)) return `Component: ${term}`;
  return term;
}

/* ── Public API ──────────────────────────────────────────────────── */

export function buildGlossary(projectId: string, root: string): ProjectGlossary {
  const acronymCounts = new Map<string, number>();
  const moduleCounts = extractModuleNames(root);
  const codeTermCounts = new Map<string, number>();
  const termContexts = new Map<string, string>(); // term → first file content snippet

  // Scan source files for terms
  let budget = 5000;
  const scanFile = (filePath: string) => {
    if (budget <= 0) return;
    budget--;
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    if (content.length > 100000) content = content.slice(0, 100000);
    const snippet = content.slice(0, 2000); // first 2k chars for context

    const acronyms = extractAcronyms(content);
    for (const [term, count] of acronyms) {
      acronymCounts.set(term, (acronymCounts.get(term) ?? 0) + count);
      if (!termContexts.has(term)) termContexts.set(term, snippet);
    }

    const codeTerms = extractCodeTerms(content);
    for (const [term, count] of codeTerms) {
      codeTermCounts.set(term, (codeTermCounts.get(term) ?? 0) + count);
      if (!termContexts.has(term)) termContexts.set(term, snippet);
    }
  };

  const scanDir = (dir: string) => {
    if (budget <= 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget <= 0) break;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scanDir(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h'].includes(ext)) {
        scanFile(full);
      }
    }
  };

  scanDir(root);

  // Build glossary entries from all extracted terms
  const entries: Record<string, GlossaryEntry> = {};
  const allTerms = new Map<string, number>();

  // Merge all term sources
  for (const [term, count] of moduleCounts) allTerms.set(term, (allTerms.get(term) ?? 0) + count);
  for (const [term, count] of acronymCounts) allTerms.set(term, (allTerms.get(term) ?? 0) + count);
  for (const [term, count] of codeTermCounts) allTerms.set(term, (allTerms.get(term) ?? 0) + count);

  // Sort by frequency and take top terms
  const sorted = [...allTerms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);

  for (const [term, _count] of sorted) {
    const domain = /^[A-Z]{2,5}$/.test(term) ? 'acronym'
      : /^[A-Z][a-z]+/.test(term) ? 'component'
      : 'module';
    entries[term] = {
      term,
      definition: guessDefinition(term, termContexts.get(term) ?? ''),
      domain,
      source: 'auto-extracted',
    };
  }

  const glossary: ProjectGlossary = {
    entries,
    generatedAt: new Date().toISOString(),
  };

  writeJsonFile(GLOSSARY_FILE(projectId), glossary);
  return glossary;
}

export function loadGlossary(projectId: string): ProjectGlossary | null {
  return readJsonFile<ProjectGlossary | null>(GLOSSARY_FILE(projectId), null);
}
