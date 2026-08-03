/**
 * universalSearch — search across every public surface of the
 * operating environment: files, symbols, knowledge, missions,
 * diagnoses, documentation, architecture and memory.
 * ------------------------------------------------------------------
 * Consumes only public APIs and existing stores — nothing is indexed or
 * modified. Results are grouped by scope and carry real navigation
 * actions (open a file, open a mission, open a diagnosis…).
 */
import type { IconName } from '@aura/ui';
import { useWorkspace } from '../data/useWorkspace';
import { useEditorStore, hasUnsavedWorkFor } from '../editor/editorStore';
import { useAppStore } from '@aura/core';
import { aiClient } from '../ai/aiClient';
import { missionClient, type MissionSummary } from '../ai/missionClient';
import { diagnosisClient, type DiagnosisSummary } from '../ai/diagnosisClient';
import { useLayoutStore, type SearchScope } from './layoutStore';

export interface SearchHit {
  id: string;
  scope: SearchScope;
  title: string;
  subtitle: string;
  icon: IconName;
  /** What running this hit does — navigation only, never mutates data. */
  action: () => void;
}

export interface SearchSection {
  scope: SearchScope;
  label: string;
  hits: SearchHit[];
}

const LIMIT = 12;
const qMatch = (query: string, ...fields: (string | null | undefined)[]): boolean => {
  const parts = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return parts.every((p) => hay.includes(p));
};

/**
 * Navigates to a project's shell, guarding against silently discarding
 * unsaved Code Workspace edits in whatever project is currently open —
 * same confirm convention as the project switcher, Home, and command
 * palette (see `hasUnsavedWorkFor` in editorStore.ts). Search results
 * that stay within the already-open project (files, symbols, knowledge,
 * documentation, architecture) pass straight through, since only a real
 * cross-project jump (missions/diagnoses/memory from another project) can
 * ever have unsaved work to lose.
 */
function openProjectShell(projectId: string): void {
  if (hasUnsavedWorkFor(projectId) && !window.confirm('You have unsaved changes in the current project\'s Code Workspace. Switch projects anyway?')) return;
  const app = useAppStore.getState();
  if (useAppStore.getState().activeProjectId !== projectId) app.openProject(projectId);
}

function openMission(projectId: string, missionId: string): void {
  useLayoutStore.getState().setFocused({ projectId, missionId });
  useLayoutStore.getState().openPanel('mission-detail');
  openProjectShell(projectId);
}

function openDiagnosis(projectId: string, id: string): void {
  useLayoutStore.getState().setFocused({ projectId, diagnosisId: id });
  useLayoutStore.getState().openPanel('diagnostics');
  openProjectShell(projectId);
}

async function searchFiles(query: string): Promise<SearchHit[]> {
  const editor = useEditorStore.getState();
  if (!editor.projectId || editor.desktopAvailable !== true || !editor.root) return [];
  const nodes = await editor.searchFiles(query);
  return nodes.slice(0, LIMIT).map((n) => ({
    id: `file:${n.path}`,
    scope: 'files' as const,
    title: n.name,
    subtitle: n.path,
    icon: 'file' as const,
    action: () => {
      const e = useEditorStore.getState();
      void e.openFile(n);
      const app = useAppStore.getState();
      app.openProject(editor.projectId ?? '');
      app.setProjectTab('code');
    },
  }));
}

function searchSymbols(query: string): SearchHit[] {
  const ws = useWorkspace.getState();
  const openId = ws.openId;
  const kg = ws.kg;
  if (!openId || !kg) return [];
  return kg.nodes
    .filter((n) => qMatch(query, n.label, n.relPath ?? '', n.detail ?? ''))
    .slice(0, LIMIT)
    .map((n) => ({
      id: `symbol:${n.id}`,
      scope: 'symbols' as const,
      title: n.label,
      subtitle: `${n.type}${n.relPath ? ` · ${n.relPath}${n.line != null ? `:${n.line}` : ''}` : ''}`,
      icon: 'code' as const,
      action: () => {
        const e = useEditorStore.getState();
        if (n.relPath) void e.openFile({ path: n.relPath, name: n.relPath.split('/').pop() ?? n.relPath });
        const app = useAppStore.getState();
        app.openProject(openId);
        app.setProjectTab('code');
      },
    }));
}

async function searchKnowledge(query: string): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  try {
    const res = await aiClient.retrieve(query);
    return res.entries.slice(0, LIMIT).map((e, i) => ({
      id: `knowledge:${e.source}:${i}`,
      scope: 'knowledge' as const,
      title: e.source.split('/').pop() ?? e.source,
      subtitle: `${e.source} · score ${Math.round(e.score * 100)}%`,
      icon: 'knowledge' as const,
      action: () => {
        const app = useAppStore.getState();
        const editor = useEditorStore.getState();
        const rel = e.source.replace(/\\/g, '/');
        if (editor.projectId) void editor.openFile({ path: rel, name: rel.split('/').pop() ?? rel });
        app.openProject(useWorkspace.getState().openId ?? '');
        app.setProjectTab('code');
      },
    }));
  } catch {
    return [];
  }
}

async function searchMissions(query: string): Promise<SearchHit[]> {
  const ws = useWorkspace.getState();
  const results: SearchHit[] = [];
  for (const project of ws.projects) {
    if (results.length >= LIMIT) break;
    let list: MissionSummary[] = [];
    try {
      const res = await missionClient.list(project.id);
      list = res.missions;
    } catch {
      continue;
    }
    for (const m of list) {
      if (results.length >= LIMIT) break;
      if (!qMatch(query, m.text, m.category, m.id)) continue;
      results.push({
        id: `mission:${m.id}`,
        scope: 'missions' as const,
        title: m.text,
        subtitle: `${project.name} · ${m.taskCount} tasks`,
        icon: 'deploy' as const,
        action: () => openMission(project.id, m.id),
      });
    }
  }
  return results;
}

async function searchDiagnoses(query: string): Promise<SearchHit[]> {
  const ws = useWorkspace.getState();
  const results: SearchHit[] = [];
  for (const project of ws.projects) {
    if (results.length >= LIMIT) break;
    let list: DiagnosisSummary[] = [];
    try {
      const res = await diagnosisClient.list(project.id);
      list = res.diagnoses;
    } catch {
      continue;
    }
    for (const d of list) {
      if (results.length >= LIMIT) break;
      if (!qMatch(query, d.filePath, d.category, d.id)) continue;
      results.push({
        id: `diagnosis:${d.id}`,
        scope: 'diagnoses' as const,
        title: d.filePath.split('/').pop() ?? d.filePath,
        subtitle: `${project.name} · ${d.category} · ${d.decision.status}`,
        icon: 'bug' as const,
        action: () => openDiagnosis(project.id, d.id),
      });
    }
  }
  return results;
}

function searchDocumentation(query: string): SearchHit[] {
  const ws = useWorkspace.getState();
  const hits: SearchHit[] = [];
  const openId = ws.openId;
  const profile = openId ? ws.profile : null;
  if (profile) {
    for (const doc of profile.architectureDocs.slice(0, LIMIT)) {
      if (!qMatch(query, doc.title, doc.relPath)) continue;
      hits.push({
        id: `doc:${doc.relPath}`,
        scope: 'documentation' as const,
        title: doc.title,
        subtitle: doc.relPath,
        icon: 'doc' as const,
        action: () => {
          const editor = useEditorStore.getState();
          if (editor.projectId) void editor.openFile({ path: doc.relPath, name: doc.title });
          const app = useAppStore.getState();
          app.openProject(openId ?? '');
          app.setProjectTab('code');
        },
      });
    }
  }
  if (ws.kg) {
    for (const n of ws.kg.nodes) {
      if (hits.length >= LIMIT) break;
      if (!/doc|readme|manual|guide/i.test(n.type)) continue;
      if (!qMatch(query, n.label, n.relPath ?? '')) continue;
      hits.push({
        id: `doc-node:${n.id}`,
        scope: 'documentation' as const,
        title: n.label,
        subtitle: n.relPath ?? n.type,
        icon: 'doc' as const,
        action: () => {
          if (!n.relPath) return;
          const editor = useEditorStore.getState();
          if (editor.projectId) void editor.openFile({ path: n.relPath, name: n.relPath.split('/').pop() ?? n.relPath });
          const app = useAppStore.getState();
          app.openProject(openId ?? '');
          app.setProjectTab('code');
        },
      });
    }
  }
  return hits.slice(0, LIMIT);
}

async function searchMemory(query: string): Promise<SearchHit[]> {
  const ws = useWorkspace.getState();
  const hits: SearchHit[] = [];
  for (const project of ws.projects) {
    if (hits.length >= LIMIT) break;
    let items: Awaited<ReturnType<typeof aiClient.listMemory>>['items'] = [];
    try {
      const res = await aiClient.listMemory(project.id);
      items = res.items;
    } catch {
      continue;
    }
    for (const m of items) {
      if (hits.length >= LIMIT) break;
      if (!qMatch(query, m.title, m.body, m.kind)) continue;
      hits.push({
        id: `memory:${m.id}`,
        scope: 'memory' as const,
        title: m.title,
        subtitle: `${project.name} · ${m.kind}`,
        icon: 'memory' as const,
        action: () => {
          useLayoutStore.getState().setFocused({ projectId: project.id });
          useLayoutStore.getState().openPanel('engineering-memory');
          openProjectShell(project.id);
        },
      });
    }
  }
  return hits;
}

function searchArchitecture(query: string): SearchHit[] {
  const ws = useWorkspace.getState();
  const hits: SearchHit[] = [];
  if (ws.kg) {
    for (const n of ws.kg.nodes) {
      if (hits.length >= LIMIT) break;
      if (!/group|layer|module|package/i.test(n.type) && !/group|layer/i.test(n.group)) continue;
      if (!qMatch(query, n.label, n.group, n.detail ?? '')) continue;
      hits.push({
        id: `arch:${n.id}`,
        scope: 'architecture' as const,
        title: n.label,
        subtitle: `${n.group} · ${n.type}`,
        icon: 'architecture' as const,
        action: () => {
          useLayoutStore.getState().openPanel('knowledge');
          openProjectShell(useWorkspace.getState().openId ?? '');
        },
      });
    }
  }
  if (ws.graph) {
    for (const e of ws.graph.entities) {
      if (hits.length >= LIMIT) break;
      if (!qMatch(query, e.name, e.layer, e.kind)) continue;
      hits.push({
        id: `arch-entity:${e.id}`,
        scope: 'architecture' as const,
        title: e.name,
        subtitle: `${e.layer} · ${e.kind}${e.relPath ? ` · ${e.relPath}` : ''}`,
        icon: 'architecture' as const,
        action: () => {
          const editor = useEditorStore.getState();
          if (editor.projectId && e.relPath) void editor.openFile({ path: e.relPath, name: e.relPath.split('/').pop() ?? e.relPath });
          const app = useAppStore.getState();
          app.openProject(useWorkspace.getState().openId ?? '');
          app.setProjectTab('code');
        },
      });
    }
  }
  return hits;
}

/**
 * Run a full workspace search. Each scope fails soft (returns []), so
 * one unavailable source never hides the others.
 */
export async function runSearch(query: string, scope: SearchScope | null): Promise<SearchSection[]> {
  const q = query.trim();
  const want = (s: SearchScope): boolean => !scope || scope === 'all' || scope === s;

  const [files, knowledge, missions, diagnoses, memory] = await Promise.all([
    want('files') ? searchFiles(q) : Promise.resolve([]),
    want('knowledge') ? searchKnowledge(q) : Promise.resolve([]),
    want('missions') ? searchMissions(q) : Promise.resolve([]),
    want('diagnoses') ? searchDiagnoses(q) : Promise.resolve([]),
    want('memory') ? searchMemory(q) : Promise.resolve([]),
  ]);
  const symbols = want('symbols') ? searchSymbols(q) : [];
  const documentation = want('documentation') ? searchDocumentation(q) : [];
  const architecture = want('architecture') ? searchArchitecture(q) : [];

  const sections: SearchSection[] = [];
  if (files.length) sections.push({ scope: 'files', label: 'Files', hits: files });
  if (symbols.length) sections.push({ scope: 'symbols', label: 'Symbols', hits: symbols });
  if (knowledge.length) sections.push({ scope: 'knowledge', label: 'Knowledge', hits: knowledge });
  if (missions.length) sections.push({ scope: 'missions', label: 'Missions', hits: missions });
  if (diagnoses.length) sections.push({ scope: 'diagnoses', label: 'Diagnoses', hits: diagnoses });
  if (documentation.length) sections.push({ scope: 'documentation', label: 'Documentation', hits: documentation });
  if (architecture.length) sections.push({ scope: 'architecture', label: 'Architecture', hits: architecture });
  if (memory.length) sections.push({ scope: 'memory', label: 'Memory', hits: memory });
  return sections;
}

export const SEARCH_SCOPE_META: Record<SearchScope, { label: string; icon: IconName }> = {
  all: { label: 'Everything', icon: 'search' },
  files: { label: 'Files', icon: 'file' },
  symbols: { label: 'Symbols', icon: 'code' },
  knowledge: { label: 'Knowledge', icon: 'knowledge' },
  missions: { label: 'Missions', icon: 'deploy' },
  diagnoses: { label: 'Diagnoses', icon: 'bug' },
  documentation: { label: 'Documentation', icon: 'doc' },
  memory: { label: 'Memory', icon: 'memory' },
  architecture: { label: 'Architecture', icon: 'architecture' },
};
