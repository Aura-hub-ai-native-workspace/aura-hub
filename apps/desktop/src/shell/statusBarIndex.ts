/**
 * statusBarIndex — the knowledge-index stat in the status bar.
 *
 * The index status describes whatever the service has mounted, and the mount
 * outlives a cleared project authority. Like the git branch beside it, the
 * stat is shown only while a project is open, so the home workspace never
 * carries the removed project's chunk count.
 */
import type { IndexStatus } from '../ai/aiClient';

export interface IndexStat {
  label: string;
  ready: boolean;
}

export function indexStat(projectOpen: boolean, index: IndexStatus | null | undefined): IndexStat | null {
  if (!projectOpen || !index || index.phase === 'empty') return null;
  return index.phase === 'ready'
    ? { label: `${index.coding.chunks} chunks`, ready: true }
    : { label: index.phase, ready: false };
}
