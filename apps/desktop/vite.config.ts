import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * Vite config. Workspace packages are consumed as *source* via aliases,
 * so there is no per-package build step — edit @aura/ui and HMR just
 * works. Tauri-specific server settings are applied when TAURI_* env
 * vars are present (set by `tauri dev`).
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The version the shell reports, read from the SAME file the Tauri
 * bundler versions the binary from. Only a browser-preview fallback: the
 * packaged app asks the running binary via `getVersion()`. Reading it
 * here keeps a dev preview from displaying a stale literal, and keeps the
 * number out of component source entirely.
 */
const APP_VERSION: string = JSON.parse(
  readFileSync(r('./src-tauri/tauri.conf.json'), 'utf8'),
).version;

export default defineConfig(() => ({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
  },
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
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
