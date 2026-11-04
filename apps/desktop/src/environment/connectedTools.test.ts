import { describe, expect, it } from 'vitest';
import { KIND_FILTERS, installPrompt, installResultLine } from './connectedTools';
import type { InstallResponse } from './environmentClient';

const base = { nodeId: 'x', privilege: 'user', requiresUserAction: false } as const;

describe('connected tools helpers', () => {
  it('"All" sends no kind filter and every other chip names kinds', () => {
    expect(KIND_FILTERS[0].kinds).toBeUndefined();
    expect(KIND_FILTERS.slice(1).every((f) => (f.kinds?.length ?? 0) > 0)).toBe(true);
  });

  it('a preview can be run; a root command is shown but never runnable', () => {
    const run = installPrompt({ ...base, installOutcome: 'preview', command: 'npm install --global pnpm' } as InstallResponse);
    expect(run).toMatchObject({ canRun: true, command: 'npm install --global pnpm' });
    const root = installPrompt({ ...base, privilege: 'root', installOutcome: 'guided', command: 'sudo pacman -S docker' } as InstallResponse);
    expect(root).toMatchObject({ canRun: false });
  });

  it('with no command there is nothing to confirm', () => {
    expect(installPrompt({ ...base, installOutcome: 'unavailable' } as InstallResponse)).toBeNull();
  });

  it('only a verified install counts as success', () => {
    expect(installResultLine({ ...base, installOutcome: 'installed', detail: 'ok' } as InstallResponse).ok).toBe(true);
    expect(installResultLine({ ...base, installOutcome: 'unverified', detail: 'not found after install' } as InstallResponse)).toEqual({ ok: false, text: 'not found after install' });
  });
});
