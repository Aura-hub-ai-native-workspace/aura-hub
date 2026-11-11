import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunObserverView } from './RunObserverPanel';
import { EMPTY_RUN, seedFromReport } from '../../../ai/runObserver';

describe('RunObserverView', () => {
  it('renders nothing before any event or report', () => {
    expect(renderToStaticMarkup(<RunObserverView view={EMPTY_RUN} />)).toBe('');
  });
  it('shows partial success as not complete, with each task state', () => {
    const view = seedFromReport('s', {
      outcome: 'completed', limitations: [], testsObserved: [], verificationEvidence: [], toolsInstalled: [{ nodeId: 'pnpm', name: 'pnpm', outcome: 'installed' }], toolsReused: [], handoffs: [{ taskId: 't2', fromNode: 'codex', toNode: 'claude-code', reason: 'quota', round: 1, verified: false }],
      workCompleted: [{ taskId: 't1', description: 'Write NOTES.md', worker: 'codex' }],
      unfinished: [{ taskId: 't2', description: 'Add a test', state: 'failed', detail: 'the test did not pass' }],
      filesChanged: [{ path: 'NOTES.md', op: 'created', taskId: 't1', worker: 'codex', verified: true }],
      errors: [{ id: 'err-0123456789', status: 'open', summary: 'test failed', taskId: 't2', path: '.aura/errors/x.md' }],
    });
    const html = renderToStaticMarkup(<RunObserverView view={view} />);
    expect(html).toContain('Partly done, not complete: 1 verified, 1 unfinished.');
    expect(html).toContain('data-state="verified"');
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('the test did not pass');
    expect(html).toContain('created · NOTES.md');
    expect(html).toContain('Installed for this run: pnpm');
    expect(html).toContain('Handed over codex');
    expect(html).toContain('(open)');
    expect(html).not.toMatch(/Complete: /);
  });
});

describe('undoing a run', () => {
  const base = seedFromReport('s', {
    outcome: 'completed', limitations: [], testsObserved: [], verificationEvidence: [], toolsInstalled: [], toolsReused: [], handoffs: [],
    workCompleted: [{ taskId: 't1', description: 'Edit app', worker: 'codex' }], unfinished: [], errors: [],
    filesChanged: [{ path: 'app.py', op: 'modified', taskId: 't1', worker: 'codex', verified: true }],
  });
  it('offers Undo for a finished run that recorded a restore point', () => {
    const html = renderToStaticMarkup(<RunObserverView view={{ ...base, restorePoints: ['p1'] }} />);
    expect(html).toContain('Undo this run’s file changes');
  });
  it('offers nothing without a restore point (not a git project)', () => {
    const html = renderToStaticMarkup(<RunObserverView view={base} />);
    expect(html).not.toContain('Undo this run');
  });
});
