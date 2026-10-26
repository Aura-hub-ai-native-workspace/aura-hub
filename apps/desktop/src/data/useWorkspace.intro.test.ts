/**
 * The first open of a project asks the UI for its opening animation, once.
 * The service decides (and remembers); the store only carries the answer to
 * the screen and lets it clear it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openProject = vi.fn();
vi.mock('../ai/aiClient', () => ({
  aiClient: {
    openProject: (id: string) => openProject(id),
    graph: () => Promise.resolve(null),
    knowledgeGraph: () => Promise.resolve(null),
    indexStatus: () => Promise.resolve({ phase: 'ready', coding: { processed: 0, total: 0 }, message: '' }),
    memory: () => Promise.resolve({ items: [] }),
    listMemory: () => Promise.resolve({ items: [] }),
  },
}));
vi.mock('../ops/memoryStore', () => ({ useMemoryStore: { getState: () => ({ load: () => undefined, items: [] }) } }));

const { useWorkspace } = await import('./useWorkspace');

const opened = (intro?: { firstOpen: boolean; kind: 'new' | 'existing' }) => ({
  project: { id: 'p1' }, profile: { name: 'p1' }, status: { phase: 'ready', coding: { processed: 0, total: 0 }, message: '' }, intro,
});

beforeEach(() => { openProject.mockReset(); useWorkspace.setState({ pendingIntro: null, openId: null }); });

describe('opening animation request', () => {
  it('is raised for a first open, with the kind the service gave', async () => {
    openProject.mockResolvedValue(opened({ firstOpen: true, kind: 'new' }));
    await useWorkspace.getState().open('p1');
    expect(useWorkspace.getState().pendingIntro).toEqual({ projectId: 'p1', kind: 'new' });
  });
  it('is not raised again, and a later open does not clear a pending one', async () => {
    openProject.mockResolvedValueOnce(opened({ firstOpen: true, kind: 'existing' }));
    await useWorkspace.getState().open('p1');
    openProject.mockResolvedValueOnce(opened({ firstOpen: false, kind: 'existing' }));
    await useWorkspace.getState().open('p1');
    expect(useWorkspace.getState().pendingIntro).toEqual({ projectId: 'p1', kind: 'existing' });
    useWorkspace.getState().clearIntro();
    expect(useWorkspace.getState().pendingIntro).toBeNull();
  });
  it('survives being overtaken by another open: the service has already spent the first open', async () => {
    let finish: (v: unknown) => void = () => undefined;
    openProject.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const first = useWorkspace.getState().open('p1');
    // another project is opened before p1's answer arrives
    openProject.mockResolvedValueOnce({ ...opened(), project: { id: 'p2' } });
    await useWorkspace.getState().open('p2');
    finish(opened({ firstOpen: true, kind: 'new' }));
    await first;
    expect(useWorkspace.getState().pendingIntro).toEqual({ projectId: 'p1', kind: 'new' });
  });
  it('is never raised when the service says it is not a first open', async () => {
    openProject.mockResolvedValue(opened({ firstOpen: false, kind: 'new' }));
    await useWorkspace.getState().open('p1');
    expect(useWorkspace.getState().pendingIntro).toBeNull();
  });
});
