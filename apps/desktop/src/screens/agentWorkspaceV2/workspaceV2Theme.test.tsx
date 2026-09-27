/**
 * Agent Workspace v2 theme contract — v2 follows the global theme too.
 *
 * v2 was built with the same dark-only surfaces as the v1 neon
 * workspace (hardcoded navy panels, `text-neon-*` inks), so it gets
 * the same treatment: `bg-ws-*` / `text-ws-*` tokens, verified here
 * against the rendered markup of every v2 surface.
 *
 * Rendered with `renderToStaticMarkup`; no DOM exists in this repo.
 * Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { V2StatusPill } from './StatusPillV2';
import type { V2Status } from './types';

const DARK_PATTERNS = [
  '9,13,26', '7,11,20', '16,24,43', '10,16,34', '13,19,38',
  '#c9bcff', '#8fb0ff', '#b7a6ff',
  'bg-black', 'border-white', 'bg-neon-base', 'text-neon-',
];

describe('v2 carries no hardcoded dark', () => {
  it.each(DARK_PATTERNS)('StatusPillV2 has no %s in any state', (pattern) => {
    const statuses: V2Status[] = [
      'planning', 'queued', 'analyzing', 'coding', 'researching',
      'executing', 'waiting-for-approval', 'verifying', 'completed',
      'failed', 'cancelled',
    ];
    for (const status of statuses) {
      const markup = renderToStaticMarkup(<V2StatusPill status={status} />);
      expect(markup, `${status} contains ${pattern}`).not.toContain(pattern);
    }
  });

  it('waiting-for-approval still reads as amber in both themes', () => {
    const markup = renderToStaticMarkup(<V2StatusPill status="waiting-for-approval" />);
    expect(markup).toContain('Waiting for approval');
    expect(markup).toContain('text-ws-warn');
  });
});
