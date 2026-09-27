/**
 * Workspace theme contract — every Workspace element follows the global theme.
 *
 * Root cause it guards: the neon Workspace painted hardcoded dark-navy
 * surfaces (`rgba(9,13,26,…)`, `#c9bcff` inks) and `.neon-shell` forced a
 * dark canvas with a light-text override in BOTH themes, so the header
 * and nav went light while the entire Workspace stayed dark.
 *
 * The contract now: components use `bg-ws-*` / `text-ws-*` tokens (defined
 * per theme in global.css); dark values are the established cyber-glass,
 * light values the light-glass treatment. These tests hold both sides —
 * the tokens exist in both theme blocks with genuinely different values,
 * and the rendered components carry no hardcoded dark surface.
 *
 * Rendered with `renderToStaticMarkup`; no DOM environment exists in
 * this repo. Run with `npm run test:front` from the repo root.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceShell } from './WorkspaceShell';
import { GlassCard } from './GlassCard';
import { StatusPill, type StepStatus } from './StatusPill';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'styles', 'global.css');
const css = readFileSync(cssPath, 'utf8');

function themeBlock(theme: 'light' | 'dark'): string {
  const marker = `:root[data-theme='${theme}'] {`;
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`missing ${theme} theme block`);
  // The block runs to the next top-level closing brace.
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${theme} theme block`);
}

function tokenValue(block: string, token: string): string | null {
  const m = block.match(new RegExp(`${token}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/** Every workspace token both themes must define. */
const REQUIRED_TOKENS = [
  '--ws-canvas', '--ws-panel', '--ws-dialog', '--ws-pop', '--ws-pop-strong',
  '--ws-pop-soft', '--ws-header', '--ws-input', '--ws-input-soft', '--ws-soft',
  '--ws-tile', '--ws-slot', '--ws-evidence', '--ws-aura-row', '--ws-unavail',
  '--ws-grad-from', '--ws-grad-to', '--ws-ink', '--ws-ink-blue',
  '--ws-ink-violet', '--ws-ink-cyan', '--ws-ok', '--ws-warn', '--ws-bad',
];

describe('workspace theme tokens', () => {
  const light = themeBlock('light');
  const dark = themeBlock('dark');

  it('defines every workspace token in both themes', () => {
    for (const token of REQUIRED_TOKENS) {
      expect(tokenValue(light, token), `${token} in light`).toBeTruthy();
      expect(tokenValue(dark, token), `${token} in dark`).toBeTruthy();
    }
  });

  it('dark keeps the established cyber-glass surfaces pixel-identical', () => {
    expect(tokenValue(dark, '--ws-panel')).toBe('rgba(9, 13, 26, 0.82)');
    expect(tokenValue(dark, '--ws-canvas')).toBe('#070b14');
    expect(tokenValue(dark, '--ws-dialog')).toBe('rgba(9, 13, 26, 0.97)');
    expect(tokenValue(dark, '--ws-ink')).toBe('#c9bcff');
    expect(tokenValue(dark, '--ws-ink-blue')).toBe('#8fb0ff');
    expect(tokenValue(dark, '--ws-ink-violet')).toBe('#b7a6ff');
  });

  it('light actually differs from dark on every surface and ink', () => {
    for (const token of REQUIRED_TOKENS) {
      expect(tokenValue(light, token), `${token} must change with theme`).not.toBe(
        tokenValue(dark, token),
      );
    }
  });

  it('neon-shell no longer forces a dark foreground', () => {
    const shellStart = css.indexOf('.neon-shell {');
    const shell = css.slice(shellStart, css.indexOf('}', css.indexOf('color: var(--text);', shellStart)) + 1);
    expect(shell).toContain('var(--ws-canvas)');
    expect(shell).not.toContain('--text:');
  });
});

/** Hardcoded dark patterns that must never return to Workspace markup. */
const DARK_PATTERNS = [
  '9,13,26', '7,11,20', '16,24,43', '10,16,34', '13,19,38',
  '#c9bcff', '#8fb0ff', '#b7a6ff',
  'bg-black', 'border-white', 'bg-neon-base', 'text-neon-',
];

describe('workspace components carry no hardcoded dark', () => {
  const shell = renderToStaticMarkup(
    <WorkspaceShell left={<div>rail</div>} right={<div>conversation</div>} />,
  );
  const card = renderToStaticMarkup(<GlassCard tint="amber">body</GlassCard>);

  it.each(DARK_PATTERNS)('WorkspaceShell has no %s', (pattern) => {
    expect(shell).not.toContain(pattern);
  });

  it.each(DARK_PATTERNS)('GlassCard has no %s', (pattern) => {
    expect(card).not.toContain(pattern);
  });

  it('WorkspaceShell panels use the theme panel token', () => {
    expect(shell).toContain('bg-ws-panel');
    expect(shell).toContain('bg-ws-pop');
  });

  it('every status pill renders without hardcoded dark text', () => {
    const statuses: StepStatus[] = [
      'idle', 'planning', 'analyzing', 'coding', 'generating', 'executing',
      'completed', 'failed', 'waiting', 'awaiting-approval', 'correcting',
      'verifying', 'verified', 'unverified', 'denied', 'skipped', 'cancelled',
    ];
    for (const status of statuses) {
      const markup = renderToStaticMarkup(<StatusPill status={status} />);
      for (const pattern of DARK_PATTERNS) {
        expect(markup, `${status} contains ${pattern}`).not.toContain(pattern);
      }
    }
  });
});
