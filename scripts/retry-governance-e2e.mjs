/**
 * retry-governance-e2e — REAL governed execution on a disposable fixture.
 * ==================================================================
 *   node scripts/run-ts.mjs scripts/retry-governance-e2e.mjs
 *
 * Uses the REAL `git.push` executor from `@aura/ai-service/fabric/executors`
 * (the production implementation, not a stand-in) through a REAL
 * `CapabilityFabric`, against REAL git in a disposable /tmp fixture with a
 * disposable local bare remote. No real user project is touched.
 *
 *   A — a real governed push succeeds end to end, is attested
 *       `effectStarted: true`, and is audited.
 *   B — the first attempt of an irreversible push is forced into a
 *       genuinely uncertain/transient result: the transport points at a
 *       local TCP server that accepts the connection and never answers,
 *       so `git push` is killed by its timeout mid-request. The real
 *       executor attests `effectStarted: true` and the governed retry is
 *       withheld: the invocation parks as awaiting-approval with rule
 *       `irreversible-retry`, and the audit records the decision.
 *   C — after a human grant the retry executes exactly one more time and,
 *       the transport still being uncertain, parks again with a fresh
 *       request instead of looping.
 *
 * This exercises the real executor and the real governance decision on a
 * real transient transport failure. It does NOT fake a partial effect on
 * a real remote: the grant-then-succeed path is proven deterministically
 * in retry-governance-verify.mjs, and the "effect may have happened"
 * state here is a genuine uncertain transport, honestly attested.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { CapabilityFabric } from '@aura/capability-fabric';
import { gitPush } from '@aura/ai-service/fabric/executors';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`);
  return r;
}
const git = (cmd, argsOrOpts = [], opts = {}) => {
  const args = Array.isArray(argsOrOpts) ? argsOrOpts : [];
  const options = Array.isArray(argsOrOpts) ? opts : (argsOrOpts ?? opts);
  return sh('git', [cmd, ...args], options);
};

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-retry-e2e-'));
  const repo = path.join(home, 'repo');
  const bare = path.join(home, 'remote.git');
  console.log(`[e2e] fixture under ${home}`);
  fs.mkdirSync(repo, { recursive: true });
  git('init', ['--bare', bare]);
  git('init', { cwd: repo });
  git('checkout', ['-b', 'main'], { cwd: repo });
  git('config', ['user.email', 'e2e@aura.local'], { cwd: repo });
  git('config', ['user.name', 'AURA E2E'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'file.txt'), 'governed push fixture\n');
  git('add', ['.'], { cwd: repo });
  git('commit', ['-m', 'initial'], { cwd: repo });
  git('remote', ['add', 'origin', bare], { cwd: repo });

  const fabric = new CapabilityFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'git-node', name: 'Git', capabilities: ['source-control'] } }),
    requestApproval: async (request, context) => {
      const approved = new Set(context.approvedCapabilities ?? []);
      return request.items.every((item) => approved.has(item.capabilityId));
    },
  });
  fabric.setPolicy({
    byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
    overrides: {},
    allowAutonomous: true,
  });
  // Count REAL executor invocations across the whole session: a parked
  // invocation is not an execution, and `attempts` resets per invocation.
  let realRuns = 0;
  fabric.register({
    ...gitPush,
    run: async (inv) => {
      realRuns += 1;
      return gitPush.run(inv);
    },
  });

  const ctx = (extra = {}) => ({
    actor: { kind: 'agent', id: 'e2e-agent' },
    projectId: 'e2e-fixture',
    cwd: repo,
    missionId: 'e2e-mission',
    taskId: 'e2e-task',
    approvedCapabilities: ['git.push'],
    ...extra,
  });

  /* ── A. a real governed push succeeds end to end ───────────────── */
  console.log('\n[A] real governed git.push against a disposable local bare remote');
  const a = await fabric.invoke('git.push', { remote: 'origin', branch: 'main' }, ctx());
  check('real git.push succeeded', a.outcome === 'succeeded', a.detail);
  check('real executor ran exactly once for the success', realRuns === 1, `realRuns=${realRuns}`);
  check('effectStarted attested true', a.effectStarted === true, String(a.effectStarted));
  check('irreversible flag carried', a.irreversible === true, String(a.irreversible));
  const head = git('rev-parse', ['--verify', 'main'], { cwd: bare }).stdout.trim();
  check('the disposable remote actually received the commit', head.length > 0, head);
  check('the push is audited', fabric.audit().some((r) => r.invocationId === a.invocationId && r.outcome === 'succeeded' && r.capabilityId === 'git.push'));

  /* ── B + C: force the first attempt into an uncertain/transient result.
     ONE hanging server stays alive across both, so the grant-then-re-run
     in C faces the SAME genuinely uncertain transport. ─────────────── */
  console.log('\n[B] real first attempt forced into an uncertain transport result');
  const server = net.createServer(() => { /* accept and never answer */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  git('remote', ['add', 'hang', `http://127.0.0.1:${port}/repo.git`], { cwd: repo });

  console.log('  … pushing to a server that accepts but never answers (executor timeout will kill it)');
  const b = await fabric.invoke('git.push', { remote: 'hang', branch: 'main' }, ctx());
  check('uncertain irreversible attempt parked as awaiting-approval', b.outcome === 'awaiting-approval', b.detail);
  check('real executor ran exactly once for this attempt (no automatic retry)', realRuns === 2, `realRuns=${realRuns}`);
  check('invocation attempt count is 1', b.attempts === 1, `attempts=${b.attempts}`);
  check('effectStarted attested true (transport touched, result unknown)', b.effectStarted === true, String(b.effectStarted));
  const pendingB = fabric.pendingApprovals();
  check('a pending approval request was created', pendingB.length === 1, `pending=${pendingB.length}`);
  check('approval rule is irreversible-retry', pendingB[0]?.rule === 'irreversible-retry', pendingB[0]?.rule);
  check('the retry decision is in the audit', fabric.audit().some((r) => r.invocationId === b.invocationId && r.retry?.withheld === true && r.decisionRule === 'irreversible-retry'));

  console.log('\n[C] grant → exactly one more real attempt, then park again');
  fabric.decideApproval(pendingB[0].id, true, 'user', 'one more attempt');
  console.log('  … the granted re-run pushes against the same silent server');
  const c = await fabric.invoke('git.push', { remote: 'hang', branch: 'main' }, ctx());
  check('granted retry ran exactly one more real attempt', realRuns === 3, `realRuns=${realRuns}`);
  check('still uncertain → parked again, no auto-loop', c.outcome === 'awaiting-approval' && fabric.pendingApprovals().length === 1, `outcome=${c.outcome} pending=${fabric.pendingApprovals().length}`);
  check('the second gate is a FRESH approval question', fabric.pendingApprovals()[0]?.id !== pendingB[0].id, `${fabric.pendingApprovals()[0]?.id} vs ${pendingB[0].id}`);
  // The killed git processes leave their TCP connections open, which would
  // otherwise keep the server handle alive and the process from exiting.
  server.closeAllConnections?.();
  server.close();

  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\nretry-governance-e2e: ${passed} passed · ${failed} failed`);
  // A killed `git push` over HTTP can leave an orphaned `git-remote-http`
  // child holding the execFile pipe open, which keeps this Node process
  // alive even though everything has been asserted. In production the
  // service is long-lived, so this is purely a harness-exit artifact;
  // exiting explicitly is deliberate and honest.
  process.exit(failed > 0 ? 1 : 0);
}

await main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
