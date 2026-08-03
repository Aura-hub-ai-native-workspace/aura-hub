/**
 * Module Summarizer
 * ==================================================================
 * Generates summaries for the repository, its modules, files, and
 * key functions during indexing. Summaries are retrieved before raw source.
 *
 * All summaries are derived from real file contents — nothing is invented.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS, LANG_BY_EXT } from './constants';
import type { ModuleSummary, RepositorySummary } from './types';

const SUMMARY_FILE = (projectId: string) => homePath('summaries', `${projectId}.json`);

/* ── Module summary generation ───────────────────────────────────── */

function summarizeModule(
  root: string,
  modulePath: string,
  moduleName: string,
): ModuleSummary | null {
  const absPath = path.join(root, modulePath);
  if (!fs.existsSync(absPath)) return null;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(absPath, { withFileTypes: true }); } catch { return null; }

  const files: string[] = [];
  const subDirs: string[] = [];
  const langCounts = new Map<string, number>();

  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    if (e.isDirectory()) {
      subDirs.push(e.name);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (lang) {
      files.push(e.name);
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
  }

  if (files.length === 0 && subDirs.length === 0) return null;

  const primaryLang = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  // Extract capabilities from exports, classes, functions
  const capabilities = extractCapabilities(absPath, files);

  // Key files: largest, or with "index", "main", "mod" in name
  const keyFiles = files
    .filter(f => /index|main|mod|lib|core/i.test(f) || f === files.sort((a, b) => {
      try { return fs.statSync(path.join(absPath, b)).size - fs.statSync(path.join(absPath, a)).size; } catch { return 0; }
    })[0])
    .slice(0, 5);

  return {
    name: moduleName,
    path: modulePath,
    description: buildModuleDescription(moduleName, capabilities, files.length, primaryLang),
    capabilities,
    fileCount: files.length,
    primaryLanguage: primaryLang,
    keyFiles,
    dependencies: [],
    childModules: subDirs,
  };
}

function extractCapabilities(absPath: string, files: string[]): string[] {
  const capabilities = new Set<string>();
  let samples = 0;

  for (const f of files.slice(0, 10)) {
    if (samples >= 50) break;
    const full = path.join(absPath, f);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
      if (content.length > 100000) content = content.slice(0, 100000);
    } catch { continue; }
    samples++;

    // Extract exported functions/classes
    const exports = content.match(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g);
    if (exports) {
      for (const e of exports.slice(0, 10)) {
        const name = e.replace(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+/, '');
        if (name.length > 2 && name.length < 40) capabilities.add(name);
      }
    }

    // Extract class names
    const classes = content.match(/class\s+(\w+)/g);
    if (classes) {
      for (const c of classes.slice(0, 5)) {
        const name = c.replace(/class\s+/, '');
        if (name.length > 2 && name.length < 40) capabilities.add(name);
      }
    }
  }

  return [...capabilities].slice(0, 15);
}

function buildModuleDescription(name: string, capabilities: string[], fileCount: number, lang: string): string {
  const parts: string[] = [];
  parts.push(`${name} module (${lang}, ${fileCount} files)`);
  if (capabilities.length > 0) {
    parts.push(`Key components: ${capabilities.slice(0, 6).join(', ')}`);
  }
  return parts.join('. ');
}

/* ── Repository summary generation ───────────────────────────────── */

export function generateRepositorySummary(
  projectId: string,
  root: string,
  identity?: { name: string; purpose: string; mainModules: string[] },
): RepositorySummary {
  const modules: ModuleSummary[] = [];

  // Summarize top-level directories
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { entries = []; }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    const summary = summarizeModule(root, e.name, e.name);
    if (summary) modules.push(summary);
  }

  // Also summarize src/ subdirectories
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
        const modPath = `src/${e.name}`;
        const summary = summarizeModule(root, modPath, e.name);
        if (summary && !modules.some(m => m.name === e.name)) modules.push(summary);
      }
    } catch { /* ignore */ }
  }

  // Count total files
  let totalFiles = 0;
  const countStack: string[] = [root];
  while (countStack.length) {
    const dir = countStack.pop()!;
    let dirEntries: fs.Dirent[];
    try { dirEntries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of dirEntries) {
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) countStack.push(path.join(dir, e.name)); }
      else totalFiles++;
    }
  }

  const summary: RepositorySummary = {
    projectName: identity?.name ?? path.basename(root),
    purpose: identity?.purpose ?? '',
    modules,
    totalFiles,
    generatedAt: new Date().toISOString(),
  };

  writeJsonFile(SUMMARY_FILE(projectId), summary);
  return summary;
}

export function loadRepositorySummary(projectId: string): RepositorySummary | null {
  return readJsonFile<RepositorySummary | null>(SUMMARY_FILE(projectId), null);
}
