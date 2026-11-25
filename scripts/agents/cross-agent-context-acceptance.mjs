#!/usr/bin/env node
/** Live, isolated OpenCode ↔ Kilo Common Context MCP acceptance. */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertChallengeReturned, assertToolEvidence, classifyProcessFailure, clientToolNames, kiloListReportsConnected, providerFailureReason, readStoreSnapshot, structuredEventSummary, validateOpenCodeMcpEntry, verifyStoreDecision, verifyStoreHandoff, verifyStoreReader } from './cross-agent-context-contract.mjs';
import { installSignalAbort, runProcess, terminateProcessTree } from './process-tree.mjs';

const runId = `AURA_XAGENT_${randomUUID().replaceAll('-', '').toUpperCase()}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cross-agent-mcp-'));
const project = path.join(root, 'project');
const home = path.join(root, 'home');
const storeFile = path.join(project, 'store.json');
const timeoutMs = Number(process.env.AURA_AGENT_ACCEPTANCE_TIMEOUT_MS ?? 240_000);
const abortController = new AbortController();
let interrupted = null;
const sensitiveValues = new Set();
const uninstallSignalHandlers = installSignalAbort(abortController, (signal) => { interrupted = signal; });
const acceptanceAgentId = (label) => ['OpenCode', 'opencode', 'acceptance-opencode'].includes(label) ? 'acceptance-opencode' : ['Kilo', 'kilo', 'acceptance-kilo'].includes(label) ? 'acceptance-kilo' : null;

const redacted = (value) => String(value ?? '')
  .replace(new RegExp([...sensitiveValues].filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)', 'g'), '[TEST VALUE REDACTED]')
  .replace(/(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+\S+)/gi, '[REDACTED]')
  .replace(/https?:\/\/\S+/gi, '[provider link omitted]');
const which = (bin) => (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, bin)).find((p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function command(bin, args, env, { cwd = project, cap = 8000 } = {}) {
  if (interrupted) throw Object.assign(new Error(`acceptance interrupted by ${interrupted}`), { status: 'FAIL', step: 'interrupted' });
  const r = await runProcess(bin, args, { cwd, env, timeoutMs, signal: abortController.signal });
  if (r.stdout.length + r.stderr.length > cap) {
    r.stdout = r.stdout.slice(-cap);
    r.stderr = r.stderr.slice(-cap);
  }
  return r;
}

function requireStep(result, who, requiredTools, step) {
  requireProcess(result, who, step);
  const evidence = assertToolEvidence(result.stdout, requiredTools);
  if (!evidence.ok) throw Object.assign(new Error(`${step}: structured CLI output did not prove MCP call(s): ${evidence.missing.join(', ')}`), {
    status: 'FAIL', step, executable: path.basename(result.bin), exitStatus: result.exitCode,
    agentId: acceptanceAgentId(who),
    processError: null, missingToolEvents: evidence.missing, observedToolEvents: evidence.actual,
    eventSummary: structuredEventSummary(result.stdout), diagnostic: redacted(result.stderr.slice(-600)),
  });
  return evidence.actual.map((name) => ({ name }));
}

function requireProcess(result, who, step) {
  if (result.processError || result.timedOut || result.exitCode !== 0) {
    const status = classifyProcessFailure(result);
    throw Object.assign(new Error(`${step}: ${who} process did not complete successfully`), {
      status: status ?? 'FAIL', step, executable: path.basename(result.bin), exitStatus: result.exitCode,
      agentId: acceptanceAgentId(who),
      processError: result.processError, timedOut: result.timedOut, providerReason: providerFailureReason(result),
      diagnostic: redacted((result.stderr || result.stdout).slice(-1200)),
    });
  }
}

function readStore() {
  if (!fs.existsSync(storeFile)) throw Object.assign(new Error('isolated context store was not created'), { status: 'FAIL', step: 'store-read' });
  try { return readStoreSnapshot(storeFile); }
  catch (error) { throw Object.assign(new Error(`isolated store is unreadable: ${error.message}`), { status: 'FAIL', step: 'store-read' }); }
}
function readStoreBaseline() {
  return fs.existsSync(storeFile) ? readStore() : { contexts: {}, sessions: [], failures: [], claims: {}, broadcasts: [] };
}

function verifyDecision(key, value, writer) {
  const store = readStore();
  const entry = store.contexts?.[key];
  if (!verifyStoreDecision(store, key, value, writer)) {
    throw Object.assign(new Error('decision record, value, or writer identity did not match'), { status: 'FAIL', step: 'decision-store-verification', agentId: acceptanceAgentId(writer) });
  }
  return store;
}

function verifyHandoff(store, value, writer, recipient) {
  if (!verifyStoreHandoff(store, value, writer, recipient)) throw Object.assign(new Error('handoff record, writer identity, or recipient did not match'), { status: 'FAIL', step: 'handoff-store-verification', agentId: acceptanceAgentId(writer) });
  return store.sessions.find((s) => s.agent === writer && s.status === 'completed' && s.accomplished === value && s.title.startsWith(`Handoff to ${recipient}:`));
}

function verifyReader(beforeStore, afterStore, agentId, step) {
  if (!verifyStoreReader(beforeStore, afterStore, agentId)) {
    throw Object.assign(new Error(`store has no new load_context session for ${agentId} during ${step}`), { status: 'FAIL', step: 'reader-store-verification', agentId: acceptanceAgentId(agentId) });
  }
}

function agentPrompt({ task, identifier }) {
  return `Use only the configured Common Context MCP tools for all context access. Do not use shell, filesystem, direct file reads, or another MCP server. Call load_context first. Perform the requested operation, then give a concise result. Include this run identifier in your response: ${identifier}.` + `\n\n${task}`;
}

function opencodeArgs(model, message, serverUrl) {
  // --server is a global flag; keep it before the subcommand so the CLI
  // cannot fall back to the user's background service.
  return ['--server', serverUrl, 'run', '--format', 'json', '--auto', '--model', model, message];
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/**
 * Runs `fn` against a private, isolated OpenCode server whose own MCP client
 * has connected to Common Context.
 *
 * OpenCode 2.x connects a location's MCP servers asynchronously after the
 * first request for that location. `opencode --standalone mcp list` asks about
 * 40 ms after boot and exits, so it always prints "No MCP servers configured";
 * a prompt sent that early could likewise reach the model without the tools.
 * A private `serve` under the isolated HOME keeps the same isolation as
 * `--standalone` (never the user's background service) and lets the runner
 * wait for the connection. Each call starts a fresh server and MCP child.
 */
async function withOpenCodeServer(bin, env, step, fn) {
  if (interrupted) throw Object.assign(new Error(`acceptance interrupted by ${interrupted}`), { status: 'FAIL', step: 'interrupted' });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serverEnv = { ...env, OPENCODE_PASSWORD: randomBytes(24).toString('hex') };
  sensitiveValues.add(serverEnv.OPENCODE_PASSWORD);
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'info'], {
    cwd: project, env: serverEnv, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  });
  let log = '';
  let spawnError = null;
  child.stderr.on('data', (chunk) => { log = (log + chunk.toString('utf8')).slice(-200_000); });
  child.on('error', (error) => { spawnError = error.code ?? error.message; });
  const stop = () => { void terminateProcessTree(child, 300); };
  abortController.signal.addEventListener('abort', stop, { once: true });
  try {
    const deadline = Date.now() + 30_000;
    let listing = '';
    let tools = null;
    while (Date.now() < deadline && !interrupted && !spawnError && child.exitCode === null) {
      const r = await runProcess(bin, ['--server', url, 'mcp', 'list'], { cwd: project, env: serverEnv, timeoutMs: 15_000, signal: abortController.signal });
      listing = `${r.stdout}\n${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
      tools = Number(log.match(/mcp connected[^\n]*server=common-context tools=(\d+)/)?.[1] ?? NaN);
      if (r.exitCode === 0 && /common-context\s+connected/.test(listing) && tools > 0) break;
      tools = null;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!tools) {
      const lines = log.split(/\r?\n/).filter((line) => /mcp|common-context|error/i.test(line)).join('\n');
      throw Object.assign(new Error('OpenCode private server did not connect its MCP client to common-context and discover tools'), {
        status: 'FAIL', step: `${step}-mcp-connectivity`, agentId: 'acceptance-opencode', executable: 'opencode', exitStatus: child.exitCode, processError: spawnError,
        diagnostic: redacted(`${listing.slice(0, 400)}\n${lines.slice(-900)}`),
      });
    }
    return await fn({ url, env: serverEnv, tools });
  } finally {
    abortController.signal.removeEventListener('abort', stop);
    await terminateProcessTree(child, 300);
  }
}
function kiloArgs(model, projectDir, message) {
  return ['run', '--format', 'json', '--dir', projectDir, '--model', model, message];
}

function configureOpenCode(bin, env, serverBin, storePath, identity) {
  // `mcp add` only writes the isolated config. OpenCode v2.2.6 rejects
  // `--standalone` on this subcommand; every `run` call uses that flag.
  const r = spawnCapturedSync(bin, ['mcp', 'add', '--env', `CONTEXT_MCP_FILE=${storePath}`, '--env', `CONTEXT_MCP_AGENT_ID=${identity}`, 'common-context', '--', serverBin], env, project);
  if (r.error || r.status !== 0) throw Object.assign(new Error('OpenCode could not write the isolated MCP configuration'), { status: 'FAIL', step: 'opencode-config', processError: r.error?.code ?? null, exitStatus: r.status, diagnostic: redacted(r.stderr.slice(-800)) });
  const file = path.join(project, 'opencode.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = parsed.mcp?.servers?.['common-context'];
  if (!validateOpenCodeMcpEntry(entry, serverBin, storePath, identity)) {
    throw Object.assign(new Error('OpenCode CLI generated an unexpected MCP config; isolated store env was not confirmed'), { status: 'FAIL', step: 'opencode-config' });
  }
  // OpenCode v2 uses permission actions. Deny Code Mode and non-MCP tools so
  // the acceptance can prove direct Common Context calls without shell/file
  // fallbacks, while allowing only the calls needed by this protocol.
  parsed['$schema'] = 'https://opencode.ai/config.json';
  const opencodeToolNames = clientToolNames('common-context', ['load_context', 'save_context', 'search_context', 'handoff'], 'opencode');
  parsed.permissions = [
    ...['execute', 'shell', 'read', 'edit', 'glob', 'grep'].map((action) => ({ action, resource: '*', effect: 'deny' })),
    // OpenCode normalizes the server's hyphen to an underscore in permission
    // action names. Allow only the names emitted by this client's convention.
    ...opencodeToolNames.map((tool) => ({ action: tool, resource: '*', effect: 'allow' })),
  ];
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  const verified = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!validateOpenCodeMcpEntry(verified.mcp?.servers?.['common-context'], serverBin, storePath, identity)
    || !verified.permissions?.some((p) => p.action === 'execute' && p.effect === 'deny')) {
    throw Object.assign(new Error('OpenCode isolated configuration failed its MCP-only permissions check'), { status: 'FAIL', step: 'opencode-config' });
  }
}

function findOpenCodeConfig(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.mcp?.servers?.['common-context']) return value;
  for (const child of Object.values(value)) {
    const match = findOpenCodeConfig(child);
    if (match) return match;
  }
  return null;
}

function verifyOpenCodeRuntimeConfig(output, serverBin, storePath, identity) {
  let parsed;
  try { parsed = JSON.parse(output); }
  catch { throw Object.assign(new Error('OpenCode debug config did not return structured JSON'), { status: 'FAIL', step: 'opencode-runtime-config' }); }
  const config = findOpenCodeConfig(parsed);
  const effects = new Map((config?.permissions ?? []).map((rule) => [rule.action, rule.effect]));
  const requiredMcp = clientToolNames('common-context', ['load_context', 'save_context', 'search_context', 'handoff'], 'opencode');
  if (!config || !validateOpenCodeMcpEntry(config.mcp?.servers?.['common-context'], serverBin, storePath, identity)
    || effects.get('execute') !== 'deny'
    || requiredMcp.some((tool) => effects.get(tool) !== 'allow')) {
    throw Object.assign(new Error('OpenCode runtime did not load the isolated MCP configuration and tool permissions'), { status: 'FAIL', step: 'opencode-runtime-config' });
  }
}

function spawnCapturedSync(bin, args, env, cwd) {
  // Config creation is a bounded, noninteractive local CLI operation.
  const r = spawnSync(bin, args, { env, cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true });
  return { ...r, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeKiloConfig(file, serverBin, storePath, identity) {
  const kiloToolNames = clientToolNames('common-context', ['load_context', 'save_context', 'search_context', 'handoff'], 'kilo');
  fs.writeFileSync(file, JSON.stringify({
    '$schema': 'https://app.kilo.ai/config.json',
    permission: {
      '*': 'deny',
      ...Object.fromEntries(kiloToolNames.map((tool) => [tool, 'allow'])),
    },
    mcp: { 'common-context': {
      type: 'local', command: [serverBin], environment: { CONTEXT_MCP_FILE: storePath, CONTEXT_MCP_AGENT_ID: identity },
    } },
  }, null, 2) + '\n', { mode: 0o600 });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = parsed.mcp?.['common-context'];
  if (!entry?.command?.includes(serverBin) || entry.environment?.CONTEXT_MCP_FILE !== storePath || entry.environment?.CONTEXT_MCP_AGENT_ID !== identity
    || parsed.permission?.['*'] !== 'deny' || kiloToolNames.some((tool) => parsed.permission?.[tool] !== 'allow')) {
    throw Object.assign(new Error('Kilo isolated MCP config did not validate'), { status: 'FAIL', step: 'kilo-config' });
  }
}

function copyCredential(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  return true;
}

async function main() {
  const bins = { opencode: which('opencode'), kilo: which('kilo'), mcp: which('common-context-mcp') };
  const missing = Object.entries(bins).filter(([, value]) => !value).map(([key]) => key);
  const models = { opencode: process.env.AURA_ACCEPTANCE_OPENCODE_MODEL, kilo: process.env.AURA_ACCEPTANCE_KILO_MODEL };
  const preflightOnly = process.env.AURA_ACCEPTANCE_PREFLIGHT_ONLY === '1';
  if (missing.length || (!preflightOnly && (!models.opencode || !models.kilo))) {
    emit({ result: 'BLOCKED', missingExecutables: missing, missingExplicitModels: preflightOnly ? [] : Object.entries(models).filter(([, v]) => !v).map(([k]) => k) });
    return 2;
  }

  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(project, 'README.md'), `Disposable isolated MCP acceptance ${runId}\n`, { mode: 0o600 });
  const configDir = path.join(home, '.config');
  const dataDir = path.join(home, '.local', 'share');
  const env = {
    ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    OPENCODE_CONFIG_DIR: path.join(configDir, 'opencode'),
    CONTEXT_MCP_FILE: storeFile,
  };
  fs.mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(configDir, 'kilo'), { recursive: true, mode: 0o700 });
  const realData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const credentials = preflightOnly ? { opencode: false, kilo: false } : {
    opencode: copyCredential(path.join(realData, 'opencode', 'auth.json'), path.join(dataDir, 'opencode', 'auth.json')),
    kilo: copyCredential(path.join(realData, 'kilo', 'auth.json'), path.join(dataDir, 'kilo', 'auth.json')),
  };
  configureOpenCode(bins.opencode, env, bins.mcp, storeFile, 'acceptance-opencode');
  writeKiloConfig(path.join(configDir, 'kilo', 'kilo.jsonc'), bins.mcp, storeFile, 'acceptance-kilo');

  const opencodeConfig = await command(bins.opencode, ['--standalone', 'debug', 'config'], env, { cap: 2_000_000 });
  requireProcess(opencodeConfig, 'OpenCode', 'opencode-runtime-config');
  verifyOpenCodeRuntimeConfig(opencodeConfig.stdout, bins.mcp, storeFile, 'acceptance-opencode');
  const ocTools = await withOpenCodeServer(bins.opencode, env, 'opencode-preflight', async ({ tools }) => tools);
  emit({ step: 'OpenCode-MCP-connectivity', agentId: 'acceptance-opencode', status: 'verified', mode: 'private-server', toolsDiscovered: ocTools, evidence: 'OpenCode MCP client lists common-context as connected and its server log reports discovered tools' });
  const kiloMcp = await command(bins.kilo, ['mcp', 'list', '--pure', '--print-logs'], env, { cap: 100_000 });
  requireProcess(kiloMcp, 'Kilo', 'kilo-mcp-discovery');
  const kiloMcpText = kiloMcp.stdout.replace(/\u001b\[[0-9;]*m/g, '');
  if (!kiloListReportsConnected(kiloMcpText)) throw Object.assign(new Error('Kilo MCP client did not report common-context as connected'), { status: 'FAIL', step: 'kilo-mcp-discovery', agentId: 'acceptance-kilo', executable: 'kilo', exitStatus: kiloMcp.exitCode, diagnostic: redacted(kiloMcpText.slice(-600)) });
  emit({ step: 'Kilo-MCP-discovery', agentId: 'acceptance-kilo', status: 'verified' });
  const versions = {};
  for (const [name, bin] of [['opencode', bins.opencode], ['kilo', bins.kilo]]) {
    const r = await command(bin, ['--version'], env, { cap: 300 });
    if (r.exitCode !== 0) throw Object.assign(new Error(`${name} version query failed`), { status: 'BLOCKED', step: `${name}-version`, executable: name, exitStatus: r.exitCode, processError: r.processError });
    versions[name] = (r.stdout || r.stderr).trim().slice(0, 120);
  }
  if (preflightOnly) {
    emit({ result: 'NOT_RUN', reason: 'provider model calls disabled by AURA_ACCEPTANCE_PREFLIGHT_ONLY', versions, isolatedStore: true });
    return 0;
  }
  emit({ result: 'RUNNING', runId, versions, models, isolatedStore: true, copiedCredentials: credentials, openCodeServer: 'private per step' });

  const key = `${runId}_decision`;
  const n1 = randomBytes(24).toString('hex');
  sensitiveValues.add(n1);
  const decision = `${runId}_DECISION_${n1}`;
  sensitiveValues.add(decision);
  const beforeOpenCodeSave = readStoreBaseline();
  const oc1 = await withOpenCodeServer(bins.opencode, env, 'OpenCode-save', ({ url, env: serverEnv }) => command(bins.opencode, opencodeArgs(models.opencode, agentPrompt({
    identifier: runId,
    task: `Call save_context exactly once with key ${key} and value ${decision}. Do not reveal this value to another process except by saving it.`,
  }), url), serverEnv));
  const oc1Calls = requireStep(oc1, 'OpenCode', ['load_context', 'save_context'], 'OpenCode-save');
  emit({ step: 'OpenCode-save', agentId: 'acceptance-opencode', status: 'PASS', exitStatus: oc1.exitCode, toolCalls: oc1Calls.map((c) => c.name) });
  let store = verifyDecision(key, decision, 'acceptance-opencode');
  verifyReader(beforeOpenCodeSave, store, 'acceptance-opencode', 'OpenCode-save');

  const n2 = randomBytes(24).toString('hex');
  sensitiveValues.add(n2);
  const handoffValue = `${runId}_HANDOFF_${n2}`;
  sensitiveValues.add(handoffValue);
  const beforeKilo = readStore();
  const kilo = await command(bins.kilo, kiloArgs(models.kilo, project, agentPrompt({
    identifier: runId,
    task: `The key is ${key}. Use search_context to find the value; do not guess. Return that exact value. Then call handoff exactly once with to_agent=acceptance-opencode, summary=${runId} verified handoff, and context=${handoffValue}. The handoff value must be written only through that tool.`,
  })), env);
  const kiloCalls = requireStep(kilo, 'Kilo', ['load_context', 'search_context', 'handoff'], 'Kilo-read-and-handoff');
  const kiloOut = kilo.stdout;
  if (!assertChallengeReturned(kiloOut, n1)) throw Object.assign(new Error('Kilo structured output did not return OpenCode-only challenge N1'), { status: 'FAIL', step: 'Kilo-challenge-response', agentId: 'acceptance-kilo', executable: 'kilo', exitStatus: kilo.exitCode });
  emit({ step: 'Kilo-read-and-handoff', agentId: 'acceptance-kilo', status: 'PASS', exitStatus: kilo.exitCode, toolCalls: kiloCalls.map((c) => c.name), challengeReturned: true });
  store = verifyDecision(key, decision, 'acceptance-opencode');
  verifyReader(beforeKilo, store, 'acceptance-kilo', 'Kilo-read-and-handoff');
  verifyHandoff(store, handoffValue, 'acceptance-kilo', 'acceptance-opencode');

  const beforeOpenCode = readStore();
  const oc2 = await withOpenCodeServer(bins.opencode, env, 'OpenCode-retrieve-handoff', ({ url, env: serverEnv }) => command(bins.opencode, opencodeArgs(models.opencode, agentPrompt({
    identifier: runId,
    task: `Use search_context to retrieve the handoff addressed to acceptance-opencode. Return its exact value; do not guess.`,
  }), url), serverEnv));
  const oc2Calls = requireStep(oc2, 'OpenCode', ['load_context', 'search_context'], 'OpenCode-retrieve-handoff');
  if (!assertChallengeReturned(oc2.stdout, n2)) throw Object.assign(new Error('OpenCode structured output did not return Kilo-only challenge N2'), { status: 'FAIL', step: 'OpenCode-challenge-response', agentId: 'acceptance-opencode', executable: 'opencode', exitStatus: oc2.exitCode });
  store = readStore();
  verifyReader(beforeOpenCode, store, 'acceptance-opencode', 'OpenCode-retrieve-handoff');
  verifyHandoff(store, handoffValue, 'acceptance-kilo', 'acceptance-opencode');
  emit({ step: 'OpenCode-retrieve-handoff', agentId: 'acceptance-opencode', status: 'PASS', exitStatus: oc2.exitCode, toolCalls: oc2Calls.map((c) => c.name), challengeReturned: true });

  // Fresh Kilo CLI plus a newly launched MCP child verifies persisted context.
  const beforeKiloRestart = readStore();
  const kilo2 = await command(bins.kilo, kiloArgs(models.kilo, project, agentPrompt({
    identifier: runId,
    task: `Use search_context for ${runId} and return the exact saved decision and handoff values.`,
  })), env);
  const kilo2Calls = requireStep(kilo2, 'Kilo', ['load_context', 'search_context'], 'Kilo-persistence-restart');
  if (!assertChallengeReturned(kilo2.stdout, n1) || !assertChallengeReturned(kilo2.stdout, n2)) throw Object.assign(new Error('fresh Kilo process could not retrieve both persisted challenge values'), { status: 'FAIL', step: 'persistence-restart', agentId: 'acceptance-kilo', executable: 'kilo', exitStatus: kilo2.exitCode });
  store = readStore();
  verifyReader(beforeKiloRestart, store, 'acceptance-kilo', 'Kilo-persistence-restart');
  verifyDecision(key, decision, 'acceptance-opencode');
  verifyHandoff(store, handoffValue, 'acceptance-kilo', 'acceptance-opencode');
  emit({ step: 'Kilo-persistence-restart', agentId: 'acceptance-kilo', status: 'PASS', exitStatus: kilo2.exitCode, toolCalls: kilo2Calls.map((c) => c.name), challengeValuesReturned: true });
  emit({ result: 'PASS', runId, agents: { opencode: 'acceptance-opencode', kilo: 'acceptance-kilo' }, versions, models, evidence: 'structured MCP tool events plus isolated-store writer/reader records and secret challenge-response values' });
  return 0;
}

async function shutdown(signal) {
  if (interrupted) return;
  interrupted = signal;
  abortController.abort();
}

let exit = 1;
try { exit = await main(); }
catch (error) {
  const status = error.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL';
  emit({ result: interrupted ? 'FAIL' : status, step: error.step ?? 'setup', agentId: error.agentId ?? null, executable: error.executable ?? null,
    exitStatus: error.exitStatus ?? null, processError: error.processError ?? null, timedOut: error.timedOut ?? false,
    providerReason: error.providerReason ?? null, missingToolEvents: error.missingToolEvents ?? [],
    observedToolEvents: error.observedToolEvents ?? [], eventSummary: (error.eventSummary ?? []).map((e) => ({ ...e, ...(e.error ? { error: redacted(e.error) } : {}) })),
    diagnostic: redacted(error.diagnostic ?? error.message).slice(-1500) });
  exit = status === 'BLOCKED' && !interrupted ? 2 : 1;
} finally {
  await shutdown('cleanup');
  uninstallSignalHandlers();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = exit;
