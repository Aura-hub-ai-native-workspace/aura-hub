/**
 * Document Priority Engine
 * ==================================================================
 * Ranks documentation and source files by relevance to the user's intent.
 * Documentation outranks implementation for overview questions.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PrioritizedDocument, DocumentPriority, RepositoryIntentType } from './types';

/* ── Priority rankings by intent ─────────────────────────────────── */

const INTENT_DOC_PRIORITIES: Record<RepositoryIntentType, Record<string, DocumentPriority>> = {
  project_overview: {
    readme: 1, project: 2, vision: 3, architecture: 4, design: 5, module_summary: 6, graph: 7, source: 9, config: 8, test: 10,
  },
  architecture: {
    architecture: 1, design: 2, readme: 3, module_summary: 4, graph: 5, source: 7, project: 6, config: 8, test: 10, vision: 9,
  },
  module_explanation: {
    module_summary: 1, source: 2, architecture: 3, graph: 4, readme: 6, design: 5, config: 7, test: 8, project: 9, vision: 10,
  },
  function_explanation: {
    source: 1, module_summary: 2, graph: 3, architecture: 4, readme: 6, design: 5, config: 8, test: 7, project: 9, vision: 10,
  },
  bug_fix: {
    source: 1, test: 2, module_summary: 3, graph: 4, architecture: 5, readme: 7, design: 6, config: 8, project: 9, vision: 10,
  },
  debugging: {
    source: 1, graph: 2, module_summary: 3, architecture: 4, test: 5, readme: 7, design: 6, config: 8, project: 9, vision: 10,
  },
  refactoring: {
    source: 1, architecture: 2, module_summary: 3, design: 4, graph: 5, readme: 7, test: 6, config: 8, project: 9, vision: 10,
  },
  code_search: {
    source: 1, module_summary: 3, graph: 4, readme: 7, architecture: 5, design: 6, config: 8, test: 2, project: 9, vision: 10,
  },
  api_reference: {
    source: 1, module_summary: 2, readme: 3, architecture: 4, graph: 5, design: 6, config: 7, test: 8, project: 9, vision: 10,
  },
  dependency: {
    config: 1, source: 3, module_summary: 4, readme: 5, architecture: 6, graph: 7, design: 8, test: 9, project: 10, vision: 10,
  },
  build_system: {
    config: 1, readme: 2, source: 4, architecture: 5, module_summary: 6, graph: 7, design: 8, test: 3, project: 9, vision: 10,
  },
  documentation: {
    readme: 1, architecture: 2, design: 3, project: 4, vision: 5, module_summary: 6, source: 8, graph: 7, config: 9, test: 10,
  },
  design: {
    architecture: 1, design: 2, readme: 3, module_summary: 4, graph: 5, source: 7, project: 6, config: 8, test: 10, vision: 9,
  },
  security: {
    source: 1, config: 2, module_summary: 3, graph: 4, architecture: 5, readme: 7, design: 6, test: 8, project: 9, vision: 10,
  },
  performance: {
    source: 1, module_summary: 2, graph: 3, architecture: 4, readme: 7, design: 5, config: 8, test: 6, project: 9, vision: 10,
  },
  testing: {
    test: 1, source: 2, module_summary: 3, readme: 5, architecture: 4, graph: 6, design: 7, config: 8, project: 9, vision: 10,
  },
  unknown: {
    readme: 1, source: 3, module_summary: 4, architecture: 5, graph: 6, design: 7, config: 8, test: 2, project: 9, vision: 10,
  },
};

/* ── Document kind detection ─────────────────────────────────────── */

function detectDocKind(relPath: string, fileName: string): PrioritizedDocument['kind'] {
  const lower = fileName.toLowerCase();
  const dir = relPath.toLowerCase();

  if (lower === 'readme.md') return 'readme';
  if (lower.includes('project') && lower.endsWith('.md')) return 'project';
  if (lower.includes('vision') && lower.endsWith('.md')) return 'vision';
  if (lower.includes('architect') && lower.endsWith('.md')) return 'architecture';
  if (lower.includes('design') && lower.endsWith('.md')) return 'design';
  if (dir.startsWith('test') || dir.startsWith('__test') || /\.(test|spec)\.[jt]sx?$/.test(lower)) return 'test';
  if (/\.(json|yaml|yml|toml|ini|env)$/.test(lower)) return 'config';
  return 'source';
}

function detectDocTitle(content: string, fileName: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? fileName;
}

/* ── Public API ──────────────────────────────────────────────────── */

export function prioritizeDocuments(
  root: string,
  intentType: RepositoryIntentType,
  importantFiles: string[] = [],
  maxResults: number = 30,
): PrioritizedDocument[] {
  const priorities = INTENT_DOC_PRIORITIES[intentType] ?? INTENT_DOC_PRIORITIES.unknown;
  const docs: PrioritizedDocument[] = [];

  // Collect all documentable files
  const collectDocs = (dir: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === '.aura') continue;
      const full = path.join(dir, e.name);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        collectDocs(full, rel);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!['.md', '.mdx', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.c', '.cpp', '.h', '.java'].includes(ext)) continue;

      const kind = detectDocKind(rel, e.name);
      const priority = (priorities[kind] ?? 10) as DocumentPriority;
      let title = e.name;
      try { title = detectDocTitle(fs.readFileSync(full, 'utf8').slice(0, 5000), e.name); } catch { /* use filename */ }
      docs.push({ path: rel, priority, kind, title });
    }
  };

  collectDocs(root, '');

  // Sort by priority (lower = higher priority), then by path
  docs.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));

  // Add important files at high priority if not already present
  for (const f of importantFiles) {
    if (!docs.some(d => d.path === f)) {
      const kind = detectDocKind(f, path.basename(f));
      docs.unshift({ path: f, priority: Math.max(1, (priorities[kind] ?? 10) - 1) as DocumentPriority, kind, title: path.basename(f) });
    }
  }

  return docs.slice(0, maxResults);
}
