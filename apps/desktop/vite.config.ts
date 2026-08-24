import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Vite config. Workspace packages are consumed as *source* via aliases,
 * so there is no per-package build step — edit @aura/ui and HMR just
 * works. Tauri-specific server settings are applied when TAURI_* env
 * vars are present (set by `tauri dev`).
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@aura/core': r('../../packages/core/src/index.ts'),
      '@aura/ui': r('../../packages/ui/src/index.ts'),
      '@aura/connected-environment': r('../../packages/connected-environment/src/index.ts'),
      '@': r('./src'),
    },
  },
  // Tauri expects a fixed port and no clearing of the screen.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false,
    host: process.env.TAURI_DEV_HOST || false,
    proxy: {
      // The Central Agent service does not answer CORS preflights yet
      // (Agent 2 — reported). In development the renderer therefore talks
      // to it same-origin through this proxy; centralAgentClient defaults
      // to '/agent-api' when running under Vite.
      '/agent-api': {
        target: process.env.VITE_AGENT_ORIGIN ?? 'http://127.0.0.1:4320',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/agent-api/, ''),
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
