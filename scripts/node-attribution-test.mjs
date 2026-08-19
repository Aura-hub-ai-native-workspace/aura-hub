/**
 * node-attribution-test — proves activity lands on the EXACT node.
 * ==================================================================
 * Only OpenCode is installed on this machine, so rather than pretend
 * another agent executable exists, this drives the projection layer
 * directly with controlled inputs built from the REAL catalogue.
 *
 * Nothing external is executed and nothing is mocked in the code under
 * test: `projectNodeActivity` is bundled from source and given the same
 * shapes the running app gives it — a real `ExecutionDag`, real capability
 * bindings, and real catalogue capabilities.
 *
 * The claim under test: when six nodes can serve `coding-agent`, the one
 * that actually ran is the only one that lights.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = '/home/Groot/aura-hub';
const API = process.env.HUB_API ?? 'http://localhost:4319';
const out = path.join(mkdtempSync(path.join(tmpdir(), 'attr-test-')), 'hubPhase.mjs');

execFileSync('npx', [
  'esbuild', `${ROOT}/apps/desktop/src/workspace/hubPhase.ts`,
  '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
], { cwd: ROOT, stdio: 'pipe' });

const { projectNodeActivity, buildCapabilityNodeMap } = await import(out);

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

/* ── real catalogue + real manifest, from the running service ────── */
const catalogue = (await (await fetch(`${API}/environment/catalog`)).json()).catalog;
const caps = (await (await fetch(`${API}/fabric/capabilities`)).json()).capabilities;
const capabilityToNode = buildCapabilityNodeMap(caps);

const agentProviders = catalogue
  .filter((e) => (e.capabilities ?? []).includes('coding-agent')).map((e) => e.id);
console.log(`      real coding-agent providers: ${agentProviders.join(', ')}`);
console.log(`      agent.delegate → ${capabilityToNode.get('agent.delegate')}`);

/** An EnvironmentNode shaped like the store's, using the real entry. */
const nodeFixture = (id) => {
  const entry = catalogue.find((e) => e.id === id);
  if (!entry) throw new Error(`no catalogue entry for ${id}`);
  return { id, entry, connected: true, health: { status: 'available', detail: '', checkedAt: '' }, log: [] };
};

/** A mission with one in-flight task, optionally attributed to a node. */
const missionFixture = (taskStatus, nodeId) => ({
  id: 'mission-fixture',
  taskRuns: nodeId ? [{ taskId: 't1', status: 'pending', proposal: null, updatedAt: '', nodeId }] : [],
  execution: {
    status: 'running',
    dag: { nodes: [{ id: 't1', status: taskStatus }], edges: [], criticalPath: [], batches: [], hasCycle: false },
  },
});

const annotationFor = (capabilityId) => ({
  assumptions: [], openQuestions: [], requiredCapabilities: [capabilityId],
  bindings: [{ taskId: 't1', requires: [capabilityId], rationale: '', risk: 'high', unsupported: [] }],
  gaps: [],
});

// All six coding agents placed at once — the ambiguous case that matters.
const allAgents = agentProviders.map(nodeFixture);
const lit = (p) => [...p.byNode.entries()].map(([k, v]) => `${k}:${v}`).sort();

/* ── 1. the node that ran is the only one that lights ────────────── */
for (const who of ['opencode', 'claude-code', 'cursor']) {
  const p = projectNodeActivity(
    missionFixture('review', who), annotationFor('agent.delegate'), allAgents, [], capabilityToNode,
  );
  check(`1. ${who} executes → ONLY ${who} lights`,
    p.byNode.size === 1 && p.byNode.get(who) === 'verifying',
    `lit=[${lit(p).join(', ')}] of ${allAgents.length} placed agents`);
}

/* ── 2. no reported node + several candidates → no guess ─────────── */
{
  const p = projectNodeActivity(
    missionFixture('review'), annotationFor('agent.delegate'), allAgents, [], capabilityToNode,
  );
  check('2. unreported node with many candidates lights NOTHING',
    p.byNode.size === 0, `lit=[${lit(p).join(', ')}]`);
  check('2b. it is reported as unattributed instead of guessed',
    p.unattributed.length === 1
    && p.unattributed[0].capabilityId === 'agent.delegate'
    && p.unattributed[0].candidates.length === allAgents.length,
    `candidates=${p.unattributed[0]?.candidates?.join(',')}`);
}

/* ── 3. a single provider still lights (no regression) ───────────── */
{
  const gitNode = nodeFixture('git');
  const p = projectNodeActivity(
    missionFixture('review'), annotationFor('git.diff'), [gitNode, ...allAgents], [], capabilityToNode,
  );
  check('3. one unambiguous provider still lights (git.diff → git)',
    p.byNode.size === 1 && p.byNode.get('git') === 'verifying' && p.unattributed.length === 0,
    `lit=[${lit(p).join(', ')}]`);
}

/* ── 4. a reported node that is not placed lights nothing ────────── */
{
  const p = projectNodeActivity(
    missionFixture('review', 'claude-code'), annotationFor('agent.delegate'),
    [nodeFixture('opencode')], [], capabilityToNode,
  );
  check('4. work reported on a node that is not on the canvas lights nothing',
    p.byNode.size === 0, `lit=[${lit(p).join(', ')}]`);
}

/* ── 5. attribution beats capability, it never widens it ─────────── */
{
  const p = projectNodeActivity(
    missionFixture('running', 'opencode'), annotationFor('agent.delegate'), allAgents, [], capabilityToNode,
  );
  check('5. a reported node ends the matter — no capability-level widening',
    p.byNode.size === 1 && p.byNode.get('opencode') === 'running' && p.unattributed.length === 0,
    `lit=[${lit(p).join(', ')}]`);
}

/* ── 6. terminal work never lights the agents ────────────────────── */
{
  const terminalProviders = catalogue
    .filter((e) => (e.capabilities ?? []).includes('terminal')).map((e) => e.id);
  const placed = [...new Set([...agentProviders, ...terminalProviders])].map(nodeFixture);
  const p = projectNodeActivity(
    missionFixture('review'), annotationFor('terminal.execute'), placed, [], capabilityToNode,
  );
  check('6. an unattributed terminal task lights nothing rather than every shell',
    p.byNode.size === 0 && p.unattributed.length === 1,
    `candidates=${p.unattributed[0]?.candidates?.length} lit=[${lit(p).join(', ')}]`);
}

console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
