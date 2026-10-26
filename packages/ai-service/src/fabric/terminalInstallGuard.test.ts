/**
 * terminal.execute never SPAWNS an install.
 *
 * Routine commands auto-execute now, so the Fabric reaches this executor
 * for `npm install --global …` without a prompt. The property that matters
 * is not the refusal text but that no process is started: `execFile` is
 * replaced with a spy, and an install must leave it uncalled while an
 * ordinary project command through the same binary does reach it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Invocation } from '@aura/capability-fabric';

const spawned: { bin: string; args: string[] }[] = [];

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFile: (bin: string, args: string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
    spawned.push({ bin, args });
    cb(null, '', '');
    return { kill: () => true };
  },
}));

const { allExecutors } = await import('./executors');
const terminal = allExecutors({} as never).find((e) => e.capabilityId === 'terminal.execute')!;
const cwd = mkdtempSync(path.join(tmpdir(), 'aura-guard-'));

const invocation = (command: string) => ({
  id: 'inv-test', capabilityId: 'terminal.execute', input: { command },
  context: { actor: { kind: 'agent', id: 'test' }, projectId: 'p', cwd },
}) as unknown as Invocation;

beforeEach(() => { spawned.length = 0; });

describe('terminal.execute install guard', () => {
  it.each([
    'npm install --global cowsay',
    'npm i -g cowsay',
    'cargo install ripgrep',
    'python3 -m pip install requests',
  ])('%s is refused with nothing spawned', async (command) => {
    const result = await terminal.run(invocation(command));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Installing software is not something this can do/);
    expect(spawned).toEqual([]);
  });

  it('an ordinary project command through the same binary does run', async () => {
    const result = await terminal.run(invocation('npm test'));
    expect(result.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(['test']);
  });
});
