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
const EVERYTHING = code('../../environment/AuraEverything.tsx');
const PANEL = code('./neon/LeftControlPanel.tsx');

describe('Add Tool opens the existing surface, and scans nothing', () => {
  it('is wired straight to the AURA Everything surface', () => {
    // Both slot paths go through one opener, which is the only thing
    // that raises the tool surface.
    expect(SCREEN).toContain('onAddTool={() => openToolSurface(null)}');
    expect(SCREEN.match(/setSurface\('tool'\)/g) ?? []).toHaveLength(1);
  });

  it('reaches the rail only to feed the graph’s empty slots', () => {
    // The prop still exists, because the slots need it...
    expect(PANEL).toContain('onAddTool={onAddTool}');
    // ...but the rail's own button is gone, and nothing replaced it.
    expect(PANEL).not.toContain('add-tool-open');
    expect(PANEL).not.toContain('Add Tool');
    expect(PANEL).toContain('add-worker-open');
  });

  it('renders that surface with the existing AuraEverything component', () => {
    expect(SCREEN).toContain('<AuraEverything');
    expect(SCREEN).toContain("import { AuraEverything }");
  });

  it('never calls scan from an add path', () => {
    // The screen scans exactly once, on arrival, and nowhere else.
    const scanCalls = SCREEN.match(/\bvoid scan\(\)/g) ?? [];
    expect(scanCalls).toHaveLength(1);
    expect(SCREEN).toMatch(/if \(!lastScanAt\) void scan\(\);/);
  });

  it('keeps the rail free of any environment machinery at all', () => {
    for (const forbidden of ['environmentStore', 'environmentClient', 'scan(', 'install']) {
      expect(PANEL.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('does not let AURA Everything scan on open', () => {
    expect(EVERYTHING).not.toContain('useEnvironmentStore');
    expect(EVERYTHING).not.toMatch(/\bscan\(/);
    // Its only backend call is the existing search route.
    const calls = EVERYTHING.match(/environmentClient\.\w+/g) ?? [];
    expect([...new Set(calls)]).toEqual(['environmentClient.search']);
  });
});

describe('choosing a tool writes the layout and nothing else', () => {
  it('places the catalogue id through the layout store', () => {
    expect(SCREEN).toMatch(/const placeTool = useHubStore\(\(s\) => s\.add\);/);
    expect(SCREEN).toContain('placeTool(catalogId)');
    // The surface closes only once the layout store accepted the write.
    expect(SCREEN).toContain('if (done) closeSurface();');
  });

  it('keeps the install path separate from the workspace path', () => {
    expect(SCREEN).toMatch(/onInstall=\{\(catalogId\) => void installNode\(catalogId\)\}/);
    expect(SCREEN).toMatch(/onAddToWorkspace=\{\(catalogId\) => \{/);
    // The workspace handler must not reach the installer.
    const handler = SCREEN.slice(
      SCREEN.indexOf('onAddToWorkspace={'),
      SCREEN.indexOf('onAddToWorkspace={') + 220,
    );
    expect(handler).not.toContain('installNode');
    expect(handler).not.toContain('connect');
  });

  it('offers the workspace control only for a real catalogue identity', () => {
    expect(EVERYTHING).toMatch(/onAddToWorkspace && result\.catalogId &&/);
  });

  it('refuses a fourth rather than growing the row', () => {
    expect(EVERYTHING).toContain('hasFreeSlot');
    expect(EVERYTHING).toContain('Slots full');
    expect(SCREEN).toMatch(/hasFreeSlot = useHubStore\(\(s\) => s\.placed\.length < ACTIVE_TOOL_SLOTS\)/);
  });

  it('states the full-capacity case plainly instead of ignoring the action', () => {
    expect(EVERYTHING).toContain('All 3 workspace tool slots are occupied.');
    expect(EVERYTHING).toContain('everything-slots-full');
    // Shown only when the workspace path is actually wired in.
    expect(EVERYTHING).toMatch(/onAddToWorkspace && !hasFreeSlot &&/);
  });
});

describe('removing a tool from the workspace is layout only', () => {
  it('is bound to the layout store’s remove, not to an uninstall', () => {
    expect(SCREEN).toMatch(/const removeTool = useHubStore\(\(s\) => s\.remove\);/);
    expect(SCREEN).toContain('onRemoveTool={removeTool}');
    expect(SCREEN).not.toMatch(/onRemoveTool=\{[^}]*uninstall/i);
  });

  it('leaves the environment store’s own uninstall untouched by the rail', () => {
    expect(PANEL.toLowerCase()).not.toContain('uninstall');
  });
});

describe('replacing a slot opens the same surface, and swaps one slot', () => {
  it('opens AURA Everything, carrying the slot index as context', () => {
    expect(SCREEN).toContain('onReplaceTool={(index) => openToolSurface(index)}');
    expect(SCREEN).toMatch(/const openToolSurface = useCallback\(\(slotIndex: number \| null\) => \{/);
    expect(SCREEN).toContain("setSurface('tool')");
    // An empty slot opens the same surface with no replace context.
    expect(SCREEN).toContain('onAddTool={() => openToolSurface(null)}');
  });

  it('routes the choice to replaceAt when replacing, and to add when not', () => {
    expect(SCREEN).toMatch(/const replaceToolAt = useHubStore\(\(s\) => s\.replaceAt\);/);
    expect(SCREEN).toMatch(/replacingSlot === null\s*\?\s*placeTool\(catalogId\)\s*:\s*replaceToolAt\(replacingSlot, catalogId\)/);
  });

  it('forgets the replace context whenever the surface closes', () => {
    expect(SCREEN).toMatch(/const closeSurface = useCallback\(\(\) => \{\s*setSurface\('none'\);\s*setReplacingSlot\(null\);/);
    expect(SCREEN).toContain('onClick={closeSurface}');
    expect(SCREEN).toContain('if (done) closeSurface();');
  });

  it('triggers no scan, install, probe or connect on the replace path', () => {
    // Still exactly one scan in the whole screen, on arrival.
    expect(SCREEN.match(/\bvoid scan\(\)/g) ?? []).toHaveLength(1);

    const start = SCREEN.indexOf('onAddToWorkspace={');
    const handler = SCREEN.slice(start, start + 420);
    expect(handler).toContain('replaceToolAt');
    for (const forbidden of ['installNode', 'scan(', 'connect', 'probe', 'uninstall']) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('needs no free slot to replace, and says which slot it will use', () => {
    expect(EVERYTHING).toContain('!hasFreeSlot && !replacing');
    expect(EVERYTHING).toContain('everything-replacing');
    expect(EVERYTHING).toContain('Use in slot ');
    expect(EVERYTHING).toContain('swaps that');
  });

  it('never lets the replace surface claim a status for what is chosen', () => {
    // The surface writes an id and closes. Status is the environment's.
    expect(EVERYTHING).not.toContain('setConnected');
    expect(EVERYTHING).not.toMatch(/connected:\s*true/);
    expect(EVERYTHING).not.toMatch(/status:\s*'connected'/);
  });

  it('keeps replace out of the rail’s own concerns', () => {
    // The rail passes the callback through and holds no replace state.
    expect(PANEL).toContain('onReplaceTool={onReplaceTool}');
    expect(PANEL).not.toContain('useState');
    expect(PANEL).not.toContain('replaceAt');
  });
});
