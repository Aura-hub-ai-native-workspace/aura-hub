import type { IconName } from '@aura/ui';
import type { NodeSpecInfo } from '../../ai/aiClient';

/** Category identity — one hue per node family, used across canvas,
 *  palette, inspector and legend. */
export const CATEGORY: Record<NodeSpecInfo['category'], { color: string; icon: IconName; label: string }> = {
  source: { color: '#3b82f6', icon: 'folder', label: 'Project sources' },
  intelligence: { color: '#8b5cf6', icon: 'knowledge', label: 'Intelligence' },
  generate: { color: '#10b981', icon: 'spark', label: 'Generate' },
  logic: { color: '#f59e0b', icon: 'workflows', label: 'Logic' },
  action: { color: '#f43f5e', icon: 'deploy', label: 'Actions' },
  io: { color: '#06b6d4', icon: 'panel', label: 'Output' },
};

export const NODE_W = 208;

/** Node card height: base + one row per extra output port. */
export function nodeHeight(spec: NodeSpecInfo | undefined): number {
  const outs = spec?.outputs.length ?? 1;
  return outs > 1 ? 52 + outs * 22 + 10 : 74;
}

export function outPortY(spec: NodeSpecInfo | undefined, port: string, y: number): number {
  const outs = spec?.outputs ?? ['out'];
  const idx = Math.max(0, outs.indexOf(port));
  return outs.length > 1 ? y + 52 + idx * 22 + 10 : y + 37;
}

export function inPortY(y: number): number {
  return y + 37;
}
