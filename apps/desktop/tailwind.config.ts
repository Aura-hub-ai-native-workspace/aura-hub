import type { Config } from 'tailwindcss';
import { SPACE, RADIUS, TYPE } from '../../packages/core/src/tokens';

const px = (n: number) => `${n}px`;

/**
 * Tailwind config for AURA Hub.
 * Colors resolve to CSS variables (see src/styles/global.css) so the
 * entire palette can be re-themed at runtime without a rebuild. We scan
 * the workspace packages too, so @aura/ui utility classes are preserved.
 *
 * `spacing`/`fontSize`/`borderRadius` mirror packages/core/src/tokens.ts's
 * SPACE/TYPE/RADIUS scales, so named utilities (text-base, p-4) agree with
 * the token file by construction instead of by convention. This is additive
 * — existing arbitrary-value classes (text-[13px]) are untouched.
 */
const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
    '../../packages/core/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
          active: 'var(--surface-active)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        text: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
          subtle: 'var(--text-subtle)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          50: 'var(--accent-50)',
          100: 'var(--accent-100)',
          200: 'var(--accent-200)',
          600: 'var(--accent-600)',
          700: 'var(--accent-700)',
        },
        positive: 'var(--positive)',
        attention: 'var(--attention)',
        danger: 'var(--danger)',
        scrim: 'var(--scrim)',
        neon: {
          DEFAULT: 'var(--neon-blue)',
          blue: 'var(--neon-blue)',
          violet: 'var(--neon-violet)',
          cyan: 'var(--neon-cyan)',
          success: 'var(--neon-success)',
          warning: 'var(--neon-warning)',
          danger: 'var(--neon-danger)',
          base: 'var(--neon-base)',
          elev1: 'var(--neon-elev1)',
          elev2: 'var(--neon-elev2)',
        },
        vio: {
          DEFAULT: 'var(--neon-violet)',
          soft: 'rgba(122, 92, 255, 0.14)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Text', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'ui-monospace', 'monospace'],
      },
      spacing: Object.fromEntries(Object.entries(SPACE).map(([k, v]) => [k, px(v)])),
      fontSize: Object.fromEntries(Object.entries(TYPE.size).map(([k, v]) => [k, px(v)])),
      borderRadius: {
        sm: '10px',
        md: '14px',
        lg: '18px',
        xl: '24px',
        '2xl': '18px',
        '3xl': '24px',
        full: px(RADIUS.full),
      },
      boxShadow: {
        xs: '0 1px 2px rgba(20, 23, 29, 0.04)',
        sm: '0 2px 8px rgba(20, 23, 29, 0.05), 0 1px 2px rgba(20, 23, 29, 0.04)',
        md: '0 8px 24px rgba(20, 23, 29, 0.07), 0 2px 6px rgba(20, 23, 29, 0.04)',
        lg: '0 18px 48px rgba(20, 23, 29, 0.10), 0 4px 12px rgba(20, 23, 29, 0.05)',
        card: '0 8px 30px rgba(0, 0, 0, 0.35)',
        'glow-blue': '0 0 0 1px rgba(77,124,255,0.35), 0 0 24px rgba(77,124,255,0.25)',
        'glow-violet': '0 0 0 1px rgba(122,92,255,0.35), 0 0 24px rgba(122,92,255,0.22)',
        'glow-cyan': '0 0 0 1px rgba(32,211,255,0.35), 0 0 24px rgba(32,211,255,0.22)',
        'glow-green': '0 0 0 1px rgba(31,211,138,0.35), 0 0 24px rgba(31,211,138,0.22)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
