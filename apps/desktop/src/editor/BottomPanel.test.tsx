import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BottomPanel } from './BottomPanel';
import { ProjectTerminal } from './ProjectTerminal';

describe('Code bottom panel', () => {
  it('collapsed: only the Terminal button, no fake prompt', () => {
    const html = renderToStaticMarkup(<BottomPanel cwd="/tmp" />);
    expect(html).toContain('Terminal');
    expect(html).not.toContain('A real shell attaches here');
    expect(html).not.toContain('git:(main)');
  });

  it('outside the desktop app the terminal says where it runs instead of pretending', () => {
    const html = renderToStaticMarkup(<ProjectTerminal cwd="/tmp" visible />);
    expect(html).toContain('The terminal runs in the AURA Hub desktop app.');
  });
});
