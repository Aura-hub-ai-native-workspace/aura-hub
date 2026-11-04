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
      'editor.foreground': '#171717',
      'editorLineNumber.foreground': '#9aa2b2',
      'editorLineNumber.activeForeground': '#636363',
      'editor.lineHighlightBackground': '#f4f6f9',
      'editorCursor.foreground': '#6d6d6d',
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
      'editor.background': '#111111',
      'editor.foreground': '#f2f4f8',
      'editorLineNumber.foreground': '#6f6f6f',
      'editorLineNumber.activeForeground': '#9aa2b2',
      'editor.lineHighlightBackground': '#1a1a1a',
      'editorCursor.foreground': '#878787',
      'editor.selectionBackground': '#2a2a2a',
      'editorIndentGuide.background': '#202020',
      'editorIndentGuide.activeBackground': '#353535',
      'editorWidget.background': '#171717',
      'editorWidget.border': '#282828',
      'editor.inactiveSelectionBackground': '#202020',
      'scrollbarSlider.background': '#2f354266',
      'scrollbarSlider.hoverBackground': '#2f3542aa',
    },
  });
}
