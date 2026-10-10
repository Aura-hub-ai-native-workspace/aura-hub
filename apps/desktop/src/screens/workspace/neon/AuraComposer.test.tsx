/**
 * AuraComposer — the one place a person talks to AURA.
 *
 * Two things are load-bearing and both are pinned here.
 *
 * The composer OWNS its controls. Attachment, web research and send all
 * live inside this box, in normal flow. Nothing is positioned against
 * anything outside the composer, because a control that floats away from
 * the thing it belongs to is a control nobody trusts.
 *
 * Web research is OFF until asked for, and the control says which it is
 * in words. A toggle whose state is carried only by colour is a toggle
 * that fails the first time someone renders it on the wrong background,
 * and a toggle that reads as "on" when it is off would have AURA leaving
 * the machine on a request nobody authorised.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo). The claims
 * that need a click are held against the source, as elsewhere.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuraComposer } from './AuraComposer';

const SOURCE = readFileSync(new URL('./AuraComposer.tsx', import.meta.url), 'utf8');

type Props = Parameters<typeof AuraComposer>[0];

function render(over: Partial<Props> = {}) {
  const props: Props = {
    text: '',
    onTextChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    busy: false,
    webResearch: false,
    onWebResearchChange: vi.fn(),
    ...over,
  };
  return renderToStaticMarkup(<AuraComposer {...props} />);
}

const count = (markup: string, testid: string) =>
  markup.split(`data-testid="${testid}"`).length - 1;

/* ── the composer owns its controls ──────────────────────────────────────── */

describe('AuraComposer — every control lives in the box', () => {
  it('renders the message field, attachment and send', () => {
    const markup = render();
    expect(count(markup, 'agent-composer')).toBe(1);
    expect(count(markup, 'composer-attach')).toBe(1);
    expect(count(markup, 'agent-submit')).toBe(1);
    expect(markup).toContain('<textarea');
  });

  it('renders exactly one web-research switch', () => {
    expect(count(render(), 'composer-web-research')).toBe(1);
  });

  it('keeps its controls in normal flow, not positioned against the page', () => {
    // A composer control anchored to the screen is exactly the defect this
    // control set exists to remove.
    expect(SOURCE).not.toMatch(/absolute\s+bottom-\d+\s+right-\d+/);
    const toolbar = SOURCE.slice(SOURCE.indexOf('data-testid="composer-web-research"'));
    expect(toolbar.slice(0, 600)).not.toContain('absolute');
  });

  it('still swaps send for stop while AURA is working', () => {
    const busy = render({ busy: true });
    expect(count(busy, 'agent-stop')).toBe(1);
    expect(count(busy, 'agent-submit')).toBe(0);
  });

  it('disables the web switch while AURA is working', () => {
    const busy = render({ busy: true });
    expect(busy).toMatch(/data-testid="composer-web-research"[^>]*disabled/);
  });
});

/* ── web research is off until asked ─────────────────────────────────────── */

describe('AuraComposer — web research states itself', () => {
  it('is OFF by default and says so', () => {
    const markup = render();
    expect(markup).toContain('Web Research OFF');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('Web Research ON');
  });

  it('says ON when it is on, and says so accessibly too', () => {
    const markup = render({ webResearch: true });
    expect(markup).toContain('Web Research ON');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('Web Research OFF');
  });

  it('explains the consequence in words on both states', () => {
    expect(render({ webResearch: false })).toContain('this machine');
    expect(render({ webResearch: true })).toContain('public sources');
  });

  it('distinguishes the two states by more than colour', () => {
    const off = render({ webResearch: false });
    const on = render({ webResearch: true });
    expect(off).not.toBe(on);
    // Enabled state uses a theme-aware accent, so it is legible in BOTH
    // themes. --neon-cyan is one fixed #20d3ff in both, which is ~1.7:1
    // on the light surface — "ON" would vanish in light mode.
    expect(on).toContain('text-accent-700');
    expect(on).not.toContain('text-neon-cyan');
    // The state is carried by more than one signal.
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('Web Research ON');
  });

  it('flips through the callback rather than holding its own state', () => {
    // The value belongs to the screen, so a request carries exactly what
    // the person chose and nothing drifts in between. The composer reads
    // it as a prop and declares no state of its own for it.
    expect(SOURCE).toMatch(/^\s+webResearch,$/m);
    expect(SOURCE).toContain('onClick={() => onWebResearchChange(!webResearch)}');
    expect(SOURCE).not.toMatch(/const\s*\[\s*web/i);
  });
});

/* ── attachment: one mechanism, and it is the real one ──────────────────── */

describe('AuraComposer — file upload is real and singular', () => {
  it('opens the native file picker from the attach button', () => {
    // The button drives a real <input type="file">; the picker is the
    // browser's, not something re-implemented in the composer.
    expect(SOURCE).toContain('onClick={() => fileInputRef.current?.click()}');
    const markup = render();
    expect(markup).toContain('type="file"');
  });

  it('carries exactly one file input — there is no second upload path', () => {
    expect(SOURCE.match(/type="file"/g) ?? []).toHaveLength(1);
    expect(count(render(), 'composer-attach')).toBe(1);
  });

  it('ingests through the one documented route', () => {
    expect(SOURCE).toContain('centralAgentClient.ingestDocument');
    // No direct fetch / FormData / second client in the composer: the
    // component must not bypass the shared knowledge-base route.
    expect(SOURCE).not.toMatch(/\bfetch\(/);
    expect(SOURCE).not.toContain('new FormData');
  });

  it('lets the same file be chosen again', () => {
    // Without this, a second attempt at the same document silently does
    // nothing, which reads to a person as "the upload is broken".
    expect(SOURCE).toContain("e.target.value = ''");
  });

  it('shows no attachment badge until something is chosen', () => {
    expect(render()).not.toContain('Dismiss attachment');
  });

  it('names the file and offers a way to remove it once it is there', () => {
    // The badge is state-driven, so its presence is asserted from source:
    // idle renders nothing, anything else names the file.
    expect(SOURCE).toContain("attachState !== 'idle' && attachName");
    expect(SOURCE).toContain('Uploading ${attachName}');
    expect(SOURCE).toContain('aria-label="Dismiss attachment"');
  });

  it('does not offer removal while the upload is still in flight', () => {
    // Removing a file mid-upload would leave the ingestion running with
    // nothing on screen to account for it.
    expect(SOURCE).toContain("attachState !== 'uploading' && (");
  });

  it('states a failed ingestion in plain words', () => {
    // A failure must be visible here, not swallowed into silence.
    expect(SOURCE).toContain("setAttachState('error')");
    expect(SOURCE).toContain('Upload failed');
  });

  it('distinguishes the success, in-flight and failure badges by more than colour', () => {
    for (const token of ['text-neon-success', 'text-text-muted', 'text-neon-danger']) {
      expect(SOURCE).toContain(token);
    }
  });

  it('locks the attach button while AURA is working or uploading', () => {
    expect(render({ busy: true })).toMatch(
      /data-testid="composer-attach"[^>]*disabled/);
    expect(SOURCE).toContain("busy || attachState === 'uploading'");
  });
});

/* ── it is the request that carries the choice ───────────────────────────── */

describe('the web-research choice is request-scoped', () => {
  const SCREEN = readFileSync(
    new URL('../../WorkspaceScreen.tsx', import.meta.url), 'utf8');

  it('starts off, and no request inherits the last one', () => {
    expect(SCREEN).toMatch(/const \[webResearch, setWebResearch\] = useState\(false\);/);
    expect(SCREEN).toContain('setWebResearch(false)');
  });

  it('captures the value as it stands and sends it with that request', () => {
    expect(SCREEN).toContain('const choice = webResearch;');
    expect(SCREEN).toContain('conv.send(text, { webResearch: choice })');
  });

  it('carries it on both a new session and a follow-up leg', () => {
    const CLIENT = readFileSync(
      new URL('../../../ai/centralAgentClient.ts', import.meta.url), 'utf8');
    expect(CLIENT).toContain('webResearch: opts.webResearch === true');
    // Sent explicitly in both directions, so the backend never infers it.
    expect(CLIENT.match(/webResearch: opts\.webResearch === true/g) ?? []).toHaveLength(2);
  });
});
