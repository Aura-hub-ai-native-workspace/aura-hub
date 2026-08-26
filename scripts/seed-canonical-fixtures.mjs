#!/usr/bin/env node
/**
 * seed-canonical-fixtures — create REAL workflows through the canonical
 * Python API so browser suites have material to drive. Nothing here is
 * mocked: every fixture goes through POST /workflows and is validated by
 * the backend like any user-authored workflow.
 *
 * Usage: node scripts/seed-canonical-fixtures.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? process.env.AI_URL ?? 'http://localhost:4319';

async function api(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${p}: ${res.status} ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(`${p}: ${res.status} ${json.error ?? ''}`);
  return json;
}

let _row = 0;
const node = (id, type, config = {}) =>
  ({ id, type, x: 80, y: 80 + (_row++) * 170, config });

const FIXTURES = [
  {
    name: 'Seeded — Release Notes (read-only)',
    description: 'Local steps with inspector-covered types.',
    nodes: [
      node('n1', 'shell-command', { command: 'echo seeded' }),
      node('n2', 'variables', { vars: { source: 'seeded' } }),
      node('n3', 'delay', { ms: 50 }),
      node('n4', 'output', { title: 'Release notes input' }),
    ],
    edges: [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' }, { source: 'n3', target: 'n4' }],
  },
  {
    name: 'Seeded — Empty Sketch',
    description: 'Zero nodes — exercises the empty-state surface.',
    nodes: [],
    edges: [],
  },
  {
    name: 'Seeded — Governed Publish',
    description: 'Shell + file-write steps so policy/dry-run has governed nodes.',
    nodes: [
      node('g0', 'shell-command', { command: 'echo publish-seed' }),
      node('g1', 'shell-command', { command: 'rm -rf ./build' }),
      node('g2', 'export-file', { path: 'reports/publish.md', text: '# Publish report' }),
    ],
    edges: [{ source: 'g0', target: 'g1' }, { source: 'g1', target: 'g2' }],
  },
];

const { workflows } = await api('/workflows');
const existing = new Set(workflows.map((w) => w.name));
let created = 0;
for (const fx of FIXTURES) {
  if (existing.has(fx.name)) { console.log(`skip (exists): ${fx.name}`); continue; }
  const wf = await api('/workflows', {
    name: fx.name,
    description: fx.description,
    category: 'seeded',
    nodes: fx.nodes,
    edges: fx.edges,
    vars: {},
    inputs: {},
  });
  created += 1;
  console.log(`created: ${wf.name} (${wf.id}, ${wf.nodeCount ?? wf.nodes.length} nodes)`);
}
console.log(`done — ${created} created`);
