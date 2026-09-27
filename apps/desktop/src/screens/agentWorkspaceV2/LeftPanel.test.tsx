/**
 * MessageComposer — the ONLY user-input surface in the v2 workspace.
 *
 * These tests hold the spec §3 contract:
 *   • exactly ONE message composer
 *   • exactly TWO action buttons beneath it (attach + web search)
 *   • a send button INSIDE the composer
 *   • web-search ON/OFF is a visible, role-switch bound state
 *
 * Rendered with `renderToStaticMarkup` (no DOM environment exists in
 * this repo — same approach as the neon workspace tests). Handlers cannot
 * be driven without a DOM, so the structural claims (counts + states)
 * are asserted on the rendered HTML, which is exactly what the eye sees.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { MessageComposer } from './LeftPanel';
import type { GatewayProbeState } from './LeftPanel';

const SOURCE = readFileSync(new URL('./LeftPanel.tsx', import.meta.url), 'utf8');

const count = (markup: string, testid: string) =>
  markup.split(`data-testid="${testid}"`).length - 1;

/** Extract the full element (its opening tag attributes through the
 *  matching closer) that carries a `data-testid`. React SSR emits
 *  `disabled` / `aria-*` *before* `data-testid`, so a naïve slice at the
 *  testid would miss them; this spans the whole element. */
const elementWithTestid = (markup: string, testid: string) => {
  const at = markup.indexOf(`data-testid="${testid}"`);
  if (at === -1) throw new Error(`no element with testid ${testid}`);
  const open = markup.lastIndexOf('<', at);
  const close = markup.indexOf('>', at) + 1;
  return markup.slice(open, close);
};

const GATEWAY_UNAVAILABLE: GatewayProbeState =
  { state: 'unavailable', reason: 'GATEWAY_NOT_IMPLEMENTED' };

function composer(over: Partial<ComponentProps<typeof MessageComposer>> = {}) {
  const props: ComponentProps<typeof MessageComposer> = {
    value: 'Add an authenticated API',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onPickFiles: vi.fn(),
    webSearchEnabled: false,
    onWebSearchToggle: vi.fn(),
    probe: GATEWAY_UNAVAILABLE,
    busy: false,
    hint: '⌘J focuses this box',
    ...over,
  };
  return <MessageComposer {...props} />;
}

const render = (...args: Parameters<typeof composer>) => renderToStaticMarkup(composer(...args));

describe('MessageComposer — exactly one composer, one send control', () => {
  it('renders one textarea and one send button', () => {
    const markup = render();
    expect(count(markup, 'v2-composer')).toBe(1);
    expect(markup.split('<textarea').length - 1).toBe(1);
    expect(count(markup, 'v2-composer-send')).toBe(1);
  });

  it('shows exactly two action buttons beneath the composer (attach + web search)', () => {
    const markup = render();
    // The container is present; exactly its two children are action buttons.
    expect(count(markup, 'v2-composer-actions')).toBe(1);
    expect(count(markup, 'v2-action-attach')).toBe(1);
    expect(count(markup, 'v2-web-search-toggle')).toBe(1);
    // The two buttons are the ONLY interactive controls in the action row:
    // a third `type="button"` in that row would violate the spec.
    const actionsRow = markup.slice(
      markup.indexOf('data-testid="v2-composer-actions"').valueOf(),
      markup.indexOf('</div>', markup.indexOf('data-testid="v2-composer-actions"')),
    );
    expect((actionsRow.match(/type="button"/g) ?? []).length).toBe(2);
  });
});

describe('MessageComposer — web search state is visible and toggle-bound', () => {
  const toggle = (markup: string) => elementWithTestid(markup, 'v2-web-search-toggle');
  it('reads OFF and is not aria-checked when disabled', () => {
    const markup = render({ webSearchEnabled: false });
    const t = toggle(markup);
    expect(t).toContain('aria-checked="false"');
    expect(t).toContain('Web research OFF');
    // Distinct from the ON state: the OFF toggle must not advertise the
    // ON label or the gateway-pending suffix.
    expect(t).not.toContain('Web research ON');
    expect(t).not.toContain('gateway pending');
  });

  it('reads ON and is aria-checked when enabled, and flags the pending gateway honestly', () => {
    const markup = render({ webSearchEnabled: true, probe: GATEWAY_UNAVAILABLE });
    const t = toggle(markup);
    expect(t).toContain('aria-checked="true"');
    expect(t).toContain('Web research ON');
    // Honest: enabled, but the label itself says the gateway is pending.
    expect(t).toContain('gateway pending');
  });

  it('the ON state is distinct from OFF in its class and label', () => {
    const off = toggle(render({ webSearchEnabled: false }));
    const on = toggle(render({ webSearchEnabled: true, probe: GATEWAY_UNAVAILABLE }));
    expect(off).not.toContain('aria-checked="true"');
    expect(on).not.toContain('Web research OFF');
  });
});

describe('MessageComposer — the toggle only routes through the prop', () => {
  it('binds to onWebSearchToggle and owns no network or local grant of its own', () => {
    expect(SOURCE).toContain('onWebSearchToggle()');
    // The composer itself must not open a network path — that belongs to
    // the searchGateway probe in the orchestrator hook, kept separate.
    for (const forbidden of ['fetch(', 'EventSource (', 'new WebSocket']) {
      expect(SOURCE).not.toContain(forbidden);
    }
  });
});

describe('MessageComposer — the send control is gated on real input', () => {
  const send = (markup: string) => elementWithTestid(markup, 'v2-composer-send');
  it('send is disabled when the composer is empty', () => {
    expect(send(render({ value: '   ' }))).toContain('disabled="');
  });
  it('send is disabled while AURA is busy, regardless of text', () => {
    expect(send(render({ value: 'do the thing', busy: true }))).toContain('disabled="');
  });
  it('send is enabled with real text and no busy flag', () => {
    expect(send(render({ value: 'do the thing', busy: false }))).not.toContain('disabled="');
  });
});
