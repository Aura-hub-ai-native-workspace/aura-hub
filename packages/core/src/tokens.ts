/**
 * AURA Hub — Design Tokens
 * ------------------------------------------------------------------
 * The single source of truth for the AURA visual language.
 *
 * Tokens are expressed as raw values here AND mirrored as CSS custom
 * properties (see apps/desktop/src/styles/global.css). Tailwind reads
 * the CSS variables so that runtime theming (light / dark / future
 * "ambient" themes) is a matter of swapping variables, never rebuilding.
 *
 * Rule of thumb: components consume semantic tokens (surface, accent,
 * text-muted...) — never raw hex. This keeps the design language
 * swappable without touching a single component.
 */

/** AURA Blue — the one and only primary accent. */
export const AURA_BLUE = {
  50: '#eef4ff',
  100: '#dbe6ff',
  200: '#bfd2ff',
  300: '#93b4ff',
  400: '#608cff',
  500: '#3b6bff', // ← primary accent
  600: '#2451f5',
  700: '#1c3ee0',
  800: '#1d34b5',
  900: '#1d328f',
} as const;

/** Neutral "soft gray" surface ramp — cool, low-chroma, calm. */
export const GRAY = {
  0: '#ffffff',
  25: '#fcfcfd',
  50: '#f7f8fa',
  100: '#eef0f4',
  150: '#e6e9ef',
  200: '#dce0e8',
  300: '#c3c9d5',
  400: '#9aa2b2',
  500: '#6b7385',
  600: '#4c5364',
  700: '#363c49',
  800: '#22262f',
  900: '#14171d',
  950: '#0b0d11',
} as const;

/** Semantic status hues (used sparingly — never as decoration). */
export const STATUS = {
  positive: '#1fb567',
  attention: '#f5a524',
  critical: '#f04438',
  info: AURA_BLUE[500],
} as const;

/** Spacing scale (px). Generous by design — whitespace is a feature. */
export const SPACE = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
} as const;

/** Corner radii — soft, rounded, never sharp. */
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  '2xl': 28,
  full: 9999,
} as const;

/** Elevation — soft, diffuse, low-contrast shadows only. */
export const SHADOW = {
  none: 'none',
  xs: '0 1px 2px rgba(20, 23, 29, 0.04)',
  sm: '0 2px 8px rgba(20, 23, 29, 0.05), 0 1px 2px rgba(20, 23, 29, 0.04)',
  md: '0 8px 24px rgba(20, 23, 29, 0.07), 0 2px 6px rgba(20, 23, 29, 0.04)',
  lg: '0 18px 48px rgba(20, 23, 29, 0.10), 0 4px 12px rgba(20, 23, 29, 0.05)',
  glow: '0 0 0 4px rgba(59, 107, 255, 0.14)',
} as const;

/** Type scale — one humanist sans, tight tracking on large sizes. */
export const TYPE = {
  family: {
    sans: '"Inter", "SF Pro Text", system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  },
  size: {
    xs: 11,
    sm: 12,
    base: 13,
    md: 14,
    lg: 16,
    xl: 20,
    '2xl': 26,
    '3xl': 34,
    '4xl': 46,
  },
} as const;
