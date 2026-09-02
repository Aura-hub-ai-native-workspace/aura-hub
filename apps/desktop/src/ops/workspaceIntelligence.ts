/**
 * workspaceIntelligence — pure policy data for how windows relate to each
 * other, kept out of layoutStore.ts's action logic the same way
 * toolCategories.ts already keeps the Tools shelf's grouping data
 * separate from the store. Nothing here talks to an AI service — every
 * "smart" behavior in the Workspace (placement bias, suggestions,
 * templates) is a deterministic lookup against this data, not a model
 * call, per the Workspace V3 scope decision.
 */
import type { PanelKind } from './layoutStore';

/**
 * Tools that naturally belong near each other. Read both ways (if A lists
 * B, opening B while A is open should still bias toward A) — every pairing
 * here is symmetric on purpose, so `relatedKinds()` doesn't need a second
 * table. Only pairs between kinds that actually exist today; the brief's
 * "AI Chat ↳ Diff Preview" example has no real target (no diff-window kind
 * exists, and building one was explicitly ruled out in an earlier pass) so
 * it's omitted rather than invented.
 */
const RELATIONS: [PanelKind, PanelKind][] = [
  ['missions', 'mission-detail'],
  ['knowledge', 'architecture'],
  ['search', 'files'],
];

export function relatedKinds(kind: PanelKind): PanelKind[] {
  const out: PanelKind[] = [];
  for (const [a, b] of RELATIONS) {
    if (a === kind) out.push(b);
    else if (b === kind) out.push(a);
  }
  return out;
}

export interface WorkspaceTemplate {
  id: string;
  label: string;
  icon: string;
  hint: string;
  kinds: PanelKind[];
}

/** Optional, curated starting layouts — never applied automatically. */
export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  { id: 'ai-development', label: 'AI Development', icon: 'spark', hint: 'Help Chat Assistant + Files + Diagnostics', kinds: ['ai-chat', 'files', 'diagnostics'] },
  { id: 'architecture-review', label: 'Architecture Review', icon: 'architecture', hint: 'Architecture + Knowledge', kinds: ['architecture', 'knowledge'] },
  { id: 'debugging', label: 'Debugging', icon: 'bug', hint: 'Diagnostics + Files + Memory', kinds: ['diagnostics', 'files', 'engineering-memory'] },
  { id: 'documentation', label: 'Documentation', icon: 'doc', hint: 'Docs + Knowledge', kinds: ['docs', 'knowledge'] },
  { id: 'project-analysis', label: 'Project Analysis', icon: 'activity', hint: 'Dashboard + Learning + Twin', kinds: ['dashboard', 'engineering-learning', 'twin'] },
  { id: 'code-review', label: 'Code Review', icon: 'clipboard', hint: 'Files + Diagnostics + Agent', kinds: ['files', 'diagnostics', 'engineering-agent'] },
];
