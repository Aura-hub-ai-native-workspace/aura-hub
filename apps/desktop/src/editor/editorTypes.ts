/**
 * AURA Code Workspace — Editor Domain Types
 * ------------------------------------------------------------------
 * Mirrors the intent of @aura/core's types.ts: describe the editor's
 * *state shape*, not any language intelligence. AI editing, diffing,
 * and workflow hooks land later without touching these shapes.
 */

export interface CursorPosition {
  line: number;
  column: number;
}

export interface EditorSelection {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** A single open tab. Keyed by its project-relative posix path. */
export interface OpenFile {
  path: string;
  name: string;
  language: string;
  content: string;
  originalContent: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  /** Set when saveFile() fails — distinct from `error` (a load failure), which replaces the editor pane entirely. */
  saveError: string | null;
  cursor: CursorPosition;
  selection: EditorSelection | null;
}

/** One entry returned by a directory listing (not yet a tree — see FileTree.tsx for flattening). */
export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
}

export type ExplorerView = 'explorer' | 'search' | 'bookmarks' | 'git' | 'knowledge';

export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'tasks';

/**
 * Same line-range replace as the backend's `patchLimiter.ts#splicePatch` —
 * kept in sync manually since client and server never share code.
 */
export function splicePatch(originalText: string, range: { startLine: number; endLine: number }, newText: string): string {
  const lines = originalText.split('\n');
  const before = lines.slice(0, range.startLine - 1);
  const after = lines.slice(range.endLine);
  return [...before, ...newText.split('\n'), ...after].join('\n');
}
