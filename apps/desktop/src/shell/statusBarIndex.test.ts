/**
 * statusBarIndex — the home workspace never shows a removed project's index.
 *
 * Regression (real desktop, 2026-10-19): after "Remove from AURA" the status
 * bar read "Workspace: home" but still showed "3 chunks" from the removed
 * project, because the service mount outlives the cleared authority.
 */
import { describe, expect, it } from 'vitest';
import type { IndexStatus } from '../ai/aiClient';
import { indexStat } from './statusBarIndex';

const status = (over: Partial<IndexStatus>): IndexStatus => ({
  projectId: 'aura-alpha-e2e-r3',
  phase: 'ready',
  coding: { processed: 1, total: 1, chunks: 3 },
  fullstack: { processed: 0, total: 0, entities: 0, relations: 0 },
  message: 'Knowledge ready',
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe('indexStat', () => {
  it('shows nothing once no project is open, even if the service still has an index', () => {
    expect(indexStat(false, status({}))).toBeNull();
  });

  it('shows the chunk count for the open project', () => {
    expect(indexStat(true, status({}))).toEqual({ label: '3 chunks', ready: true });
  });

  it('shows the phase while indexing, and nothing for an empty index', () => {
    expect(indexStat(true, status({ phase: 'indexing' }))).toEqual({ label: 'indexing', ready: false });
    expect(indexStat(true, status({ phase: 'empty' }))).toBeNull();
    expect(indexStat(true, null)).toBeNull();
  });
});
