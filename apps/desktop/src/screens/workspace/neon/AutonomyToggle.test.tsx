/**
 * AutonomyToggle — the explicit per-project opt-in renders honestly.
 *
 * Off is the only default and must read as "Ask me"; on reads as
 * "Autonomous". With no project there is nothing to govern, so the
 * toggle renders nothing rather than a switch bound to nowhere.
 *
 * Rendered with `renderToStaticMarkup`; no DOM environment exists in
 * this repo. Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutonomyToggle } from './AutonomyToggle';

function toggle(over: Partial<Parameters<typeof AutonomyToggle>[0]> = {}) {
  return renderToStaticMarkup(
    <AutonomyToggle
      projectId="proj-dress-1"
      projectName="dress shop"
      autonomous={false}
      busy={false}
      onToggle={vi.fn()}
      {...over}
    />,
  );
}

describe('AutonomyToggle', () => {
  it('renders nothing without a project', () => {
    expect(toggle({ projectId: null })).toBe('');
  });

  it('reads "Ask me" and unchecked when off', () => {
    const markup = toggle({ autonomous: false });
    expect(markup).toContain('Ask me');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('data-testid="autonomy-toggle"');
  });

  it('reads "Autonomous" and checked when on', () => {
    const markup = toggle({ autonomous: true });
    expect(markup).toContain('Autonomous');
    expect(markup).toContain('aria-checked="true"');
  });

  it('names the project it governs for assistive tech', () => {
    expect(toggle()).toContain('Autonomous mode for dress shop');
  });

  it('disables the switch while a change is in flight', () => {
    expect(toggle({ busy: true })).toContain('disabled');
  });
});
