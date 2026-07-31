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
