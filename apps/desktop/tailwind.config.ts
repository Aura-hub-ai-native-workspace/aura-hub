import type { Config } from 'tailwindcss';

/**
 * Tailwind config for AURA Hub.
 * Colors resolve to CSS variables (see src/styles/global.css) so the
 * entire palette can be re-themed at runtime without a rebuild. We scan
 * the workspace packages too, so @aura/ui utility classes are preserved.
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
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Text', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(20, 23, 29, 0.04)',
        sm: '0 2px 8px rgba(20, 23, 29, 0.05), 0 1px 2px rgba(20, 23, 29, 0.04)',
        md: '0 8px 24px rgba(20, 23, 29, 0.07), 0 2px 6px rgba(20, 23, 29, 0.04)',
        lg: '0 18px 48px rgba(20, 23, 29, 0.10), 0 4px 12px rgba(20, 23, 29, 0.05)',
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
