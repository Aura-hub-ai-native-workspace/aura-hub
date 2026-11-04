/**
 * The Add Tool flow, guarded at the wiring.
 *
 * The rendered graph is covered in `neon/OrchestrationGraph.test.tsx`;
 * what this file holds is the wiring above it, which no unit render can
 * reach without standing up every store the screen reads.
 *
 * Two claims matter and both are about what does NOT happen. Add Tool
 * opens the existing AURA Everything surface and nothing else — it must
 * never kick off a machine scan, because a control labelled "add" that
 * costs twenty seconds of probing is a trap. And choosing a tool there
 * writes one thing, the workspace layout: no install, no connect, no
 * inventory write, no second store.
 *
 * Since the rail's standalone Add Tool button was removed, the graph's
 * slots are the only things that open that surface: an empty slot to
 * fill one, a filled slot's Replace to swap one. The wiring below is
 * therefore the wiring of the slots themselves.
 *
 * These read source rather than behaviour on purpose. They are cheap
 * tripwires on a boundary that is easy to cross by accident, and they
 * sit alongside the behavioural tests rather than replacing them.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** File contents with comments stripped, so prose cannot trip a guard. */
function code(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const SCREEN = code('../WorkspaceScreen.tsx');
const PLACEMENT = code('../../environment/ToolPlacement.tsx');
const PANEL = code('./neon/LeftControlPanel.tsx');

describe('Add Tool lists detected tools, and installs or connects nothing', () => {
  it('is wired straight to the placement surface', () => {
    expect(SCREEN).toContain('onAddTool={() => openToolSurface(null)}');
    expect(SCREEN.match(/setSurface\('tool'\)/g) ?? []).toHaveLength(1);
    expect(SCREEN).toContain('<ToolPlacement');
  });

  it('reaches the rail only to feed the graph’s empty slots', () => {
    expect(PANEL).toContain('onAddTool={onAddTool}');
    expect(PANEL).not.toContain('add-tool-open');
    expect(PANEL).toContain('add-worker-open');
  });

  it('has no catalog, install or connect path anywhere on the screen or the placement list', () => {
    for (const forbidden of ['installNode', 'AuraEverything', 'environmentClient', 'NodeInspector', 'useEnvironmentStore((s) => s.install)', 'useEnvironmentStore((s) => s.connect)']) {
      expect(SCREEN).not.toContain(forbidden);
    }
    for (const forbidden of ['install(', 'connect(', 'environmentClient', 'search']) expect(PLACEMENT).not.toContain(forbidden);
  });

  it('never calls scan from an add path', () => {
    const scanCalls = SCREEN.match(/\bvoid scan\(\)/g) ?? [];
    expect(scanCalls).toHaveLength(1);
    expect(SCREEN).toMatch(/if \(!lastScanAt\) void scan\(\);/);
  });

  it('keeps the rail free of any environment machinery at all', () => {
    for (const forbidden of ['environmentStore', 'environmentClient', 'scan(', 'install']) {
      expect(PANEL.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('choosing a tool writes the layout and nothing else', () => {
  it('places the node id through the layout store', () => {
    expect(SCREEN).toMatch(/const placeTool = useHubStore\(\(s\) => s\.add\);/);
    expect(SCREEN).toContain('placeTool(catalogId)');
    expect(SCREEN).toContain('if (done) closeSurface();');
  });

  it('refuses a fourth rather than growing the row', () => {
    expect(PLACEMENT).toContain('hasFreeSlot');
    expect(PLACEMENT).toContain('Slots full');
  });
});
