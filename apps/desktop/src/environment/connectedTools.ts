import type { InstallResponse, ItemKind } from './environmentClient';

/** The filter chips on the Installed list, each mapped to the kinds the backend understands. */
export const KIND_FILTERS: { key: string; label: string; kinds: ItemKind[] | undefined }[] = [
  { key: 'all', label: 'All', kinds: undefined },
  { key: 'apps', label: 'Applications', kinds: ['application'] },
  { key: 'cli', label: 'CLI tools', kinds: ['cli'] },
  { key: 'runtimes', label: 'Runtimes & SDKs', kinds: ['runtime', 'sdk'] },
  { key: 'packages', label: 'Packages & libraries', kinds: ['package', 'library'] },
];

/** What the install dialog shows for a preview answer: the command, and whether AURA may run it. */
export interface InstallPrompt {
  command: string;
  /** AURA runs it only when it needs no administrator rights. */
  canRun: boolean;
  note: string;
}

/**
 * Turn a preview answer into the dialog's content, or null when there is
 * nothing to confirm. A command that needs administrator rights is shown for
 * the person to run themselves; AURA never elevates.
 */
export function installPrompt(preview: InstallResponse): InstallPrompt | null {
  if (!preview.command) return null;
  if (preview.installOutcome === 'guided') {
    return { command: preview.command, canRun: false, note: 'This needs administrator rights, so AURA will not run it. Run it yourself in a terminal, then re-check.' };
  }
  if (preview.installOutcome === 'preview') {
    return { command: preview.command, canRun: true, note: 'AURA runs this exact command without a shell, then checks the tool is really there.' };
  }
  return null;
}

/** One honest sentence for how an install ended. */
export function installResultLine(result: InstallResponse): { ok: boolean; text: string } {
  if (result.installOutcome === 'installed') return { ok: true, text: result.detail || 'Installed and verified.' };
  return { ok: false, text: result.detail || result.why || `Install ${result.installOutcome}.` };
}
