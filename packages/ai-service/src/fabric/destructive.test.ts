/**
 * destructive — deletion always parks, under every policy.
 *
 * `filesystem.delete` is the one governed file operation that must
 * never run without a human decision. It sits behind TWO independent
 * floors (irreversible + resource.destroy), so even a machine
 * configured with every risk level at auto-execute still parks
 * deletes — and the executor itself confines the granted deletion to
 * the project root and proves the absence afterwards.
 *
 * Runs with `npm run test:service` from the repo root.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluatePolicy, CAPABILITY_MANIFEST } from '@aura/capability-fabric';

function deleteCap() {
  const cap = CAPABILITY_MANIFEST.find((c) => c.id === 'filesystem.delete');
  if (!cap) throw new Error('filesystem.delete is not in the manifest');
  return cap;
}

describe('filesystem.delete policy gate', () => {
  it('is declared irreversible and destructive in the manifest', () => {
    const cap = deleteCap() as { irreversible?: boolean; permissions?: string[]; risk?: string };
    expect(cap.risk).toBe('high');
    expect(cap.irreversible).toBe(true);
    expect(cap.permissions ?? []).toContain('resource.destroy');
  });

  it('parks under the shipped default policy', () => {
    const cap = deleteCap();
    const ev = evaluatePolicy({
      capability: cap, config: DEFAULT_POLICY, granted: ['project.write'], nodeAvailable: null,
    });
    expect(ev.decision).toBe('require-approval');
  });

  it('parks even when every risk level is set to auto-execute', () => {
    // The floors are a lower bound no configuration can go beneath:
    // this is what makes autonomy safe for everything else.
    const cap = deleteCap();
    const ev = evaluatePolicy({
      capability: cap,
      config: {
        ...DEFAULT_POLICY,
        byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
      },
      granted: ['project.write'],
      nodeAvailable: null,
    });
    expect(ev.decision).toBe('require-approval');
  });

  it('no capability override can wave a delete through', () => {
    const cap = deleteCap();
    const ev = evaluatePolicy({
      capability: cap,
      config: {
        ...DEFAULT_POLICY,
        byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
        overrides: { 'filesystem.delete': 'auto-execute' },
      },
      granted: ['project.write'],
      nodeAvailable: null,
    });
    expect(ev.decision).toBe('require-approval');
  });
});

describe('filesystem.delete executor confinement', () => {
  async function freshExecutor() {
    const root = mkdtempSync(join(tmpdir(), 'aura-delete-test-'));
    const { allExecutors } = await import('./executors');
    const exe = allExecutors(null as never).find((e) => e.capabilityId === 'filesystem.delete');
    if (!exe) throw new Error('filesystem.delete has no executor');
    return { root, exe };
  }

  it('deletes a granted file and proves the absence', async () => {
    const { root, exe } = await freshExecutor();
    writeFileSync(join(root, 'doomed.txt'), 'bye\n');
    const out = await exe.run({ input: { path: 'doomed.txt' }, context: { cwd: root } } as never);
    expect(out.ok).toBe(true);
    const check = await exe.verify(
      { input: { path: 'doomed.txt' }, context: { cwd: root } } as never,
      out,
    );
    expect(check.passed).toBe(true);
  });

  it('refuses traversal outside the project root', async () => {
    const { root, exe } = await freshExecutor();
    await expect(
      exe.run({ input: { path: '../escape.txt' }, context: { cwd: root } } as never),
    ).rejects.toThrow(/leaves the project directory/);
  });

  it('reports a missing file honestly instead of failing', async () => {
    const { root, exe } = await freshExecutor();
    const out = await exe.run({ input: { path: 'never-here.txt' }, context: { cwd: root } } as never);
    expect(out.ok).toBe(false);
  });

  it('never removes directories', async () => {
    const { root, exe } = await freshExecutor();
    mkdirSync(join(root, 'subdir'));
    const out = await exe.run({ input: { path: 'subdir' }, context: { cwd: root } } as never);
    expect(out.ok).toBe(false);
  });
});
