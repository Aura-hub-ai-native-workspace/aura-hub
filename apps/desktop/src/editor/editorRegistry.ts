/**
 * Active Monaco editor registry.
 * ------------------------------------------------------------------
 * AuraBug (and any future editor-adjacent feature) needs to read the
 * *live* model and drive navigation (setPosition / reveal / decorations)
 * without reaching into <MonacoEditor>'s private refs. The app keeps a
 * single center editor instance; switching tabs swaps the model, not the
 * editor, so one registered instance stays valid across file changes.
 *
 * This deliberately lives beside `editorStore.ts` as a tiny module-level
 * singleton instead of zustand state — a live editor instance in the
 * store would re-render subscribers for no reason.
 */
import type { editor as MonacoEditorNS } from 'monaco-editor';

let activeEditor: MonacoEditorNS.IStandaloneCodeEditor | null = null;

/** The currently mounted center editor instance, or null. */
export function getActiveEditor(): MonacoEditorNS.IStandaloneCodeEditor | null {
  return activeEditor;
}

/** Called by <MonacoEditor> on mount (and with null on unmount). */
export function registerActiveEditor(editor: MonacoEditorNS.IStandaloneCodeEditor | null): void {
  activeEditor = editor;
}
