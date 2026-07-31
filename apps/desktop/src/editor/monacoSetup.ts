/**
 * Monaco worker + loader setup — imported once, before the first
 * <MonacoEditor> mounts.
 *
 * Two things matter here for a *live, possibly offline, presentation*:
 *  1. `@monaco-editor/react` defaults to fetching Monaco from a CDN at
 *     runtime. We point its loader at the `monaco-editor` package
 *     already bundled by Vite instead, so the editor never depends on
 *     network access.
 *  2. Monaco's language services (TS/JSON/CSS/HTML) run on Web Workers.
 *     Vite's `?worker` suffix bundles each one as its own chunk; without
 *     this, Monaco falls back to a same-thread mode that silently loses
 *     syntax highlighting for those languages.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let configured = false;

/** Idempotent — safe to call from every MonacoEditor mount. */
export function ensureMonacoConfigured() {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });
  defineAuraThemes();
}

/**
 * Two bespoke Monaco themes matching AURA's own CSS variables (see
 * src/styles/global.css), so the editor reads as native chrome instead
 * of a foreign "vs-dark" island dropped into the shell.
 */
function defineAuraThemes() {
  monaco.editor.defineTheme('aura-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#14171d',
      'editorLineNumber.foreground': '#9aa2b2',
      'editorLineNumber.activeForeground': '#5b6376',
      'editor.lineHighlightBackground': '#f4f6f9',
      'editorCursor.foreground': '#3b6bff',
      'editor.selectionBackground': '#dbe6ff',
      'editorIndentGuide.background': '#e6e9ef',
      'editorIndentGuide.activeBackground': '#d5dae3',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e6e9ef',
      'editor.inactiveSelectionBackground': '#eef4ff',
      'scrollbarSlider.background': '#d5dae366',
      'scrollbarSlider.hoverBackground': '#d5dae3aa',
    },
  });
  monaco.editor.defineTheme('aura-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0e1116',
      'editor.foreground': '#f2f4f8',
      'editorLineNumber.foreground': '#667085',
      'editorLineNumber.activeForeground': '#9aa2b2',
      'editor.lineHighlightBackground': '#161a21',
      'editorCursor.foreground': '#5c86ff',
      'editor.selectionBackground': '#1c2a4d',
      'editorIndentGuide.background': '#1c2028',
      'editorIndentGuide.activeBackground': '#2f3542',
      'editorWidget.background': '#14171d',
      'editorWidget.border': '#232833',
      'editor.inactiveSelectionBackground': '#182036',
      'scrollbarSlider.background': '#2f354266',
      'scrollbarSlider.hoverBackground': '#2f3542aa',
    },
  });
}
