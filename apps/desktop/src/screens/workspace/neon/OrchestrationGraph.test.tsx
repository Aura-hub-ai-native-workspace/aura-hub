/**
 * OrchestrationGraph — the shape of the rail, pinned.
 *
 * The graph is the product claim drawn once: six workers above, one AURA
 * Agent in the middle, three active tool slots below. It previously drew
 * `tools.slice(0, 3)`, so a workspace with one tool drew one tile and a
 * workspace with none drew a sentence. These tests hold the fixed row: a
 * slot is always there, filled or empty, and there is never a fourth.
 *
 * No DOM is needed. Counts come from `renderToStaticMarkup`, and the
 * click handlers are read off the element tree by walking it, so the
 * tests can assert what a control does without a browser.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { EnvironmentNode, NodeStatus } from '@aura/connected-environment';

import type { WorkerDescriptor } from '../../../ai/workerClient';
import { deriveToolSlots, type ToolSlot } from '../../../workspace/toolSlots';
import { deriveWorkerSlots, type WorkerSlot } from '../../../workspace/workerSlots';
import { OrchestrationGraph } from './OrchestrationGraph';

/* ── fixtures ────────────────────────────────────────────────────── */

function worker(id: string, connected = false): WorkerDescriptor {
  return {
    id,
    name: id,
    installed: true,
    connected,
    governance: 'FULLY_GOVERNED',
    reason: '',
    detail: '',
  } as WorkerDescriptor;
}

function envNode(id: string, status: NodeStatus, connected = false): EnvironmentNode {
  return {
    id,
    entry: {
      id,
      name: id.toUpperCase(),
      category: 'development',
      capabilities: [],
      transport: 'local-process',
      auth: 'none',
      license: 'open-source',
      crossPlatform: true,
      maintained: true,
      summary: '',
      homepage: '',
    },
    health: { status, detail: '', checkedAt: '2026-09-11T00:00:00.000Z' },
    permissions: { read: true, write: false, execute: false, autonomous: false },
    activity: [],
    log: [],
    connected,
  };
}

const SIX_IDS = ['claude', 'opencode', 'codex', 'gemini', 'cursor', 'aider'];
const SIX_WORKERS = SIX_IDS.map((id) => worker(id));

/**
 * Worker slots from ids, resolved against the roster. `null` is an empty
 * slot; an id the roster does not know keeps its slot and says so.
 */
function workerSlotsFor(
  ids: (string | null)[] = SIX_IDS,
  roster: WorkerDescriptor[] = SIX_WORKERS,
): WorkerSlot[] {
  return deriveWorkerSlots(ids, roster);
}

const NODES = [
  envNode('git', 'connected', true),
  envNode('docker', 'not-installed'),
  envNode('node', 'available'),
];

function slotsFor(...ids: string[]): ToolSlot[] {
  return deriveToolSlots(
    ids.map((nodeId) => ({ nodeId, x: 0.5, y: 0.5 })),
    NODES,
  );
}

type Handlers = {
  onConnect: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
  onInspect: ReturnType<typeof vi.fn>;
  onAddWorker: ReturnType<typeof vi.fn>;
  onRemoveWorker: ReturnType<typeof vi.fn>;
  onReplaceWorker: ReturnType<typeof vi.fn>;
  onAddTool: ReturnType<typeof vi.fn>;
  onRemoveTool: ReturnType<typeof vi.fn>;
  onReplaceTool: ReturnType<typeof vi.fn>;
};

function handlers(): Handlers {
  return {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onInspect: vi.fn(),
    onAddWorker: vi.fn(),
    onRemoveWorker: vi.fn(),
    onReplaceWorker: vi.fn(),
    onAddTool: vi.fn(),
    onRemoveTool: vi.fn(),
    onReplaceTool: vi.fn(),
  };
}

function graph(
  toolSlots: ToolSlot[],
  h: Handlers = handlers(),
  workerSlots: WorkerSlot[] = workerSlotsFor(),
) {
  return (
    <OrchestrationGraph
      workerSlots={workerSlots}
      workerActivity={new Map()}
      connecting={[]}
      toolSlots={toolSlots}
      phase="Planning"
      busy={false}
      {...h}
    />
  );
}

/** How many times a `data-testid` appears in the rendered markup. */
function count(markup: string, testid: string): number {
  return markup.split(`data-testid="${testid}"`).length - 1;
}

/**
 * Walks the element tree, calling plain function components as it goes,
 * so a control's real `onClick` can be found without a DOM. These
 * components use no hooks, which is what makes this safe.
 */
function walk(node: unknown, visit: (el: ReactElement) => void, depth = 0): void {
  if (depth > 80 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit, depth + 1));
    return;
  }
  const el = node as ReactElement;
  if (!el.props) return;
  visit(el);
  if (typeof el.type === 'function') {
    let rendered: unknown;
    try {
      rendered = (el.type as (p: unknown) => unknown)(el.props);
    } catch {
      return; // a component that needs a host we do not have; not our subject
    }
    walk(rendered, visit, depth + 1);
    return;
  }
  walk((el.props as { children?: unknown }).children, visit, depth + 1);
}

/** Every element carrying the given test id, with its props. */
function findAll(tree: ReactElement, testid: string): ReactElement[] {
  const hits: ReactElement[] = [];
  walk(tree, (el) => {
    if ((el.props as Record<string, unknown>)['data-testid'] === testid) hits.push(el);
  });
  return hits;
}

/* ── the fixed shape ─────────────────────────────────────────────── */

describe('OrchestrationGraph — fixed shape', () => {
  it('draws exactly six worker slots', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git')));
    expect(count(markup, 'worker-slot')).toBe(6);
    expect(count(markup, 'worker-tile')).toBe(6);
  });

  it('draws six worker slots when the workspace has none', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git'), handlers(), workerSlotsFor([])));
    expect(count(markup, 'worker-slot')).toBe(6);
    expect(count(markup, 'worker-tile')).toBe(0);
  });

  it('never draws a seventh worker slot, however many it is handed', () => {
    const overfull = [
      ...workerSlotsFor(),
      { index: 6, workerId: 'extra-one', worker: null, state: 'UNAVAILABLE' as const },
      { index: 7, workerId: 'extra-two', worker: null, state: 'UNAVAILABLE' as const },
    ];
    const markup = renderToStaticMarkup(graph(slotsFor('git'), handlers(), overfull));
    expect(count(markup, 'worker-slot')).toBe(6);
    expect(markup).not.toContain('data-worker-id="extra-one"');
    expect(markup).not.toContain('data-worker-id="extra-two"');
  });

  it('draws exactly one AURA Agent node', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(count(markup, 'hub-aura-node')).toBe(1);
    expect(markup).toContain('AURA Agent');
  });

  it('draws exactly three tool slots when the workspace is full', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(count(markup, 'tool-slot')).toBe(3);
  });

  it('draws exactly three tool slots when the workspace is empty', () => {
    const markup = renderToStaticMarkup(graph(slotsFor()));
    expect(count(markup, 'tool-slot')).toBe(3);
  });

  it('never draws a fourth tool node, whatever it is handed', () => {
    const overfull = [
      ...slotsFor('git', 'docker', 'node'),
      { index: 3, nodeId: 'rust', node: null, state: 'UNAVAILABLE' as const },
      { index: 4, nodeId: 'go', node: null, state: 'UNAVAILABLE' as const },
    ];
    const markup = renderToStaticMarkup(graph(overfull));
    expect(count(markup, 'tool-slot')).toBe(3);
    expect(markup).not.toContain('data-node-id="rust"');
    expect(markup).not.toContain('data-node-id="go"');
    expect(markup).toContain('data-testid="tool-slot" data-slot-index="2"');
    expect(markup).not.toContain('data-testid="tool-slot" data-slot-index="3"');
  });
});

/* ── empty slots ─────────────────────────────────────────────────── */

describe('OrchestrationGraph — empty slots stay visible', () => {
  it('shows three Add Tool affordances when nothing is placed', () => {
    const markup = renderToStaticMarkup(graph(slotsFor()));
    expect(count(markup, 'tool-slot-add')).toBe(3);
    expect(markup.split('Add Tool').length - 1).toBe(3);
    expect(markup).not.toContain('No tools placed yet');
  });

  it('keeps the empty slots beside a placed tool', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git')));
    expect(count(markup, 'tool-slot')).toBe(3);
    expect(count(markup, 'tool-slot-add')).toBe(2);
    expect(markup).toContain('GIT');
  });

  it('offers no Add Tool affordance in the graph once all three are taken', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(count(markup, 'tool-slot-add')).toBe(0);
    expect(count(markup, 'tool-slot-remove')).toBe(3);
  });
});

/* ── slot state comes from real fields ───────────────────────────── */

describe('OrchestrationGraph — slot state is read, not invented', () => {
  it('marks each slot with the state derived from the environment node', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(markup).toContain('data-slot-state="ACTIVE"');
    expect(markup).toContain('data-slot-state="UNAVAILABLE"');
    expect(markup).toContain('data-slot-state="SELECTED"');
  });

  it('marks an unfilled slot EMPTY', () => {
    const markup = renderToStaticMarkup(graph(slotsFor()));
    expect(count(markup, 'tool-slot')).toBe(3);
    expect(markup.split('data-slot-state="EMPTY"').length - 1).toBe(3);
  });

  it('captions a slot with the node’s own status and no readiness claim', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(markup).toContain('Connected');
    expect(markup).toContain('Not installed');
    expect(markup).toContain('Found here');
    // No slot ever claims readiness or verification of its own.
    expect(markup).not.toContain('Ready');
    expect(markup).not.toContain('Verified');
    expect(markup).not.toContain('Available to AURA');
  });
});

/* ── what the controls actually do ───────────────────────────────── */

describe('OrchestrationGraph — Add Tool', () => {
  it('opens the surface and does nothing else', () => {
    const h = handlers();
    const [add] = findAll(graph(slotsFor(), h), 'tool-slot-add');
    expect(add).toBeTruthy();

    (add.props as { onClick: () => void }).onClick();

    expect(h.onAddTool).toHaveBeenCalledTimes(1);
    expect(h.onAddTool).toHaveBeenCalledWith();
    expect(h.onConnect).not.toHaveBeenCalled();
    expect(h.onDisconnect).not.toHaveBeenCalled();
    expect(h.onInspect).not.toHaveBeenCalled();
    expect(h.onRemoveTool).not.toHaveBeenCalled();
  });

  it('cannot trigger a scan, an install or a probe — it reaches none of them', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('./OrchestrationGraph.tsx', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Prose may say "nothing is uninstalled"; what must be absent is any
    // CODE path that scans, installs, probes or reads the inventory.
    for (const forbidden of [
      'environmentStore',
      'environmentClient',
      'useEnvironment',
      'scan(',
      'scan;',
      'onScan',
      'install(',
      'onInstall',
      'installNode',
      'probe',
      'discovery',
      'inventory',
      'fetch(',
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The only outward calls the tool row makes are the two callbacks it
    // is handed.
    expect(code).toContain('onAddTool');
    expect(code).toContain('onRemoveTool');
  });
});

describe('OrchestrationGraph — remove from workspace', () => {
  it('asks only to free the slot, by node id', () => {
    const h = handlers();
    const removes = findAll(graph(slotsFor('git', 'docker', 'node'), h), 'tool-slot-remove');
    expect(removes).toHaveLength(3);

    (removes[1].props as { onClick: () => void }).onClick();

    expect(h.onRemoveTool).toHaveBeenCalledTimes(1);
    expect(h.onRemoveTool).toHaveBeenCalledWith('docker');
    // Nothing about the machine was asked for.
    expect(h.onInspect).not.toHaveBeenCalled();
    expect(h.onConnect).not.toHaveBeenCalled();
    expect(h.onDisconnect).not.toHaveBeenCalled();
    expect(h.onAddTool).not.toHaveBeenCalled();
  });

  it('says out loud that nothing is uninstalled', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git')));
    expect(markup).toContain('Remove GIT from workspace');
    expect(markup).toContain('Nothing is uninstalled');
  });

  it('inspecting a slot is separate from removing it', () => {
    const h = handlers();
    const [inspect] = findAll(graph(slotsFor('git'), h), 'hub-node');

    (inspect.props as { onClick: () => void }).onClick();

    expect(h.onInspect).toHaveBeenCalledWith('git');
    expect(h.onRemoveTool).not.toHaveBeenCalled();
  });
});

/* ── replace ─────────────────────────────────────────────────────── */

describe('OrchestrationGraph — replace a slot’s occupant', () => {
  it('offers Replace on every filled slot and on no empty one', () => {
    expect(count(renderToStaticMarkup(graph(slotsFor())), 'tool-slot-replace')).toBe(0);
    expect(count(renderToStaticMarkup(graph(slotsFor('git'))), 'tool-slot-replace')).toBe(1);
    expect(count(renderToStaticMarkup(graph(slotsFor('git', 'docker'))), 'tool-slot-replace')).toBe(
      2,
    );
    expect(
      count(renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node'))), 'tool-slot-replace'),
    ).toBe(3);
  });

  it('is the way back to the surface once all three slots are taken', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(count(markup, 'tool-slot-add')).toBe(0);
    expect(count(markup, 'tool-slot-replace')).toBe(3);
  });

  it('carries the slot it was opened from as replacement context', () => {
    const h = handlers();
    const replaces = findAll(graph(slotsFor('git', 'docker', 'node'), h), 'tool-slot-replace');
    expect(replaces).toHaveLength(3);

    (replaces[1].props as { onClick: () => void }).onClick();

    expect(h.onReplaceTool).toHaveBeenCalledTimes(1);
    expect(h.onReplaceTool).toHaveBeenCalledWith(1, 'docker');
  });

  it('asks for nothing but the surface — no connect, no removal, no inspect', () => {
    const h = handlers();
    const [replace] = findAll(graph(slotsFor('git'), h), 'tool-slot-replace');

    (replace.props as { onClick: () => void }).onClick();

    expect(h.onReplaceTool).toHaveBeenCalledTimes(1);
    expect(h.onRemoveTool).not.toHaveBeenCalled();
    expect(h.onInspect).not.toHaveBeenCalled();
    expect(h.onConnect).not.toHaveBeenCalled();
    expect(h.onDisconnect).not.toHaveBeenCalled();
    expect(h.onAddTool).not.toHaveBeenCalled();
  });

  it('names the slot and promises nothing about the machine', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git')));
    expect(markup).toContain('Replace GIT in this workspace');
    expect(markup).toContain('Nothing is installed or uninstalled');
  });

  it('adds no slot: the row is still three wide with Replace present', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git', 'docker', 'node')));
    expect(count(markup, 'tool-slot')).toBe(3);
    // Indices 3..5 belong to the worker row above; the tool row stops at 2.
    expect(markup).not.toContain('data-testid="tool-slot" data-slot-index="3"');
  });
});

/* ── the worker row is a row of slots ────────────────────────────── */

describe('OrchestrationGraph — worker slots behave like tool slots', () => {
  /** A click handler read off one control in the rendered tree. */
  const click = (tree: ReactElement, testid: string, nth = 0) =>
    (findAll(tree, testid)[nth].props as { onClick: (e?: unknown) => void }).onClick({
      preventDefault() {},
      stopPropagation() {},
    });

  it('shows + Add Worker on every empty slot, and nowhere else', () => {
    const empty = renderToStaticMarkup(graph(slotsFor('git'), handlers(), workerSlotsFor([])));
    expect(count(empty, 'worker-slot-add')).toBe(6);
    expect(empty.split('Add Worker').length - 1).toBe(6);

    const full = renderToStaticMarkup(graph(slotsFor('git')));
    expect(count(full, 'worker-slot-add')).toBe(0);
  });

  it('keeps an emptied slot in place rather than closing the gap', () => {
    const withHole = workerSlotsFor(['claude', null, 'codex', null, 'cursor', 'aider']);
    const markup = renderToStaticMarkup(graph(slotsFor('git'), handlers(), withHole));

    expect(count(markup, 'worker-slot')).toBe(6);
    expect(count(markup, 'worker-slot-add')).toBe(2);
    expect(count(markup, 'worker-tile')).toBe(4);
    // The empty slots are the ones the layout emptied, at their indices.
    expect(markup).toContain('data-slot-index="1"');
    expect(markup).toContain('Add a worker to slot 2');
    expect(markup).toContain('Add a worker to slot 4');
  });

  it('offers Replace and Remove on every filled slot, labelled for a reader', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git')));

    expect(count(markup, 'worker-slot-replace')).toBe(6);
    expect(count(markup, 'worker-slot-remove')).toBe(6);
    expect(markup).toContain('aria-label="Replace claude in this workspace"');
    expect(markup).toContain('aria-label="Remove claude from workspace"');
    expect(markup).toContain('Nothing is uninstalled or disconnected');
  });

  it('offers neither control on an empty slot', () => {
    const markup = renderToStaticMarkup(graph(slotsFor('git'), handlers(), workerSlotsFor([])));
    expect(count(markup, 'worker-slot-replace')).toBe(0);
    expect(count(markup, 'worker-slot-remove')).toBe(0);
  });

  it('adds through the slot that was clicked', () => {
    const h = handlers();
    const tree = graph(slotsFor('git'), h, workerSlotsFor([null, null, 'codex']));

    click(tree, 'worker-slot-add', 1);

    expect(h.onAddWorker).toHaveBeenCalledTimes(1);
    expect(h.onAddWorker).toHaveBeenCalledWith(1);
    expect(h.onConnect).not.toHaveBeenCalled();
    expect(h.onRemoveWorker).not.toHaveBeenCalled();
  });

  it('replaces by slot index, naming the worker being displaced', () => {
    const h = handlers();
    click(graph(slotsFor('git'), h), 'worker-slot-replace', 2);

    expect(h.onReplaceWorker).toHaveBeenCalledTimes(1);
    expect(h.onReplaceWorker).toHaveBeenCalledWith(2, 'codex');
    expect(h.onRemoveWorker).not.toHaveBeenCalled();
    expect(h.onDisconnect).not.toHaveBeenCalled();
  });

  it('removes by slot index, and reaches no disconnect', () => {
    const h = handlers();
    click(graph(slotsFor('git'), h), 'worker-slot-remove', 3);

    expect(h.onRemoveWorker).toHaveBeenCalledTimes(1);
    expect(h.onRemoveWorker).toHaveBeenCalledWith(3);
    expect(h.onDisconnect).not.toHaveBeenCalled();
    expect(h.onConnect).not.toHaveBeenCalled();
    expect(h.onAddWorker).not.toHaveBeenCalled();
  });

  it('keeps a control click off the tile it sits on', () => {
    const h = handlers();
    const tree = graph(slotsFor('git'), h, workerSlotsFor(['claude'], [worker('claude', true)]));
    let stopped = 0;
    let defaulted = 0;
    const event = { preventDefault: () => { defaulted += 1; }, stopPropagation: () => { stopped += 1; } };

    (findAll(tree, 'worker-slot-remove')[0].props as { onClick: (e: unknown) => void }).onClick(event);
    (findAll(tree, 'worker-slot-replace')[0].props as { onClick: (e: unknown) => void }).onClick(event);

    expect(stopped).toBe(2);
    expect(defaulted).toBe(2);
    // The tile's own handler — connect/disconnect — never ran.
    expect(h.onDisconnect).not.toHaveBeenCalled();
    expect(h.onConnect).not.toHaveBeenCalled();
  });

  it('still connects and disconnects from the tile itself', () => {
    const h = handlers();
    const roster = [worker('claude', true), worker('codex')];
    const tree = graph(slotsFor('git'), h, workerSlotsFor(['claude', 'codex'], roster));

    (findAll(tree, 'worker-tile')[0].props as { onClick: () => void }).onClick();
    (findAll(tree, 'worker-tile')[1].props as { onClick: () => void }).onClick();

    expect(h.onDisconnect).toHaveBeenCalledWith('claude');
    expect(h.onConnect).toHaveBeenCalledWith('codex');
  });

  it('states each slot’s status from the roster, and invents none', () => {
    const roster = [
      worker('claude', true),
      { ...worker('codex'), installed: false } as WorkerDescriptor,
    ];
    const markup = renderToStaticMarkup(
      graph(slotsFor('git'), handlers(), workerSlotsFor(['claude', 'codex', 'ghost'], roster)),
    );

    expect(markup).toContain('data-slot-state="ACTIVE"');
    expect(markup).toContain('data-slot-state="UNAVAILABLE"');
    expect(markup).toContain('Connected');
    expect(markup).toContain('Not installed');
    expect(markup).toContain('Not in worker catalogue');
    for (const invented of ['Ready', 'Verified', 'Available to AURA']) {
      expect(markup).not.toContain(invented);
    }
  });

  it('says Unknown rather than guessing before the roster has answered', () => {
    // An empty tool row too, so every caption on screen is a worker's.
    const markup = renderToStaticMarkup(
      graph(slotsFor(), handlers(), deriveWorkerSlots(SIX_IDS, [])),
    );
    expect(markup.split('data-slot-state="UNKNOWN"').length - 1).toBe(6);
    expect(markup).toContain('Unknown');
    expect(markup).not.toContain('Not installed');
    expect(markup).not.toContain('Connected');
  });

  it('leaves the tool row and the single AURA node untouched', () => {
    const markup = renderToStaticMarkup(
      graph(slotsFor('git', 'docker'), handlers(), workerSlotsFor([null, 'codex'])),
    );
    expect(count(markup, 'tool-slot')).toBe(3);
    expect(count(markup, 'tool-slot-add')).toBe(1);
    expect(count(markup, 'hub-aura-node')).toBe(1);
    expect(count(markup, 'worker-slot')).toBe(6);
  });
});
