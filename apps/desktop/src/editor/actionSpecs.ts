/**
 * Action registry — the single source of truth shared by the Monaco
 * right-click menu, the Ctrl+I "AURA" command palette, and which result
 * shell (diff / findings / new-file) a given action's response renders
 * into. `mode`/`readOnly` are decided here, statically — never inferred
 * from what the AI happens to return.
 */
import type { IconName } from '@aura/ui';
import type { ActionKind } from '../ai/aiClient';

/** `ActionKind` (single-shot grounded edits) plus `'diagnose'` — a wholly separate, multi-stage pipeline. */
export type WorkspaceActionId = ActionKind | 'diagnose';

export interface ActionSpec {
  id: WorkspaceActionId;
  /** Right-click context menu label. */
  label: string;
  /** Ctrl+I palette phrasing. */
  paletteLabel: string;
  mode: 'diff' | 'findings' | 'new-file' | 'diagnosis';
  readOnly: boolean;
  icon: IconName;
  /** Shown as the live "step 2" status while the AI call is in flight. */
  promptVerb: string;
  needsInput?: boolean;
  inputLabel?: string;
  inputPlaceholder?: string;
}

export const ACTION_SPECS: ActionSpec[] = [
  { id: 'explain', label: 'Explain', paletteLabel: 'Explain this', mode: 'findings', readOnly: true, icon: 'spark', promptVerb: 'Explaining' },
  { id: 'refactor', label: 'Refactor', paletteLabel: 'Refactor this function', mode: 'diff', readOnly: false, icon: 'code', promptVerb: 'Refactoring' },
  { id: 'optimize', label: 'Optimize', paletteLabel: 'Optimize this', mode: 'diff', readOnly: false, icon: 'activity', promptVerb: 'Optimizing' },
  { id: 'diagnose', label: 'Diagnose Bug…', paletteLabel: 'Diagnose this bug', mode: 'diagnosis', readOnly: true, icon: 'bug', promptVerb: 'Diagnosing' },
  { id: 'generate-tests', label: 'Generate Tests', paletteLabel: 'Generate tests', mode: 'new-file', readOnly: false, icon: 'flask', promptVerb: 'Generating tests' },
  { id: 'add-docs', label: 'Add Documentation', paletteLabel: 'Add documentation', mode: 'diff', readOnly: false, icon: 'doc', promptVerb: 'Writing documentation' },
  { id: 'review-security', label: 'Review Security', paletteLabel: 'Secure this code', mode: 'findings', readOnly: true, icon: 'shield', promptVerb: 'Reviewing security' },
  { id: 'simplify', label: 'Simplify', paletteLabel: 'Simplify this', mode: 'diff', readOnly: false, icon: 'refresh', promptVerb: 'Simplifying' },
  {
    id: 'convert', label: 'Convert', paletteLabel: 'Convert this code', mode: 'diff', readOnly: false, icon: 'link', promptVerb: 'Converting',
    needsInput: true, inputLabel: 'Convert to', inputPlaceholder: 'e.g. Python, or async/await style',
  },
  {
    id: 'rename', label: 'Rename', paletteLabel: 'Rename this symbol', mode: 'diff', readOnly: false, icon: 'note', promptVerb: 'Renaming',
    needsInput: true, inputLabel: 'New name', inputPlaceholder: 'newSymbolName',
  },
  {
    id: 'custom', label: 'Custom Prompt…', paletteLabel: 'Custom Prompt…', mode: 'diff', readOnly: false, icon: 'command', promptVerb: 'Working on it',
    needsInput: true, inputLabel: 'What should AURA do?', inputPlaceholder: 'Describe the change you want…',
  },
];

export function actionSpec(id: WorkspaceActionId): ActionSpec {
  const found = ACTION_SPECS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown action: ${id}`);
  return found;
}
