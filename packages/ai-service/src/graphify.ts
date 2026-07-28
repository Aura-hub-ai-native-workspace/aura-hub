/**
 * graphify — auto-run graphify on a project after indexing.
 * ==================================================================
 * Spawns `graphify update <project-path>` as a background child process.
 * Output is saved to `<aura-home>/index/<projectId>/graphify/`.
 * The graph.html is served via the ai-service HTTP route (not copied).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homePath } from './persist';

interface GraphifyBin { bin: string; pyenvVersion?: string }

/**
 * Locate the graphify executable. Prefer a CONCRETE pyenv-versioned binary
 * over the `~/.pyenv/shims/graphify` shim: the shim resolves Python from the
 * *target project's* `.python-version`, which may pin an interpreter that
 * isn't installed (e.g. `pyenv: version 3.14.0 is not installed`) and kills
 * the run before graphify starts. The versioned binary carries its own Python
 * shebang and ignores per-directory version files entirely.
 */
function findGraphify(): GraphifyBin | null {
  const env = process.env.GRAPHIFY_BIN;
  if (env && fs.existsSync(env)) return { bin: env };

  const pyenvRoot = path.join(process.env.PYENV_ROOT ?? path.join(os.homedir(), '.pyenv'), 'versions');
  try {
    if (fs.existsSync(pyenvRoot)) {
      for (const v of fs.readdirSync(pyenvRoot).sort().reverse()) {
        const p = path.join(pyenvRoot, v, 'bin', 'graphify');
        if (fs.existsSync(p)) return { bin: p, pyenvVersion: v };
      }
    }
  } catch { /* ignore */ }

  const candidates = [
    path.join(os.homedir(), '.pyenv', 'shims', 'graphify'),
    '/usr/local/bin/graphify',
    path.join(os.homedir(), '.local', 'bin', 'graphify'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return { bin: c };
  return null;
}

export type GraphifyPhase = 'idle' | 'running' | 'done' | 'error';

/** Live generation state, keyed by projectId (drives the UI progress panel). */
const genState = new Map<string, { phase: GraphifyPhase; startedAt: number; error?: string }>();

/**
 * Run graphify on a project directory. Non-blocking — fires and forgets.
 *
 * `graphify update <path>` writes to `<path>/graphify-out/` (there is no
 * output-redirect flag). We run it there, then copy the artifacts into
 * `<aura-home>/index/<projectId>/graphify/` so the HTTP routes serve a
 * stable, project-scoped location regardless of the repo path.
 */
export function runGraphify(projectId: string, projectPath: string): void {
  const found = findGraphify();
  if (!found) {
    console.error('[GRAPHIFY] graphify binary not found — skipping');
    genState.set(projectId, { phase: 'error', startedAt: Date.now(), error: 'graphify binary not found' });
    return;
  }
  // Don't stack concurrent runs for the same project.
  if (genState.get(projectId)?.phase === 'running') return;

  const dest = homePath('index', projectId, 'graphify');
  fs.mkdirSync(dest, { recursive: true });
  genState.set(projectId, { phase: 'running', startedAt: Date.now() });

  console.error(`[GRAPHIFY] Running: ${found.bin} update "${projectPath}"`);

  const child = execFile(
    found.bin,
    ['update', projectPath],
    {
      // Neutral cwd + pinned PYENV_VERSION so graphify is NEVER resolved
      // through the target project's `.python-version` (which may pin an
      // uninstalled interpreter). Output still goes to <projectPath>/graphify-out.
      cwd: os.tmpdir(),
      env: { ...process.env, ...(found.pyenvVersion ? { PYENV_VERSION: found.pyenvVersion } : {}) },
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    },
    (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr ?? '').trim() || err.message;
        console.error('[GRAPHIFY] Failed:', detail.slice(0, 400));
        genState.set(projectId, { phase: 'error', startedAt: Date.now(), error: detail.slice(0, 400) });
        return;
      }
      const srcOut = path.join(projectPath, 'graphify-out');
      let copied = 0;
      for (const f of ['graph.json', 'graph.html', 'GRAPH_REPORT.md']) {
        try {
          const s = path.join(srcOut, f);
          if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(dest, f)); copied++; }
        } catch { /* best-effort */ }
      }
      genState.set(projectId, { phase: 'done', startedAt: Date.now() });
      console.error(`[GRAPHIFY] Done — copied ${copied} artifact(s) to ${dest}`);
    },
  );

  child.unref();
}

/** Current graphify state for a project: whether a graph exists + generation phase. */
export function graphifyStatus(projectId: string): { exists: boolean; phase: GraphifyPhase; error?: string } {
  const exists = graphifyGraphPath(projectId) !== null;
  const state = genState.get(projectId);
  return { exists, phase: state?.phase ?? (exists ? 'done' : 'idle'), error: state?.error };
}

/** Return the graph.html path for a project, or null if not generated yet. */
export function graphifyGraphPath(projectId: string): string | null {
  const p = homePath('index', projectId, 'graphify', 'graph.html');
  return fs.existsSync(p) ? p : null;
}

/** Return the graph.json path for a project, or null if not generated yet. */
export function graphifyJsonPath(projectId: string): string | null {
  const p = homePath('index', projectId, 'graphify', 'graph.json');
  return fs.existsSync(p) ? p : null;
}
