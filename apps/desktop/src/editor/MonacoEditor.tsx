import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { useAppStore } from '@aura/core';
import { ACTION_SPECS, type WorkspaceActionId } from './actionSpecs';
import { ensureMonacoConfigured } from './monacoSetup';
import { useEditorStore } from './editorStore';
import { registerActiveEditor } from './editorRegistry';

ensureMonacoConfigured();

/**
 * A single Monaco instance whose `path` prop switches between open
 * files. `@monaco-editor/react` keeps one underlying model per distinct
 * `path` internally — this is what gives every tab its own independent
 * undo/redo stack and scroll position for free when switching back,
 * without us mounting N editor instances (each ~heavy) at once.
 *
 * `value`/`language` are passed *controlled* (not default*) specifically
 * so a file's content — which arrives asynchronously from disk — can
 * populate the model correctly however early or late the fetch resolves.
 * With `defaultValue`, a model created before the fetch finished would
 * silently stay empty forever once the real content lands.
 */
export function MonacoEditor({
  path,
  onAction,
  onOpenPalette,
}: {
  path: string;
  onAction?: (id: WorkspaceActionId) => void;
  onOpenPalette?: () => void;
}) {
  const theme = useAppStore((s) => s.theme);
  const file = useEditorStore((s) => s.openFiles[path]);
  const updateContent = useEditorStore((s) => s.updateContent);
  const updateCursor = useEditorStore((s) => s.updateCursor);
  const updateSelection = useEditorStore((s) => s.updateSelection);
  const saveFile = useEditorStore((s) => s.saveFile);

  // Monaco's Ctrl+S command (and the AURA actions below) are bound once
  // per model mount; keep live refs so their closures never act on a
  // stale path or a stale onAction from an earlier render.
  const pathRef = useRef(path);
  pathRef.current = path;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const onOpenPaletteRef = useRef(onOpenPalette);
  onOpenPaletteRef.current = onOpenPalette;

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);

  // `automaticLayout: true` polls on an internal timer and isn't
  // reliable in every WebView engine when the container is resized by a
  // flexbox sibling (e.g. dragging the Explorer/AI panel splitters, or
  // the panel opening/closing) rather than the window itself. A direct
  // ResizeObserver -> editor.layout() call is the standard hardening for
  // this class of bug and costs nothing when it's redundant.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => editorRef.current?.layout());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Editor-adjacent features (AuraBug) hold a reference to the live
  // instance via editorRegistry; clear it when the editor goes away so
  // nothing ever acts on a disposed editor.
  useEffect(() => {
    return () => registerActiveEditor(null);
  }, []);

  const handleMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    // Expose the live instance so editor-adjacent features (AuraBug)
    // can read the current model and drive navigation without coupling
    // to this component's internals. Un-registration lives in the
    // unmount effect below; handleMount re-registers on re-mount.
    registerActiveEditor(editorInstance);
    editorInstance.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      void saveFile(pathRef.current);
    });
    // Monaco's own keybinding service consumes Ctrl+I before it ever
    // reaches a window-level listener (it calls stopPropagation the same
    // way it does for Ctrl+S) — a plain useHotkey('i', ...) in
    // EditorWorkspace would silently never fire while the editor has
    // focus, which is exactly when the user just selected code. Binding
    // it here too, the same way as Ctrl+S above, is what makes it work.
    editorInstance.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyI, () => {
      onOpenPaletteRef.current?.();
    });
    // AURA's AI actions, using Monaco's own native context menu (real
    // right-click UX, not a hand-built overlay fighting Monaco's own
    // menu). Each action operates on the current selection, or the
    // whole file when nothing is selected.
    ACTION_SPECS.forEach((spec, i) => {
      editorInstance.addAction({
        id: `aura.${spec.id}`,
        label: `AURA: ${spec.label}`,
        contextMenuGroupId: '9_aura',
        contextMenuOrder: i,
        run: () => onActionRef.current?.(spec.id),
      });
    });
    editorInstance.onDidChangeCursorPosition((e) => {
      updateCursor(pathRef.current, { line: e.position.lineNumber, column: e.position.column });
    });
    editorInstance.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      const empty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
      updateSelection(
        pathRef.current,
        empty
          ? null
          : {
              startLine: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLine: sel.endLineNumber,
              endColumn: sel.endColumn,
            },
      );
    });
  };

  if (!file) return null;

  return (
    <div ref={containerRef} className="h-full w-full">
      <Editor
        path={file.path}
        language={file.language}
        value={file.content}
        theme={theme === 'dark' ? 'aura-dark' : 'aura-light'}
        onMount={handleMount}
        onChange={(value) => updateContent(path, value ?? '')}
        loading={<div className="h-full w-full bg-canvas" />}
        options={{
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
          fontLigatures: true,
          minimap: { enabled: true, scale: 1 },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          padding: { top: 14 },
          scrollBeyondLastLine: false,
          renderLineHighlight: 'gutter',
          automaticLayout: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
