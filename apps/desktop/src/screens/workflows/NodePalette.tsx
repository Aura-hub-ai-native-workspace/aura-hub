/**
 * NodePalette — the node library.
 * ==================================================================
 * Search-first, because scanning six category lists is slower than typing
 * once there are forty node types. Collapses to an icon rail so the
 * canvas gets the space back on a small window.
 *
 * Every entry states what the node *does* on hover, and marks the ones
 * that reach the network or change the project — the palette is the first
 * place a person meets a node, so it is the first place authority should
 * be visible rather than the last.
 */

import { useMemo, useState } from 'react';
import { Icon, IconButton, Input, Tooltip } from '@aura/ui';
import type { NodeSpecInfo } from '../../ai/aiClient';
import type { CapabilityCatalogue } from '../../ai/fabricClient';
import { CATEGORY } from './shared';
import { nodeEffect } from './effects';

export interface NodePaletteProps {
  specs: NodeSpecInfo[];
  catalogue: CapabilityCatalogue | null;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: (spec: NodeSpecInfo) => void;
  /** Begin a drag that drops the node at the pointer. */
  onDragStart: (spec: NodeSpecInfo, e: React.DragEvent) => void;
}

const ORDER: NodeSpecInfo['category'][] = ['source', 'intelligence', 'generate', 'logic', 'action', 'io'];

export function NodePalette({ specs, catalogue, collapsed, onToggle, onAdd, onDragStart }: NodePaletteProps) {
  const [q, setQ] = useState('');

  const riskOf = useMemo(() => {
    const index = new Map((catalogue?.capabilities ?? []).map((c) => [c.id, c]));
    return (spec: NodeSpecInfo) => {
      const cap = nodeEffect(spec.type, spec).capabilityId;
      return cap ? index.get(cap)?.risk ?? null : null;
    };
  }, [catalogue]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: NodeSpecInfo) =>
      !needle ||
      `${s.label} ${s.type} ${s.description} ${s.category} ${nodeEffect(s.type, s).effect}`.toLowerCase().includes(needle);
    const out = new Map<NodeSpecInfo['category'], NodeSpecInfo[]>();
    for (const s of specs) {
      if (!match(s)) continue;
      (out.get(s.category) ?? out.set(s.category, []).get(s.category)!).push(s);
    }
    return ORDER.filter((c) => out.has(c)).map((c) => [c, out.get(c)!] as const);
  }, [specs, q]);

  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  if (collapsed) {
    return (
      <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-line py-2">
        <Tooltip content="Show the node library" side="right">
          <IconButton icon="panel" label="Show the node library" size="sm" onClick={onToggle} />
        </Tooltip>
        <div className="mt-1 h-px w-6 bg-line" />
        {ORDER.map((c) => (
          <Tooltip key={c} content={CATEGORY[c].label} side="right">
            <button
              onClick={onToggle}
              className="grid h-8 w-8 place-items-center rounded-lg transition-colors hover:bg-surface-hover"
              aria-label={CATEGORY[c].label}
            >
              <Icon name={CATEGORY[c].icon} size={14} style={{ color: CATEGORY[c].color }} />
            </button>
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-[240px] shrink-0 flex-col border-r border-line">
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
        <Input
          icon="search"
          inputSize="sm"
          placeholder="Search nodes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1"
          aria-label="Search the node library"
        />
        <IconButton icon="sidebar" label="Collapse the node library" size="sm" onClick={onToggle} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {total === 0 && (
          <p className="px-1 py-6 text-center text-[11.5px] leading-relaxed text-text-subtle">
            No node matches “{q.trim()}”.
            <br />
            Try a word from what you want it to do — “commit”, “memory”, “HTTP”.
          </p>
        )}

        {groups.map(([cat, list]) => (
          <div key={cat} className="mb-4">
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-text-subtle">
              <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY[cat].color }} />
              {CATEGORY[cat].label}
              <span className="ml-auto font-normal tracking-normal">{list.length}</span>
            </div>
            <div className="space-y-1">
              {list.map((sp) => {
                const effect = nodeEffect(sp.type, sp);
                const risk = riskOf(sp);
                return (
                  <button
                    key={sp.type}
                    disabled={sp.disabled}
                    draggable={!sp.disabled}
                    onDragStart={(e) => onDragStart(sp, e)}
                    onClick={() => !sp.disabled && onAdd(sp)}
                    title={sp.disabled ? `${sp.label} — ${sp.description}` : `${sp.label} — ${effect.effect}`}
                    className={`group flex w-full items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 text-left text-[12px] font-medium transition-colors ${
                      sp.disabled
                        ? 'cursor-not-allowed opacity-40'
                        : 'text-text hover:border-line hover:bg-surface-hover'
                    }`}
                  >
                    <Icon name={CATEGORY[sp.category].icon} size={13} style={{ color: CATEGORY[sp.category].color }} />
                    <span className="min-w-0 flex-1 truncate">{sp.label}</span>
                    {sp.disabled ? (
                      <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-text-subtle">soon</span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1">
                        {effect.needsNetwork && (
                          <Icon name="link" size={10} className="text-text-subtle" aria-label="needs the network" />
                        )}
                        {risk === 'high' && <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-label="high risk" />}
                        {risk === 'medium' && <span className="h-1.5 w-1.5 rounded-full bg-attention" aria-label="medium risk" />}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2 text-[10.5px] leading-relaxed text-text-subtle">
        Click to place · drag onto the canvas to position · drop on a connection to insert
      </div>
    </div>
  );
}
