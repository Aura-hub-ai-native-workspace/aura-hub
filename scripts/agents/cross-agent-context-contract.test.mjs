import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { classifyProcessFailure, clientToolNames, kiloListReportsConnected, providerFailureReason, assertToolEvidence, readStoreSnapshot, validateOpenCodeMcpEntry, verifyStoreDecision, verifyStoreHandoff, verifyStoreReader } from './cross-agent-context-contract.mjs';
import { installSignalAbort, runProcess } from './process-tree.mjs';

const event = (name, status = 'completed', output = 'ok') => JSON.stringify({ type: 'tool_use', part: { tool: name, state: { status, output } } });

test('provider authentication and balance errors from fake CLIs are BLOCKED', async () => {
  const auth = await fakeCli(`process.stderr.write('Authentication failed: sign in required');process.exit(1)`);
  assert.equal(classifyProcessFailure(auth), 'BLOCKED');
  assert.equal(providerFailureReason(auth), 'provider-authentication');
  const balance = await fakeCli(`process.stdout.write(JSON.stringify({type:'error',error:{message:'Payment required: no credits'}})+'\\n');process.exit(1)`);
  assert.equal(classifyProcessFailure(balance), 'BLOCKED');
  assert.equal(classifyProcessFailure({ exitCode: 1, stdout: JSON.stringify({ type: 'session.error', error: { message: 'Payment required: no credits' } }) }), 'BLOCKED');
  assert.equal(classifyProcessFailure({ exitCode: 1, stdout: JSON.stringify({ type: 'error', error: { type: 'provider.free-limit', message: 'Free usage limit reached' } }) }), 'BLOCKED');
  assert.equal(providerFailureReason({ exitCode: 1, stdout: JSON.stringify({ type: 'error', error: { type: 'provider.free-limit', message: 'Free usage limit reached' } }) }), 'provider-balance-or-quota');
});

test('timeout is FAIL and kills the full process group', async () => {
  const r = await childFixture({ timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(classifyProcessFailure(r), 'FAIL');
  assert.equal(await noProcessesRemain(r), true);
});

test('successful CLI exit still reaps a lingering MCP child process', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-success-fixture-'));
  const source = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);process.exit(0);`;
  const result = await runProcess(process.execPath, ['-e', source], { cwd, env: process.env, timeoutMs: 3000 });
  assert.equal(result.exitCode, 0);
  assert.equal(await noProcessesRemain(result), true);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('output draining is bounded when a detached descendant keeps pipes open', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-drain-fixture-'));
  const source = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});process.stdout.write('parent-exit\\n');process.exit(0);`;
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', source], { cwd, env: process.env, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.drainTimedOut, true);
  assert.ok(Date.now() - started < 4000, 'draining must have a finite upper bound');
  assert.equal(await noProcessesRemain(result), true);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('nonzero fake CLI exit is FAIL', async () => {
  const result = await fakeCli(`process.stderr.write('ordinary command failure');process.exit(7)`);
  assert.equal(result.exitCode, 7);
  assert.equal(classifyProcessFailure(result), 'FAIL');
});

test('fake CLI claiming success without a completed MCP call is rejected', async () => {
  const result = await fakeCli(`process.stdout.write('Task complete, saved successfully.\\n')`);
  assert.equal(assertToolEvidence(result.stdout, ['save_context']).ok, false);
  assert.equal(assertToolEvidence(event('save_context', 'running'), ['save_context']).ok, false);
});

test('fake CLI repeating expected text without a persisted store write is rejected', async () => {
  const expected = 'challenge-value-unique';
  const result = await fakeCli(`process.stdout.write(${JSON.stringify(`I wrote ${expected}`)})`);
  assert.equal(result.stdout.includes(expected), true);
  assert.equal(verifyStoreDecision({ contexts: {} }, 'decision-key', expected, 'acceptance-opencode'), false);
});

test('missing or unreadable store is a failed persistence check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-store-fixture-'));
  try {
    assert.throws(() => readStoreSnapshot(path.join(dir, 'missing.json')));
    fs.mkdirSync(path.join(dir, 'store.json'));
    assert.throws(() => readStoreSnapshot(path.join(dir, 'store.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store write failure is rejected even when the model reports a successful write', () => {
  const failedToolEvent = event('save_context', 'completed', 'ERROR: store is read-only');
  assert.equal(assertToolEvidence(failedToolEvent, ['save_context']).ok, false);
  assert.equal(verifyStoreDecision({ contexts: {} }, 'decision-key', 'value', 'acceptance-opencode'), false);
});

test('missing MCP executable is unavailable/BLOCKED', async () => {
  const result = await runProcess('/definitely/not/aura-common-context-mcp', [], { timeoutMs: 1000 });
  assert.equal(result.processError, 'ENOENT');
  assert.equal(classifyProcessFailure(result), 'BLOCKED');
  assert.equal(providerFailureReason(result), 'missing-executable');
});

test('invalid OpenCode MCP config is rejected, and valid isolated config is accepted', () => {
  assert.equal(validateOpenCodeMcpEntry({ command: ['/wrong'], environment: {} }, '/server', '/tmp/store.json', 'identity'), false);
  assert.equal(validateOpenCodeMcpEntry({ command: ['/server'], environment: { CONTEXT_MCP_FILE: '/tmp/store.json', CONTEXT_MCP_AGENT_ID: 'identity' } }, '/server', '/tmp/store.json', 'identity'), true);
});

test('MCP clients expose observed server prefixes in their permission tool names', () => {
  const tools = ['load_context', 'save_context', 'search_context', 'handoff'];
  assert.deepEqual(clientToolNames('common-context', tools, 'opencode'), tools.map((name) => `common_context_${name}`));
  assert.deepEqual(clientToolNames('common-context', tools, 'kilo'), tools.map((name) => `common-context_${name}`));
});

test('reader verification requires a newly created session for this exact step', () => {
  const earlier = { sessions: [{ id: 'session-kilo-old', agent: 'acceptance-kilo', title: 'Earlier Kilo session' }] };
  const unchanged = { sessions: [...earlier.sessions] };
  const later = { sessions: [...earlier.sessions, { id: 'session-open-code', agent: 'acceptance-opencode', title: 'In progress...' }] };
  assert.equal(verifyStoreReader(earlier, unchanged, 'acceptance-kilo'), false, 'an earlier Kilo session cannot satisfy a later retrieval');
  assert.equal(verifyStoreReader(earlier, later, 'acceptance-kilo'), false, 'another agent session cannot satisfy the reader step');
  const freshKilo = { sessions: [...unchanged.sessions, { id: 'session-kilo-new', agent: 'acceptance-kilo', title: 'In progress...' }] };
  assert.equal(verifyStoreReader(unchanged, freshKilo, 'acceptance-kilo'), true);
});

test('handoff verification requires the exact recipient', () => {
  const store = { sessions: [{ id: 'h1', agent: 'acceptance-kilo', status: 'completed', accomplished: 'payload', title: 'Handoff to acceptance-opencode: verified' }] };
  assert.equal(verifyStoreHandoff(store, 'payload', 'acceptance-kilo', 'acceptance-opencode'), true);
  assert.equal(verifyStoreHandoff(store, 'payload', 'acceptance-kilo', 'acceptance-other'), false);
});

test('missing required MCP tool event is rejected', () => {
  const result = assertToolEvidence(`${event('load_context')}\n${event('search_context')}`, ['load_context', 'save_context']);
  assert.deepEqual(result.missing, ['save_context']);
});

test('MCP tool invocation error is not accepted as a completed call', () => {
  assert.equal(assertToolEvidence(event('save_context', 'completed', 'ERROR: store is read-only'), ['save_context']).ok, false);
});

test('repeated Ctrl-C signal terminates the CLI process group and cleans temporary data', async (t) => {
  if (process.platform === 'win32') return t.skip('Node cannot reliably synthesize a console Ctrl-C event on Windows');
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-signal-fixture-'));
  const cleanupDir = path.join(childDir, 'temporary-auth-and-store');
  fs.mkdirSync(cleanupDir);
  const processTreeUrl = new URL('./process-tree.mjs', import.meta.url).href;
  const source = `import fs from'node:fs';import{installSignalAbort,runProcess}from${JSON.stringify(processTreeUrl)};const c=new AbortController();installSignalAbort(c);try{const r=await runProcess(process.execPath,['-e',${JSON.stringify(startChildSource)}],{timeoutMs:10000,signal:c.signal});console.log(JSON.stringify({pid:r.pid,childPid:Number(r.stdout.trim()),interrupted:r.interrupted}));}finally{fs.rmSync(${JSON.stringify(cleanupDir)},{recursive:true,force:true})}`;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: childDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  harness.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  harness.kill('SIGINT');
  harness.kill('SIGINT');
  const result = await Promise.race([
    new Promise((resolve) => harness.once('close', (code) => resolve({ code }))),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ]);
  assert.equal(result.timeout, undefined, 'signal handling did not hang');
  const recorded = JSON.parse(stdout.trim());
  assert.equal(recorded.interrupted, true);
  assert.equal(fs.existsSync(cleanupDir), false);
  assert.equal(await noProcessesRemain({ pid: recorded.pid, stdout: String(recorded.childPid) }), true);
  fs.rmSync(childDir, { recursive: true, force: true });
});

test('terminal hang-up terminates the CLI process group and cleans temporary data', async (t) => {
  if (process.platform === 'win32') return t.skip('SIGHUP is not supported on Windows');
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-hup-fixture-'));
  const cleanupDir = path.join(childDir, 'temporary-data');
  fs.mkdirSync(cleanupDir);
  const processTreeUrl = new URL('./process-tree.mjs', import.meta.url).href;
  const source = `import fs from'node:fs';import{installSignalAbort,runProcess}from${JSON.stringify(processTreeUrl)};const c=new AbortController();installSignalAbort(c);try{const r=await runProcess(process.execPath,['-e',${JSON.stringify(startChildSource)}],{timeoutMs:10000,signal:c.signal});console.log(JSON.stringify({pid:r.pid,childPid:Number(r.stdout.trim()),interrupted:r.interrupted}));}finally{fs.rmSync(${JSON.stringify(cleanupDir)},{recursive:true,force:true})}`;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: childDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  harness.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  harness.kill('SIGHUP');
  const result = await Promise.race([
    new Promise((resolve) => harness.once('close', (code) => resolve({ code }))),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ]);
  assert.equal(result.timeout, undefined);
  const recorded = JSON.parse(stdout.trim());
  assert.equal(recorded.interrupted, true);
  assert.equal(fs.existsSync(cleanupDir), false);
  assert.equal(await noProcessesRemain({ pid: recorded.pid, stdout: String(recorded.childPid) }), true);
  fs.rmSync(childDir, { recursive: true, force: true });
});

const startChildSource = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`;

async function fakeCli(source) {
  return runProcess(process.execPath, ['-e', source], { timeoutMs: 3000, env: process.env });
}

function startChildFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-process-fixture-'));
  return { cwd, args: ['-e', startChildSource] };
}

async function childFixture({ timeoutMs }) {
  const fixture = startChildFixture();
  const r = await runProcess(process.execPath, fixture.args, { cwd: fixture.cwd, env: process.env, timeoutMs });
  fs.rmSync(fixture.cwd, { recursive: true, force: true });
  return r;
}

async function noProcessesRemain(result) {
  const childPid = Number(String(result.stdout ?? '').trim().split(/\s+/).pop());
  const ids = [result.pid, Number.isInteger(childPid) ? childPid : null].filter(Boolean);
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    if (ids.every((pid) => !processAlive(pid)) && (process.platform === 'win32' || !(await groupAlive(result.pid)))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ids.every((pid) => !processAlive(pid)) && (process.platform === 'win32' || !(await groupAlive(result.pid)));
}

function processAlive(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 && r.stdout.includes(`"${pid}"`);
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

test('kilo mcp list: only an exact, explicitly connected common-context line counts', () => {
  const box = (lines) => ['┌  MCP Servers', '│', ...lines, '│', '└  1 server(s)'].join('\n');
  // The nine reviewed cases. Real Kilo 7.5.14 output for the first four.
  const cases = [
    ['real: connected', box(['●  ✓ common-context connected', '│      /usr/bin/common-context-mcp']), true],
    ['real: failed (connection closed)', box(['●  ✗ common-context failed', '│      MCP error -32000: Connection closed', '│      false']), false],
    ['real: failed (handshake timeout)', box(['●  ✗ common-context failed', '│      Operation timed out after 30000ms', '│      sleep 300']), false],
    ['real: disabled', box(['●  ○ common-context disabled', '│      /usr/bin/common-context-mcp']), false],
    ['disconnected', box(['●  ✗ common-context disconnected']), false],
    ['failed, another server connected later', box(['●  ✗ common-context failed', '│      ENOENT', '●  ✓ playwright connected']), false],
    ['failed, error text contains "connected"', box(['●  ✗ common-context failed', '│      server not connected yet']), false],
    ['a server whose name starts with common-context', box(['●  ✓ common-context-extra connected']), false],
    ['name only in a path, another server connected', box(['●  ✗ ctx failed', '│      /opt/common-context/bin/x', '●  ✓ other connected']), false],
  ];
  for (const [label, output, expected] of cases) {
    assert.equal(kiloListReportsConnected(output), expected, label);
    // The loose pattern this replaces accepted every one of these lines with "connected" in them.
  }
  assert.equal(kiloListReportsConnected('\u001b[32m●  ✓ common-context connected\u001b[0m'), true, 'colour codes are ignored');
  assert.equal(kiloListReportsConnected(''), false);
  assert.equal(kiloListReportsConnected(undefined), false);
});
