import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge, Button, Dialog, Icon, IconButton, Input, useToast } from '@aura/ui';
import { aiClient, type FieldSpec, type NodeSpecInfo, type WfNode } from '../../ai/aiClient';
import { useWorkflows } from '../../data/useWorkflows';
import { useWorkspace } from '../../data/useWorkspace';
import { AiMarkdown } from '../../ai/AiMarkdown';
import { AiBuilderPanel } from './AiBuilderPanel';
import { CATEGORY, NODE_W, inPortY, nodeHeight, outPortY } from './shared';

/**
 * Workflow Editor — AURA's glass canvas.
 * ==================================================================
 * A real visual editor: drag nodes from the palette, drag port-to-port
 * connections, pan/zoom the canvas, marquee multi-select, inspector with
 * per-node properties, undo/redo, and live node-by-node execution glow
 * driven by the RunEvent stream.
 */

interface View { x: number; y: number; z: number }

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'drag'; sx: number; sy: number; starts: Map<string, { x: number; y: number }> }
  | { kind: 'connect'; from: string; fromPort: string; cx: number; cy: number }
  | { kind: 'marquee'; sx: number; sy: number; cx: number; cy: number };

const STATUS_RING: Record<string, string> = {
  running: 'ring-2 ring-accent shadow-[0_0_18px_rgba(59,107,255,0.45)]',
  waiting: 'ring-2 ring-attention shadow-[0_0_18px_rgba(245,165,36,0.4)]',
  completed: 'ring-2 ring-positive/70',
  failed: 'ring-2 ring-danger shadow-[0_0_18px_rgba(229,72,77,0.4)]',
  skipped: 'opacity-45',
};

export function WorkflowEditor() {
  const wf = useWorkflows();
  const ws = useWorkspace();
  const toast = useToast();
  const def = wf.def!;
  const specOf = useMemo(() => new Map(wf.specs.map((s) => [s.type, s])), [wf.specs]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 60, y: 40, z: 1 });
  const [gesture, setGesture] = useState<Gesture>({ kind: 'none' });
  const [selection, setSelection] = useState<string[]>([]);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [hoverIn, setHoverIn] = useState<string | null>(null);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [runDialog, setRunDialog] = useState(false);
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [panelTab, setPanelTab] = useState<'output' | 'logs'>('output');
  const [showPanel, setShowPanel] = useState(false);

  const gestureRef = useRef(gesture);
  gestureRef.current = gesture;
  const viewRef = useRef(view);
  viewRef.current = view;

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.z, y: (clientY - r.top - v.y) / v.z };
  }, []);

  /* ── zoom (non-passive wheel) ───────────────────────────────────── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        const z = Math.min(2, Math.max(0.3, v.z * (e.deltaY > 0 ? 0.92 : 1.08)));
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        return { z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ── global pointer move/up drives the active gesture ───────────── */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (g.kind === 'none') return;
      if (g.kind === 'pan') setView((v) => ({ ...v, x: g.ox + (e.clientX - g.sx), y: g.oy + (e.clientY - g.sy) }));
      else if (g.kind === 'drag') {
        const dz = viewRef.current.z;
        wf.nudge((d) => {
          for (const n of d.nodes) {
            const s = g.starts.get(n.id);
            if (s) { n.x = Math.round(s.x + (e.clientX - g.sx) / dz); n.y = Math.round(s.y + (e.clientY - g.sy) / dz); }
          }
        });
      } else if (g.kind === 'connect' || g.kind === 'marquee') {
        const c = toCanvas(e.clientX, e.clientY);
        setGesture({ ...g, cx: c.x, cy: c.y });
        if (g.kind === 'connect') {
          const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-inport]');
          setHoverIn(t ? (t as HTMLElement).dataset.inport ?? null : null);
        }
      }
    };
    const up = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (g.kind === 'connect') {
        const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-inport]');
        const to = t ? (t as HTMLElement).dataset.inport : null;
        if (to && to !== g.from) {
          const exists = def.edges.some((ed) => ed.from === g.from && ed.fromPort === g.fromPort && ed.to === to);
          const toSpec = specOf.get(def.nodes.find((n) => n.id === to)?.type ?? '');
          if (!exists && toSpec && toSpec.inputs !== 0) {
            wf.mutate((d) => d.edges.push({ id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, from: g.from, fromPort: g.fromPort, to }));
          }
        }
        setHoverIn(null);
      } else if (g.kind === 'marquee') {
        const x1 = Math.min(g.sx, g.cx); const x2 = Math.max(g.sx, g.cx);
        const y1 = Math.min(g.sy, g.cy); const y2 = Math.max(g.sy, g.cy);
        const hit = def.nodes.filter((n) => n.x + NODE_W / 2 > x1 && n.x + NODE_W / 2 < x2 && n.y + 30 > y1 && n.y + 30 < y2).map((n) => n.id);
        if (hit.length) { setSelection(hit); setSelEdge(null); }
      }
      setGesture({ kind: 'none' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [def, specOf, toCanvas, wf]);

  /* ── keyboard shortcuts ─────────────────────────────────────────── */
  const deleteSelection = useCallback(() => {
    if (selEdge) {
      wf.mutate((d) => { d.edges = d.edges.filter((e) => e.id !== selEdge); });
      setSelEdge(null);
    } else if (selection.length) {
      wf.mutate((d) => {
        const ids = new Set(selection);
        d.nodes = d.nodes.filter((n) => !ids.has(n.id));
        d.edges = d.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
      });
      setSelection([]);
    }
  }, [selEdge, selection, wf]);

  const duplicateSelection = useCallback(() => {
    if (!selection.length) return;
    const fresh: string[] = [];
    wf.mutate((d) => {
      for (const id of selection) {
        const n = d.nodes.find((x) => x.id === id);
        if (!n) continue;
        const nid = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        fresh.push(nid);
        d.nodes.push({ ...n, id: nid, x: n.x + 32, y: n.y + 32, config: { ...n.config } });
      }
    });
    setSelection(fresh);
  }, [selection, wf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); wf.undo(); }
      else if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); wf.redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void wf.save(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
      else if (e.key === 'Escape') { setSelection([]); setSelEdge(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wf, deleteSelection, duplicateSelection]);

  /* ── palette add ────────────────────────────────────────────────── */
  const addNode = (spec: NodeSpecInfo) => {
    const r = wrapRef.current?.getBoundingClientRect();
    const c = r ? toCanvas(r.left + r.width / 2 - 100, r.top + r.height / 2 - 60) : { x: 200, y: 160 };
    const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const config: Record<string, unknown> = {};
    for (const f of spec.fields) if (f.default !== undefined) config[f.key] = f.default;
    wf.mutate((d) => d.nodes.push({ id, type: spec.type, x: Math.round(c.x + (Math.random() * 40 - 20)), y: Math.round(c.y + (Math.random() * 30 - 15)), config }));
    setSelection([id]);
  };

  /* ── run ────────────────────────────────────────────────────────── */
  const userInputNodes = def.nodes.filter((n) => n.type === 'user-input');
  const startRun = () => {
    if (!ws.openId) { toast.push({ title: 'Open a project first', description: 'Workflows execute against the currently open project.', tone: 'attention' }); return; }
    if (userInputNodes.length) {
      const init: Record<string, string> = {};
      for (const n of userInputNodes) init[n.id] = String(n.config.default ?? '');
      setRunValues(init);
      setRunDialog(true);
    } else void launch({});
  };
  const launch = async (inputs: Record<string, string>) => {
    setRunDialog(false);
    setShowPanel(true);
    setPanelTab('output');
    await wf.runFlow(inputs);
  };

  const run = wf.run;
  const nodeRun = (id: string) => run?.states[id];

  /* ── render ─────────────────────────────────────────────────────── */
  const edgePath = (fromN: WfNode, port: string, toN: WfNode) => {
    const x1 = fromN.x + NODE_W;
    const y1 = outPortY(specOf.get(fromN.type), port, fromN.y);
    const x2 = toN.x;
    const y2 = inPortY(toN.y);
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  const grouped = useMemo(() => {
    const g = new Map<NodeSpecInfo['category'], NodeSpecInfo[]>();
    for (const s of wf.specs) (g.get(s.category) ?? g.set(s.category, []).get(s.category)!).push(s);
    return g;
  }, [wf.specs]);

  const selectedNode = selection.length === 1 ? def.nodes.find((n) => n.id === selection[0]) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <style>{`@keyframes wf-dash { to { stroke-dashoffset: -28; } } .wf-live { stroke-dasharray: 9 7; animation: wf-dash .6s linear infinite; }`}</style>

      {/* header */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <Button variant="ghost" size="sm" icon="projects" onClick={() => wf.close()}>Library</Button>
        <div className="h-5 w-px bg-line" />
        {nameEdit === null ? (
          <button className="rounded-lg px-2 py-1 text-[14px] font-semibold text-text hover:bg-surface-hover" onClick={() => setNameEdit(def.name)} title="Rename">
            {def.name}{wf.dirty && <span className="ml-1.5 align-middle text-accent">•</span>}
          </button>
        ) : (
          <Input
            value={nameEdit} inputSize="sm" autoFocus className="w-64"
            onChange={(e) => setNameEdit(e.target.value)}
            onBlur={() => { if (nameEdit.trim()) void wf.patchMeta(def.id, { name: nameEdit.trim() }); setNameEdit(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setNameEdit(null); }}
          />
        )}
        <Badge tone="neutral">{def.category}</Badge>
        <div className="ml-auto flex items-center gap-1.5">
          {ws.openId ? (
            <span className="mr-1 hidden items-center gap-1.5 text-[11.5px] text-text-subtle sm:flex"><Icon name="folder" size={12} /> runs against <span className="font-medium text-text-muted">{ws.projects.find((p) => p.id === ws.openId)?.name ?? ws.openId}</span></span>
          ) : (
            <span className="mr-1 hidden items-center gap-1.5 text-[11.5px] text-attention sm:flex"><Icon name="bell" size={12} /> no project open</span>
          )}
          <IconButton icon="command" label="Undo (Ctrl+Z)" size="sm" onClick={() => wf.undo()} className={wf.undoStack.length ? '' : 'opacity-40'} />
          <IconButton icon="activity" label="Redo (Ctrl+Shift+Z)" size="sm" onClick={() => wf.redo()} className={wf.redoStack.length ? '' : 'opacity-40'} />
          <Button variant="secondary" size="sm" icon="check" onClick={() => void wf.save()} disabled={!wf.dirty}>Save</Button>
          {run?.active ? (
            <Button variant="danger" size="sm" icon="close" onClick={() => wf.stopRun()}>Stop</Button>
          ) : (
            <Button size="sm" icon="spark" onClick={startRun}>Run</Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* palette */}
        <div className="w-[216px] shrink-0 overflow-y-auto border-r border-line p-3">
          {[...grouped.entries()].map(([cat, specs]) => (
            <div key={cat} className="mb-4">
              <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-text-subtle">
                <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY[cat].color }} />
                {CATEGORY[cat].label}
              </div>
              <div className="space-y-1">
                {specs.map((sp) => (
                  <button
                    key={sp.type}
                    disabled={sp.disabled}
                    onClick={() => addNode(sp)}
                    title={sp.disabled ? `${sp.description}` : `Add ${sp.label}`}
                    className={`flex w-full items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 text-left text-[12px] font-medium transition-colors ${sp.disabled ? 'cursor-not-allowed opacity-40' : 'text-text hover:border-line hover:bg-surface-hover'}`}
                  >
                    <Icon name={CATEGORY[sp.category].icon} size={13} style={{ color: CATEGORY[sp.category].color }} />
                    <span className="truncate">{sp.label}</span>
                    {sp.disabled && <span className="ml-auto text-[9.5px] uppercase text-text-subtle">soon</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* canvas */}
        <div
          ref={wrapRef}
          className="relative min-w-0 flex-1 touch-none select-none overflow-hidden bg-bg"
          style={{ backgroundImage: 'radial-gradient(circle, color-mix(in srgb, currentColor 14%, transparent) 1px, transparent 1px)', backgroundSize: `${22 * view.z}px ${22 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px`, color: 'var(--tw-prose-body, inherit)' }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const c = toCanvas(e.clientX, e.clientY);
            if (e.shiftKey) setGesture({ kind: 'marquee', sx: c.x, sy: c.y, cx: c.x, cy: c.y });
            else { setGesture({ kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }); setSelection([]); setSelEdge(null); }
          }}
        >
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {/* edges */}
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={4} height={4}>
              {def.edges.map((e) => {
                const from = def.nodes.find((n) => n.id === e.from);
                const to = def.nodes.find((n) => n.id === e.to);
                if (!from || !to) return null;
                const st = nodeRun(e.from)?.status;
                const live = run && st === 'completed';
                const cat = specOf.get(from.type)?.category ?? 'source';
                const color = e.id === selEdge ? 'var(--color-accent, #3b6bff)' : live ? CATEGORY[cat].color : 'color-mix(in srgb, currentColor 26%, transparent)';
                return (
                  <g key={e.id}>
                    <path d={edgePath(from, e.fromPort, to)} fill="none" stroke="transparent" strokeWidth={14} className="pointer-events-auto cursor-pointer" onPointerDown={(ev) => { ev.stopPropagation(); setSelEdge(e.id); setSelection([]); }} />
                    <path d={edgePath(from, e.fromPort, to)} fill="none" stroke={color} strokeWidth={e.id === selEdge ? 2.5 : 1.8} className={live ? 'wf-live' : ''} />
                  </g>
                );
              })}
              {gesture.kind === 'connect' && (() => {
                const from = def.nodes.find((n) => n.id === gesture.from);
                if (!from) return null;
                const x1 = from.x + NODE_W;
                const y1 = outPortY(specOf.get(from.type), gesture.fromPort, from.y);
                return <path d={`M ${x1} ${y1} C ${x1 + 60} ${y1}, ${gesture.cx - 60} ${gesture.cy}, ${gesture.cx} ${gesture.cy}`} fill="none" stroke="var(--color-accent, #3b6bff)" strokeWidth={2} strokeDasharray="6 5" />;
              })()}
              {gesture.kind === 'marquee' && (
                <rect x={Math.min(gesture.sx, gesture.cx)} y={Math.min(gesture.sy, gesture.cy)} width={Math.abs(gesture.cx - gesture.sx)} height={Math.abs(gesture.cy - gesture.sy)} fill="rgba(59,107,255,0.08)" stroke="rgba(59,107,255,0.5)" strokeWidth={1} />
              )}
            </svg>

            {/* nodes */}
            {def.nodes.map((n) => {
              const sp = specOf.get(n.type);
              const cat = sp?.category ?? 'source';
              const rs = nodeRun(n.id);
              const selected = selection.includes(n.id);
              const h = nodeHeight(sp);
              return (
                <div
                  key={n.id}
                  className={`absolute rounded-2xl border bg-surface/80 backdrop-blur-md transition-shadow ${selected ? 'border-accent shadow-lg' : 'border-line shadow-sm'} ${rs ? STATUS_RING[rs.status] ?? '' : ''}`}
                  style={{ left: n.x, top: n.y, width: NODE_W, height: h }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.button !== 0) return;
                    const next = e.shiftKey ? (selected ? selection.filter((x) => x !== n.id) : [...selection, n.id]) : selected ? selection : [n.id];
                    setSelection(next);
                    setSelEdge(null);
                    wf.beginGesture();
                    const starts = new Map<string, { x: number; y: number }>();
                    for (const id of next.length ? next : [n.id]) {
                      const nn = def.nodes.find((x) => x.id === id);
                      if (nn) starts.set(id, { x: nn.x, y: nn.y });
                    }
                    setGesture({ kind: 'drag', sx: e.clientX, sy: e.clientY, starts });
                  }}
                >
                  <div className="flex items-center gap-2 px-3 pt-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg" style={{ background: `${CATEGORY[cat].color}1f`, color: CATEGORY[cat].color }}>
                      {rs?.status === 'running' || rs?.status === 'waiting' ? <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}><Icon name="activity" size={13} /></motion.span> : <Icon name={CATEGORY[cat].icon} size={13} />}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold leading-tight text-text">{sp?.label ?? n.type}</div>
                      <div className="truncate text-[10px] text-text-subtle">
                        {rs ? (rs.status === 'completed' ? `✓ ${rs.ms}ms${rs.summary ? ` · ${rs.summary}` : ''}` : rs.status === 'failed' ? `✕ ${rs.error ?? 'failed'}` : rs.status) : (firstConfigPreview(n, sp) ?? cat)}
                      </div>
                    </div>
                  </div>
                  {/* in port */}
                  {sp?.inputs !== 0 && (
                    <span data-inport={n.id} className={`absolute -left-[7px] h-3.5 w-3.5 rounded-full border-2 bg-surface transition-transform ${hoverIn === n.id ? 'scale-150 border-accent' : 'border-line'}`} style={{ top: inPortY(0) - 7 }} />
                  )}
                  {/* out ports */}
                  {(sp?.outputs ?? []).map((port, i) => {
                    const many = (sp?.outputs.length ?? 1) > 1;
                    const py = many ? 52 + i * 22 + 10 : 37;
                    return (
                      <span key={port}>
                        {many && <span className="absolute right-4 text-[9.5px] font-medium uppercase tracking-wide text-text-subtle" style={{ top: py - 7 }}>{port}</span>}
                        <span
                          className="absolute -right-[7px] h-3.5 w-3.5 cursor-crosshair rounded-full border-2 border-line bg-surface transition-transform hover:scale-150 hover:border-accent"
                          style={{ top: py - 7 }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            const c = toCanvas(e.clientX, e.clientY);
                            setGesture({ kind: 'connect', from: n.id, fromPort: port, cx: c.x, cy: c.y });
                          }}
                        />
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* zoom controls */}
          <div className="absolute bottom-3 right-3 flex flex-col gap-1">
            <IconButton icon="plus" label="Zoom in" size="sm" onClick={() => setView((v) => ({ ...v, z: Math.min(2, v.z * 1.15) }))} />
            <IconButton icon="dot" label="Reset view" size="sm" onClick={() => setView({ x: 60, y: 40, z: 1 })} />
            <IconButton icon="more" label="Zoom out" size="sm" onClick={() => setView((v) => ({ ...v, z: Math.max(0.3, v.z / 1.15) }))} />
          </div>

          {/* run status chip */}
          {run && (
            <button onClick={() => setShowPanel((s) => !s)} className="absolute left-3 top-3 flex items-center gap-2 rounded-xl border border-line bg-surface/90 px-3 py-1.5 text-[11.5px] font-medium backdrop-blur-md">
              {run.active ? <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }} className="text-accent"><Icon name="activity" size={12} /></motion.span>
                : run.status === 'completed' ? <Icon name="check" size={12} className="text-positive" /> : <Icon name="close" size={12} className="text-danger" />}
              <span className="text-text">{run.active ? 'Running…' : run.status === 'completed' ? `Completed in ${(run.ms / 1000).toFixed(1)}s` : `Failed${run.error ? ` — ${run.error}` : ''}`}</span>
              <span className="text-text-subtle">{showPanel ? 'hide' : 'details'}</span>
            </button>
          )}
        </div>

        {/* inspector */}
        <div className="w-[280px] shrink-0 overflow-y-auto border-l border-line p-4">
          {selectedNode ? (
            <NodeInspector node={selectedNode} spec={specOf.get(selectedNode.type)} onDelete={deleteSelection} onDuplicate={duplicateSelection} />
          ) : selEdge ? (
            <div>
              <div className="mb-2 text-[13px] font-semibold text-text">Connection</div>
              <p className="mb-3 text-[12px] text-text-muted">A data flow between two nodes.</p>
              <Button variant="danger" size="sm" icon="close" onClick={deleteSelection}>Delete connection</Button>
            </div>
          ) : selection.length > 1 ? (
            <div>
              <div className="mb-2 text-[13px] font-semibold text-text">{selection.length} nodes selected</div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" icon="plus" onClick={duplicateSelection}>Duplicate</Button>
                <Button variant="danger" size="sm" icon="close" onClick={deleteSelection}>Delete</Button>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-2 text-[13px] font-semibold text-text">Workflow</div>
              <p className="mb-4 text-[12px] leading-relaxed text-text-muted">{def.description || 'Click a node to edit its properties. Drag from an output port to connect. Shift-drag for multi-select.'}</p>
              <div className="space-y-2 text-[11.5px] text-text-subtle">
                <div className="flex justify-between"><span>Nodes</span><span className="text-text-muted">{def.nodes.length}</span></div>
                <div className="flex justify-between"><span>Connections</span><span className="text-text-muted">{def.edges.length}</span></div>
                <div className="flex justify-between"><span>Category</span><span className="text-text-muted">{def.category}</span></div>
              </div>
              <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-[11px] text-text-subtle">
                <div><kbd className="rounded bg-surface-active px-1">⌘Z</kbd> undo · <kbd className="rounded bg-surface-active px-1">⌘⇧Z</kbd> redo</div>
                <div><kbd className="rounded bg-surface-active px-1">⌘S</kbd> save · <kbd className="rounded bg-surface-active px-1">⌘D</kbd> duplicate</div>
                <div><kbd className="rounded bg-surface-active px-1">Del</kbd> delete · <kbd className="rounded bg-surface-active px-1">⇧drag</kbd> multi-select</div>
              </div>
              <WebhookTrigger workflowId={def.id} />
            </div>
          )}
        </div>

        {/* AI Workflow Builder — permanent, alongside the inspector */}
        <AiBuilderPanel />
      </div>

      {/* run panel */}
      {run && showPanel && (
        <motion.div initial={{ height: 0 }} animate={{ height: 260 }} className="shrink-0 overflow-hidden border-t border-line">
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-1 border-b border-line px-3 py-1.5">
              <button onClick={() => setPanelTab('output')} className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium ${panelTab === 'output' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>Output {run.outputs.length ? `(${run.outputs.length})` : ''}</button>
              <button onClick={() => setPanelTab('logs')} className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium ${panelTab === 'logs' ? 'bg-surface-active text-text' : 'text-text-muted'}`}>Logs {run.logs.length ? `(${run.logs.length})` : ''}</button>
              <span className="ml-auto text-[11px] text-text-subtle">{Object.values(run.states).filter((s) => s.status === 'completed').length}/{def.nodes.length} completed{run.ms ? ` · ${(run.ms / 1000).toFixed(1)}s` : ''}</span>
              <IconButton icon="close" label="Hide panel" size="sm" onClick={() => setShowPanel(false)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {panelTab === 'output' ? (
                run.outputs.length ? (
                  <div className="space-y-4">
                    {run.outputs.map((o, i) => (
                      <div key={i}>
                        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle"><Icon name="panel" size={11} /> {o.title}</div>
                        <div className="rounded-xl border border-line bg-surface p-3 text-[12.5px]"><AiMarkdown source={o.text} /></div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-text-muted">{run.active ? 'Waiting for an Output node…' : 'This run produced no Output nodes.'}</p>
                )
              ) : (
                <div className="space-y-1 font-mono text-[11px]">
                  {run.logs.map((l, i) => (
                    <div key={i} className={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-attention' : 'text-text-muted'}>
                      <span className="text-text-subtle">{new Date(l.at).toLocaleTimeString()} </span>
                      {l.nodeId ? `[${specOf.get(def.nodes.find((n) => n.id === l.nodeId)?.type ?? '')?.label ?? l.nodeId}] ` : ''}{l.text}
                    </div>
                  ))}
                  {!run.logs.length && <p className="font-sans text-[12px] text-text-muted">No log lines.</p>}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* pre-run user inputs */}
      <Dialog open={runDialog} onClose={() => setRunDialog(false)} title="Run workflow" description="This workflow asks for input before it starts." size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRunDialog(false)}>Cancel</Button>
            <Button icon="spark" onClick={() => void launch(runValues)}>Run</Button>
          </div>
        }>
        <div className="space-y-3">
          {userInputNodes.map((n) => (
            <div key={n.id}>
              <label className="mb-1 block text-[12px] font-medium text-text">{String(n.config.prompt ?? 'Value')}</label>
              <Input value={runValues[n.id] ?? ''} onChange={(e) => setRunValues((v) => ({ ...v, [n.id]: e.target.value }))} autoFocus={n.id === userInputNodes[0]?.id} />
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

/** Surfaces this workflow's inbound trigger URL — an external system's own webhook config (GitHub, or anything else) can POST here to start a run, without AURA needing an API client for that system. Lazy: nothing is generated until asked for. */
function WebhookTrigger({ workflowId }: { workflowId: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const reveal = async (rotate: boolean) => {
    setBusy(true);
    try {
      const res = rotate ? await aiClient.rotateWorkflowWebhook(workflowId) : await aiClient.ensureWorkflowWebhook(workflowId);
      if ('path' in res) setPath(`${aiClient.base}${res.path}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">Inbound trigger</div>
      {path ? (
        <>
          <p className="mb-1.5 break-all font-mono text-[10.5px] text-text-muted">{path}</p>
          <div className="flex gap-1.5">
            <Button
              variant="secondary" size="sm" icon={copied ? 'check' : 'clipboard'}
              onClick={() => { void navigator.clipboard.writeText(path); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => void reveal(true)} disabled={busy}>Rotate</Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[11px] leading-relaxed text-text-subtle">Point an external system's own webhook (e.g. a GitHub repo's Settings → Webhooks) at a URL here to start a run — no AURA-side setup needed on their end.</p>
          <Button variant="secondary" size="sm" icon="link" onClick={() => void reveal(false)} disabled={busy}>{busy ? 'Generating…' : 'Show trigger URL'}</Button>
        </>
      )}
    </div>
  );
}

function firstConfigPreview(n: WfNode, sp: NodeSpecInfo | undefined): string | null {
  for (const f of sp?.fields ?? []) {
    const v = n.config[f.key];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 34);
  }
  return null;
}

/* ── node inspector ─────────────────────────────────────────────────── */

function NodeInspector({ node, spec, onDelete, onDuplicate }: { node: WfNode; spec: NodeSpecInfo | undefined; onDelete: () => void; onDuplicate: () => void }) {
  const wf = useWorkflows();
  if (!spec) return <p className="text-[12px] text-text-muted">Unknown node type: {node.type}</p>;
  const setCfg = (key: string, value: unknown) => wf.mutate((d) => { const n = d.nodes.find((x) => x.id === node.id); if (n) n.config[key] = value; });
  const cat = CATEGORY[spec.category];
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `${cat.color}1f`, color: cat.color }}><Icon name={cat.icon} size={14} /></span>
        <div className="text-[13px] font-semibold text-text">{spec.label}</div>
      </div>
      <p className="mb-4 text-[11.5px] leading-relaxed text-text-muted">{spec.description}</p>
      <div className="space-y-3">
        {spec.fields.map((f) => <Field key={f.key} f={f} value={node.config[f.key]} onChange={(v) => setCfg(f.key, v)} />)}
        {!spec.fields.length && <p className="text-[11.5px] text-text-subtle">This node has no settings — it works from the live project.</p>}
      </div>
      <div className="mt-5 flex gap-2 border-t border-line pt-4">
        <Button variant="secondary" size="sm" icon="plus" onClick={onDuplicate}>Duplicate</Button>
        <Button variant="danger" size="sm" icon="close" onClick={onDelete}>Delete</Button>
      </div>
    </div>
  );
}

function Field({ f, value, onChange }: { f: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const v = value ?? f.default ?? '';
  return (
    <div>
      <label className="mb-1 block text-[11.5px] font-medium text-text">{f.label}</label>
      {f.kind === 'textarea' ? (
        <textarea value={String(v)} placeholder={f.placeholder} rows={4} onChange={(e) => onChange(e.target.value)}
          className="w-full resize-y rounded-xl border border-line bg-surface px-2.5 py-2 text-[12px] text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent" />
      ) : f.kind === 'select' ? (
        <select value={String(v)} onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-line bg-surface px-2.5 py-2 text-[12px] text-text outline-none focus:border-accent">
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : f.kind === 'boolean' ? (
        <button onClick={() => onChange(!(v === true))} className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${v === true ? 'bg-accent' : 'bg-surface-active'}`}>
          <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${v === true ? 'translate-x-5' : ''}`} />
        </button>
      ) : (
        <Input value={String(v)} placeholder={f.placeholder} inputSize="sm" type={f.kind === 'number' ? 'number' : 'text'}
          onChange={(e) => onChange(f.kind === 'number' ? Number(e.target.value) : e.target.value)} />
      )}
      {f.help && <p className="mt-1 text-[10.5px] text-text-subtle">{f.help}</p>}
    </div>
  );
}
