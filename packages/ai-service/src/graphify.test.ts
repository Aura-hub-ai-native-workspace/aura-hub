/**
 * graphify — indexing must not leave generated files in the user's project.
 *
 * `graphify update <path>` can only write to `<path>/graphify-out/`. AURA
 * copies the artifacts into its own home; the directory a run created is
 * then removed, and a graphify-out that was already there is left alone.
 *
 * A stand-in script plays graphify (via GRAPHIFY_BIN), so the real tool
 * never runs. Runs with `npm run test:service`, against an isolated
 * AURA_HOME so no real user state is touched.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.AURA_HOME = mkdtempSync(join(tmpdir(), 'aura-graphify-test-'));

import { graphifyStatus, runGraphify } from './graphify';

/** A fake graphify that writes the real output shape, then exits `code`. */
function fakeGraphify(code: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'aura-fake-graphify-'));
  const bin = join(dir, 'graphify');
  writeFileSync(bin, [
    '#!/bin/sh',
    'out="$2/graphify-out"',
    'mkdir -p "$out/cache/ast"',
    'echo \'{"nodes":[]}\' > "$out/graph.json"',
    'echo "<html></html>" > "$out/graph.html"',
    'echo "# report" > "$out/GRAPH_REPORT.md"',
    'echo "{}" > "$out/cache/stat-index.json"',
    `exit ${code}`,
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aura-graphify-project-'));
  writeFileSync(join(dir, 'a.txt'), 'alpha\n');
  return dir;
}

async function settle(id: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const { phase } = graphifyStatus(id);
    if (phase === 'done' || phase === 'error') return phase;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('graphify run did not settle');
}

describe('runGraphify — the project root is left as it was', () => {
  it('copies the artifacts into the AURA home and removes the graphify-out it created', async () => {
    process.env.GRAPHIFY_BIN = fakeGraphify(0);
    const dir = project();
    runGraphify('proj-clean', dir);
    expect(await settle('proj-clean')).toBe('done');
    expect(readdirSync(dir)).toEqual(['a.txt']);
    const home = join(process.env.AURA_HOME!, 'index', 'proj-clean', 'graphify');
    expect(readdirSync(home).sort()).toEqual(['GRAPH_REPORT.md', 'graph.html', 'graph.json']);
  });

  it('removes its own partial output when graphify fails', async () => {
    process.env.GRAPHIFY_BIN = fakeGraphify(3);
    const dir = project();
    runGraphify('proj-failed', dir);
    expect(await settle('proj-failed')).toBe('error');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('never removes a graphify-out that existed before the run', async () => {
    process.env.GRAPHIFY_BIN = fakeGraphify(0);
    const dir = project();
    mkdirSync(join(dir, 'graphify-out'));
    writeFileSync(join(dir, 'graphify-out', 'mine.md'), 'the user\'s own notes\n');
    runGraphify('proj-owned', dir);
    expect(await settle('proj-owned')).toBe('done');
    expect(existsSync(join(dir, 'graphify-out'))).toBe(true);
    expect(readFileSync(join(dir, 'graphify-out', 'mine.md'), 'utf8')).toBe('the user\'s own notes\n');
  });
});
