/**
 * PanelWorkspace — the dockable multi-panel workspace.
 * ------------------------------------------------------------------
 * Renders the binary split-tree layout from ops/layoutStore.ts as a real
 * dockable UI: recursive splits with draggable dividers, tab stacks with
 * close/drag-to-dock, an add-panel menu, and layout presets that can be
 * saved, loaded and deleted. The tree is pure data, so every change is
 * undoable/persistable and a relaunch restores the exact arrangement.
 *
 * Pointer-device features (drag-resize, drag-to-dock) are layered on top
 * of a keyboard-first core: every panel is a tab you can switch with a
 * click, every command here is also reachable from the command palette.
 */
import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@aura/core';
import { Icon, Menu } from '@aura/ui';
import type { IconName } from '@aura/ui';
import {
  PANEL_META,
  persistLayout,
  persistPresets,
  useLayoutStore,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSplit,
  type PanelKind,
} from './layoutStore';
import { PanelContent } from './panels';
import { FloatingPanel } from './FloatingPanel';

const DIVIDER = 6;

export function PanelWorkspace() {
  const root = useLayoutStore((s) => s.root);
  const presets = useLayoutStore((s) => s.presets);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const floating = useLayoutStore((s) => s.floating);

  // Layout + presets persist on every change. Floating panels are
  // in-session only for now (ephemeral by design — see the Windows &
  // Tools design review's note on extending preset shape later).
  useEffect(() => persistLayout(root), [root]);
  useEffect(() => persistPresets(presets), [presets]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-app">
      <WorkspaceToolbar />
      <div className="flex min-h-0 flex-1 p-2">
        {root ? (
          <Node node={root} />
        ) : (
          <div className="grid flex-1 place-items-center">
            <div className="text-center">
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-text-subtle">
                <Icon name="layout" size={24} />
              </div>
              <p className="text-[14px] font-semibold text-text">Your workspace is empty</p>
              <p className="mx-auto mt-1 max-w-xs text-[12px] text-text-muted">
                Build a docked layout from the engineering panels, then save it as a preset.
              </p>
              <button
                onClick={resetLayout}
                className="mt-4 rounded-xl bg-accent px-4 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-600"
              >
                Load default layout
              </button>
            </div>
          </div>
        )}
      </div>
      {floating.map((f) => (
        <FloatingPanel key={f.id} panel={f} />
      ))}
    </div>
  );
}

/* ── toolbar: presets + add-panel + reset ─────────────────────────── */

const ALL_KINDS = Object.keys(PANEL_META) as PanelKind[];

function WorkspaceToolbar() {
  const savePreset = useLayoutStore((s) => s.savePreset);
  const loadPreset = useLayoutStore((s) => s.loadPreset);
  const removePreset = useLayoutStore((s) => s.removePreset);
  const presets = useLayoutStore((s) => s.presets);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const [name, setName] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  const presetNames = Object.keys(presets);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    savePreset(n);
    setName('');
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1200);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
      <span className="px-1.5 text-[12px] font-semibold text-text">Workspace</span>
      <span className="hidden text-[10.5px] text-text-subtle sm:inline">dock panels · drag tabs between panes · save layouts</span>

      <div className="ml-auto flex items-center gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder={savedFlash ? 'Saved ✓' : 'Preset name…'}
          className="h-7 w-36 rounded-lg border border-line bg-surface px-2 text-[11px] text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent"
        />
        <button
          onClick={save}
          disabled={!name.trim()}
          className="grid h-7 place-items-center rounded-lg bg-accent px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>

        <Menu
          align="end"
          trigger={
            <ToolbarButton icon="layout" label={presetNames.length ? `Layouts · ${presetNames.length}` : 'Layouts'} />
          }
          items={[
            ...(presetNames.length === 0
              ? [{ id: 'none', label: 'No saved layouts yet', onSelect: () => {} }]
              : presetNames.map((n) => ({
                  id: `load:${n}`,
                  label: `Load “${n}”`,
                  icon: 'layout' as IconName,
                  onSelect: () => loadPreset(n),
                }))),
            'separator',
            ...(presetNames.length === 0
              ? []
              : presetNames.map((n) => ({
                  id: `del:${n}`,
                  label: `Delete “${n}”`,
                  icon: 'close' as IconName,
                  tone: 'danger' as const,
                  onSelect: () => removePreset(n),
                }))),
          ]}
        />

        <ToolbarButton icon="refresh" label="Reset" onClick={resetLayout} title="Reset to the default layout" />
      </div>
    </div>
  );
}

function ToolbarButton({ icon, label, onClick, title }: { icon: IconName; label: string; onClick?: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className="flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[11px] font-medium text-text-muted transition-colors hover:border-line-strong hover:bg-surface-hover hover:text-text"
    >
      <Icon name={icon} size={13} />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

/* ── tree rendering ───────────────────────────────────────────────── */

function Node({ node }: { node: LayoutNode | null }) {
  if (!node) return null;
  if (node.kind === 'leaf') return <Leaf node={node} />;
  return <Split node={node} />;
}

function Split({ node }: { node: LayoutSplit }) {
  const setRatio = useLayoutStore((s) => s.setRatio);
  const horizontal = node.dir === 'row';
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const axis = horizontal ? rect.width : rect.height;
    const startPos = horizontal ? e.clientX : e.clientY;
    const startRatio = node.ratio;

    const onMove = (ev: PointerEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      setRatio(node.id, startRatio + delta / axis);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const firstBasis = `calc(${node.ratio * 100}% - ${DIVIDER / 2}px)`;
  const secondBasis = `calc(${(1 - node.ratio) * 100}% - ${DIVIDER / 2}px)`;

  return (
    <div
      ref={ref}
      className={cn('flex min-h-0 min-w-0 flex-1', horizontal ? 'flex-row' : 'flex-col')}
    >
      <div className="min-h-0 min-w-0" style={{ flexBasis: firstBasis, flexGrow: 1, flexShrink: 1 }}>
        <Node node={node.first} />
      </div>
      <div
        onPointerDown={onPointerDown}
        className={cn(
          'z-10 shrink-0 touch-none transition-colors hover:bg-accent/50',
          horizontal ? 'cursor-col-resize' : 'cursor-row-resize',
        )}
        style={horizontal ? { width: DIVIDER } : { height: DIVIDER }}
      />
      <div className="min-h-0 min-w-0" style={{ flexBasis: secondBasis, flexGrow: 1, flexShrink: 1 }}>
        <Node node={node.second} />
      </div>
    </div>
  );
}

/* ── a leaf: tab stack + panel body ───────────────────────────────── */

function Leaf({ node }: { node: LayoutLeaf }) {
  const setActive = useLayoutStore((s) => s.setActive);
  const closeTab = useLayoutStore((s) => s.closeTab);
  const removeLeaf = useLayoutStore((s) => s.removeLeaf);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const moveTab = useLayoutStore((s) => s.moveTab);
  const pinTab = useLayoutStore((s) => s.pinTab);
  const unpinTab = useLayoutStore((s) => s.unpinTab);
  const detachToFloating = useLayoutStore((s) => s.detachToFloating);
  const [dragging, setDragging] = useState(false);

  const missing = ALL_KINDS.filter((k) => !node.tabs.includes(k));

  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData('text/aura-kind') as PanelKind;
    const from = e.dataTransfer.getData('text/aura-leaf');
    if (kind && from) moveTab(kind, from, node.id);
    setDragging(false);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-surface transition-colors',
        dragging ? 'border-accent' : 'border-line',
      )}
    >
      {/* tab bar */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface-active/40 px-1.5">
        {node.tabs.map((kind) => (
          <Tab
            key={kind}
            kind={kind}
            active={node.active === kind}
            leafId={node.id}
            pinned={Boolean(node.pinned?.includes(kind))}
            onClick={() => setActive(node.id, kind)}
            onClose={() => (node.tabs.length === 1 ? removeLeaf(node.id) : closeTab(node.id, kind))}
            onPin={() => pinTab(node.id, kind)}
            onUnpin={() => unpinTab(node.id, kind)}
            onDetach={() => detachToFloating(node.id, kind)}
          />
        ))}
        {missing.length > 0 && (
          <Menu
            trigger={
              <button className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-subtle transition-colors hover:bg-surface-hover hover:text-text">
                <Icon name="plus" size={13} />
              </button>
            }
            items={missing.map((k) => ({
              id: k,
              label: PANEL_META[k].label,
              icon: PANEL_META[k].icon as IconName,
              onSelect: () => openPanel(k, { leafId: node.id }),
            }))}
          />
        )}
      </div>

      {/* panel body */}
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelContent kind={node.active} />
      </div>
    </div>
  );
}

function Tab({
  kind,
  active,
  leafId,
  pinned,
  onClick,
  onClose,
  onPin,
  onUnpin,
  onDetach,
}: {
  kind: PanelKind;
  active: boolean;
  leafId: string;
  pinned: boolean;
  onClick: () => void;
  onClose: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onDetach: () => void;
}) {
  const meta = PANEL_META[kind];
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/aura-kind', kind);
        e.dataTransfer.setData('text/aura-leaf', leafId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      title={meta.label}
      className={cn(
        'group flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors',
        active
          ? 'bg-accent/10 font-medium text-accent-700 dark:text-accent-200'
          : 'text-text-muted hover:bg-surface-hover hover:text-text',
      )}
    >
      <Icon name={meta.icon as IconName} size={12} />
      <span className="whitespace-nowrap">{meta.label}</span>

      <Menu
        align="start"
        trigger={
          <button
            onClick={(e) => e.stopPropagation()}
            title="Tab options"
            className="grid h-4 w-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-surface-hover group-hover:opacity-60 hover:!opacity-100"
          >
            <Icon name="more" size={10} />
          </button>
        }
        items={[
          {
            id: 'pin-toggle',
            label: pinned ? 'Unpin' : 'Pin',
            icon: 'pin' as IconName,
            onSelect: pinned ? onUnpin : onPin,
          },
          {
            id: 'detach',
            label: 'Detach to floating panel',
            icon: 'panel' as IconName,
            onSelect: onDetach,
          },
        ]}
      />

      {pinned ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUnpin();
          }}
          title="Pinned — click to unpin"
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-accent opacity-70 transition-opacity hover:opacity-100"
        >
          <Icon name="pin" size={10} />
        </button>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            'grid h-4 w-4 shrink-0 place-items-center rounded transition-colors',
            active ? 'opacity-60 hover:bg-accent/20 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:opacity-100',
          )}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </div>
  );
}
