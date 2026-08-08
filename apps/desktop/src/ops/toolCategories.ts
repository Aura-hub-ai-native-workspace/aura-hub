/**
 * toolCategories — groups PanelKind into the categorized Tools shelf.
 * ------------------------------------------------------------------
 * Pure grouping data only — label/icon/hint per kind still lives in
 * PANEL_META (layoutStore.ts), this file never duplicates it. A kind
 * absent from every category here simply doesn't appear in the Tools
 * shelf; it may still be a valid PanelKind elsewhere (e.g. mid-removal).
 *
 * 'overview', 'feed', 'memory' and 'notifications' are intentionally
 * absent — all four were retired from the workspace: the dashboard-style
 * overview and the feed/memory panels as redundant with richer panels
 * already in the shelf, and notifications because it's ambient chrome
 * (an unread badge in the top command bar) rather than a launchable tool
 * per the Windows & Tools design review.
 *
 * 'git' and 'automation' ship empty on purpose — no git-status panel and
 * no Automation Engine UI exist yet. An empty category is an honest
 * signal that the capability doesn't exist, not a bug to silently hide.
 */
import type { PanelKind } from './layoutStore';

export interface ToolCategory {
  id: string;
  label: string;
  kinds: PanelKind[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  { id: 'ai', label: 'AI', kinds: ['ai-chat', 'engineering-agent'] },
  { id: 'engineering', label: 'Engineering', kinds: ['missions', 'mission-detail', 'dashboard', 'twin', 'governance'] },
  { id: 'knowledge', label: 'Knowledge', kinds: ['knowledge', 'architecture', 'engineering-memory', 'engineering-learning', 'docs'] },
  { id: 'project', label: 'Project', kinds: ['files'] },
  { id: 'diagnostics', label: 'Diagnostics', kinds: ['diagnostics'] },
  { id: 'git', label: 'Git', kinds: [] },
  { id: 'automation', label: 'Automation', kinds: [] },
  { id: 'utilities', label: 'Utilities', kinds: ['search'] },
];
