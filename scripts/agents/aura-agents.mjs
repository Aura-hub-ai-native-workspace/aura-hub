#!/usr/bin/env node
/**
 * aura-agents — sets up AURA Hub's six coding agents in one go.
 *
 *   setup [--only a,b] [--json]   install what is missing, connect the common-context MCP server to
 *                                 every agent, write the protocol text where the agent reads rules
 *   status [--json]               installed / version / MCP connected / signed in, per agent
 *   login <agent>                 run that agent's own sign-in in this terminal (the sign-in page
 *                                 runs this inside its terminal panel)
 *   add <agent> / remove <agent>  add an agent to the workspace (installs + connects it) or take it off
 *   list [--json]                 the workspace's agents and the ones that can be added
 *   doctor                        what is wrong and how to fix it
 *
 * The workspace starts with four agents (OpenCode, Kilo Code, Claude Code, Codex); the person's
 * choice is kept in <AURA home>/agents.json. Removing an agent only takes it off the workspace — the
 * program and its sign-in stay on the machine.
 *
 * Dependency-free on purpose: AURA runs it with its bundled Node on Linux, macOS and Windows.
 * Every config edit is merge-only (other servers are never touched), backed up first
 * (`<file>.bak-<timestamp>`) and written atomically. One agent failing never stops the others.
 *
 * Test hooks (never set in production): AURA_AGENTS_FAKE_INSTALL=1 records installs instead of
 * running them; AURA_AGENTS_PATH replaces PATH lookups.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const home = () => process.env.AURA_AGENTS_HOME || os.homedir();
const H = (...p) => path.join(home(), ...p);
const toolsDir = () => process.env.AURA_TOOLS_DIR || H('.aura', 'tools');
const codexHome = () => process.env.CODEX_HOME || H('.codex');
const auraHome = () => process.env.AURA_HOME || H('.aura');

/** The agents a new workspace starts with. */
export const DEFAULT_AGENTS = ['opencode', 'kilo-code', 'claude-code', 'codex-cli'];

export const MCP_NAME = 'common-context';
export const MCP_PACKAGE = 'common-context-mcp';

/** The protocol every agent follows; same text as the owner's global rules. */
export const PROTOCOL = `## common-context protocol (mandatory)

This machine shares one context store across AI agents through the \`common-context\` MCP server. Every model and agent with it installed follows this on every message, including greetings:

1. Before any other tool call or reply: \`load_context\` (first message of a session) or \`search_context\`.
2. After each meaningful step: \`save_context\` (the checkpoint).
3. On a failure: \`save_failure\`, then \`search_context\` before any alternative.
4. Before editing a shared file: \`claim_area\`; \`release_area\` when done.
5. Before the final answer: \`save_context\` with the final state, then \`save_summary\` (accomplished, learned, decisions, next_steps). Answer only after both succeed.

If the \`common-context\` tools are unavailable, say so and continue.`;

const BEGIN = '<!-- aura:common-context:begin -->';
const END = '<!-- aura:common-context:end -->';

/**
 * The six agents. `mcp.kind`: "opencode" = `mcp.<name> {type:"local",command:[…]}` (OpenCode and
 * its fork Kilo); "servers" = `mcpServers.<name> {command}`. `signedIn` reads only whether a
 * credential exists, never its value.
 */
export const AGENTS = [
  {
    id: 'opencode', name: 'OpenCode', bin: 'opencode', install: { npm: 'opencode-ai' },
    // OpenCode 2.x keeps servers under mcp.servers (what `opencode mcp add --global` writes).
    mcp: { file: () => H('.config', 'opencode', 'opencode.json'), kind: 'opencode', path: ['mcp', 'servers'] },
    rules: () => H('.config', 'opencode', 'AGENTS.md'),
    login: { args: ['auth', 'login', 'opencode-go'], via: 'OpenCode Go' },
    signedIn: () => authKeys(H('.local', 'share', 'opencode', 'auth.json')).some((k) => k === 'opencode-go' || k === 'opencode'),
    headless: true,
  },
  {
    id: 'kilo-code', name: 'Kilo Code', bin: 'kilo', install: { npm: '@kilocode/cli' },
    mcp: { file: () => H('.config', 'kilo', 'kilo.jsonc'), kind: 'opencode', jsonc: true },
    rules: () => H('.config', 'kilo', 'AGENTS.md'),
    login: { args: ['auth', 'login', '--provider', 'kilo'], via: 'Kilo Gateway' },
    signedIn: () => authKeys(H('.local', 'share', 'kilo', 'auth.json')).includes('kilo'),
    headless: true,
  },
  {
    id: 'freebuff', name: 'Freebuff', bin: 'freebuff', install: { npm: 'freebuff' },
    // Freebuff (Codebuff SDK) loads MCP servers from the trusted user-level ~/.agents/mcp.json.
    mcp: { file: () => H('.agents', 'mcp.json'), kind: 'servers' },
    rules: null,
    login: { args: ['login'], via: 'Chrome' },
    signedIn: () => {
      const c = readJson(H('.config', 'manicode', 'credentials.json'));
      return !!(c && typeof c === 'object' && Object.values(c).some((v) => v && typeof v === 'object' && v.authToken));
    },
    headless: true, // through AURA's freebuff-headless build
  },
  {
    id: 'claude-code', name: 'Claude Code', bin: 'claude', install: { npm: '@anthropic-ai/claude-code' },
    mcp: { file: () => H('.claude.json'), kind: 'servers' },
    rules: () => H('.claude', 'CLAUDE.md'),
    login: null, // skipped by the owner's choice: signed in later, by the person
    signedIn: () => fs.existsSync(H('.claude', '.credentials.json')),
    headless: true,
  },
  {
    id: 'codex-cli', name: 'Codex', bin: 'codex', install: { npm: '@openai/codex' },
    mcp: { file: () => path.join(codexHome(), 'config.toml'), kind: 'toml' },
    rules: () => path.join(codexHome(), 'AGENTS.md'),
    login: { args: ['login'], via: 'ChatGPT account' },
    signedIn: () => fs.existsSync(path.join(codexHome(), 'auth.json')),
    headless: true,
  },
  {
    id: 'agy', name: 'Antigravity CLI', bin: 'agy',
    install: {
      script: IS_WIN
        ? { cmd: 'powershell', args: ['-NoProfile', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'] }
        : { cmd: 'bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] },
      source: 'https://antigravity.google/cli/install' + (IS_WIN ? '.ps1' : '.sh'),
    },
    mcp: { file: () => H('.gemini', 'config', 'mcp_config.json'), kind: 'servers' },
    rules: null,
    login: { args: [], via: 'Chrome' }, // first run asks to sign in with Google
    // Headless agy auto-denies MCP tools unless allowed (form documented by agy: mcp(<server>/<tool>)).
    extra: () => allowRule(H('.gemini', 'antigravity-cli', 'settings.json'), `mcp(${MCP_NAME}/*)`),
    signedIn: () => fs.existsSync(H('.gemini', 'antigravity-cli', 'antigravity-oauth-token')),
    headless: true,
  },
  {
    id: 'pi', name: 'pi', bin: 'pi', install: { npm: '@earendil-works/pi-coding-agent' },
    mcp: { file: () => H('.pi', 'agent', 'mcp.json'), kind: 'servers' },
    rules: () => H('.pi', 'agent', 'AGENTS.md'),
    login: { args: [], via: 'Radius', hint: 'Type /login and choose Radius.' },
    signedIn: () => authKeys(H('.pi', 'agent', 'auth.json')).includes('radius'),
    headless: true,
  },
];

export const agentById = (id) => AGENTS.find((a) => a.id === id) ?? null;

/* ── small helpers ─────────────────────────────────────────────────────── */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function authKeys(file) {
  const j = readJson(file);
  return j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : [];
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Write `text` to `file` atomically, keeping a backup of what was there. */
export function writeWithBackup(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === text) return { changed: false, backup: null };
    backup = `${file}.bak-${stamp()}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); break; } catch (e) {
      // Windows: another process replacing the file at that instant (see jsonutil.replace_with_retry).
      if (!IS_WIN || e.code !== 'EPERM' || i >= 10) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
    }
  }
  return { changed: true, backup };
}

/** Where a program is, without running it. */
export function which(bin) {
  const dirs = (process.env.AURA_AGENTS_PATH ?? process.env.PATH ?? '').split(path.delimiter)
    .concat([path.join(toolsDir(), 'bin'), toolsDir()]);
  const exts = IS_WIN ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, bin + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/* ── JSONC: comment-preserving edits for Kilo's kilo.jsonc ─────────────── */

/** Strip comments and trailing commas (string-aware) so the text parses as JSON. */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    if (c === ',') {
      // A trailing comma (legal in JSONC) is dropped; a comma inside a string never reaches here.
      let j = i + 1;
      while (j < text.length) {
        if (/\s/.test(text[j])) { j++; continue; }
        if (text[j] === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j++; continue; }
        if (text[j] === '/' && text[j + 1] === '*') { const e = text.indexOf('*/', j + 2); j = e < 0 ? text.length : e + 2; continue; }
        break;
      }
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
    }
    out += c; i++;
  }
  return out;
}

/** Index of the matching closing brace for the `{` at `open` (string- and comment-aware). */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Insert `"key": value` as the last member of the object whose `{` is at `open`. */
function insertMember(text, open, key, valueJson, indent) {
  const close = matchBrace(text, open);
  const inner = stripJsonc(text.slice(open + 1, close)).trim();
  const before = text.slice(0, close).replace(/\s*$/, '');
  // A trailing comma already there (legal in JSONC) is reused, never doubled.
  const sep = inner.length && !inner.endsWith(',') ? ',' : '';
  return `${before}${sep}\n${indent}${JSON.stringify(key)}: ${valueJson}\n${indent.slice(2)}${text.slice(close)}`;
}

/** Position of the `{` that starts the value of top-level `key`, or -1. */
function topLevelObjectStart(text, key) {
  const root = text.indexOf('{');
  let depth = 0;
  for (let i = root; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && text.slice(i + 1, j) === key) {
        const m = /^\s*:\s*\{/.exec(text.slice(j + 1));
        if (m) return j + 1 + m[0].length - 1;
      }
      i = j; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return -1;
}

/* ── MCP registration ──────────────────────────────────────────────────── */

function mcpPath(agent) {
  return agent.mcp.path ?? [agent.mcp.kind === 'opencode' ? 'mcp' : 'mcpServers'];
}

function dig(obj, keys) {
  return keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function serverEntry(kind, command) {
  return kind === 'opencode' ? { type: 'local', command: [command] } : { command };
}

/**
 * Add the common-context server to one agent's config. Merge-only: other servers and settings are
 * kept exactly; JSONC comments survive. Returns {status: 'updated'|'unchanged', file, backup}.
 */
export function connectMcp(agent, command) {
  if (agent.mcp.kind === 'toml') return connectToml(agent.mcp.file(), command);
  const file = agent.mcp.file();
  const keys = mcpPath(agent);
  const key = keys[0];
  const entry = serverEntry(agent.mcp.kind, command);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const parsed = raw.trim() ? JSON.parse(agent.mcp.jsonc ? stripJsonc(raw) : raw) : {};
  const current = dig(parsed, keys)?.[MCP_NAME];
  if (current && JSON.stringify(current) === JSON.stringify({ ...current, ...entry })) {
    return { status: 'unchanged', file, backup: null };
  }
  let text;
  if (agent.mcp.jsonc && raw.trim() && !current && keys.length === 1) {
    // Edit the text so the person's comments and layout stay as they were.
    const start = topLevelObjectStart(raw, key);
    text = start >= 0
      ? insertMember(raw, start, MCP_NAME, JSON.stringify(entry), '    ')
      : insertMember(raw, raw.indexOf('{'), key, JSON.stringify({ [MCP_NAME]: entry }, null, 2).replace(/\n/g, '\n  '), '  ');
  } else {
    const next = { ...(parsed ?? {}) };
    let node = next;
    for (const k of keys) { node[k] = { ...(node[k] ?? {}) }; node = node[k]; }
    node[MCP_NAME] = { ...(current ?? {}), ...entry };
    text = JSON.stringify(next, null, 2) + '\n';
  }
  const { changed, backup } = writeWithBackup(file, text);
  return { status: changed ? 'updated' : 'unchanged', file, backup };
}

/** Add `rule` to `permissions.allow` in a JSON settings file, keeping everything else. */
export function allowRule(file, rule) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const j = raw.trim() ? JSON.parse(raw) : {};
  const allow = Array.isArray(j.permissions?.allow) ? j.permissions.allow : [];
  if (allow.includes(rule)) return { status: 'unchanged', file };
  const next = { ...j, permissions: { ...(j.permissions ?? {}), allow: [...allow, rule] } };
  const { changed } = writeWithBackup(file, JSON.stringify(next, null, 2) + '\n');
  return { status: changed ? 'updated' : 'unchanged', file };
}

/** Codex: a `[mcp_servers.common-context]` table in config.toml, appended inside marked lines. */
export function connectToml(file, command) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\[mcp_servers\.(common-context|"common-context")\]/m.test(raw)) return { status: 'unchanged', file, backup: null };
  const block = `# common-context:start\n[mcp_servers.common-context]\ncommand = ${JSON.stringify(command)}\ndefault_tools_approval_mode = "approve"\n# common-context:end\n`;
  const text = (raw.trim() ? raw.replace(/\s*$/, '\n\n') : '') + block;
  const { changed, backup } = writeWithBackup(file, text);
  return { status: changed ? 'updated' : 'unchanged', file, backup };
}

/** Put the protocol text in the agent's rules file, inside a block AURA owns. */
export function writeRules(agent) {
  if (!agent.rules) return { status: 'skipped', file: null };
  const file = agent.rules();
  const block = `${BEGIN}\n${PROTOCOL}\n${END}`;
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let text;
  const a = raw.indexOf(BEGIN);
  const b = raw.indexOf(END);
  if (a >= 0 && b > a) text = raw.slice(0, a) + block + raw.slice(b + END.length);
  else if (raw.includes('## common-context protocol')) return { status: 'unchanged', file }; // the person's own copy
  else text = (raw.trim() ? raw.replace(/\s*$/, '\n\n') : '') + block + '\n';
  const { changed } = writeWithBackup(file, text);
  return { status: changed ? 'updated' : 'unchanged', file };
}

/* ── installs ──────────────────────────────────────────────────────────── */

function npmCommand() {
  const sys = which('npm');
  if (sys) return { cmd: sys, pre: [] };
  // AURA's bundled Node ships npm next to it.
  const cli = path.join(path.dirname(process.execPath), IS_WIN ? '' : '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const alt = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const c of [cli, alt]) if (fs.existsSync(c)) return { cmd: process.execPath, pre: [c] };
  return null;
}

function npmGlobalPrefixWritable(npm) {
  const r = spawnSync(npm.cmd, [...npm.pre, 'prefix', '-g'], { encoding: 'utf8', shell: IS_WIN && npm.cmd.endsWith('.cmd') });
  const prefix = (r.stdout || '').trim();
  if (!prefix) return null;
  try { fs.accessSync(prefix, fs.constants.W_OK); return prefix; } catch { return null; }
}

function run(cmd, args, onLine, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd), ...opts });
    const feed = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => onLine(l.slice(0, 300)));
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => resolve({ code: -1, error: e.message }));
    child.on('close', (code) => resolve({ code }));
  });
}

/** Install `agent` if its program is missing. */
export async function install(agent, onLine) {
  if (which(agent.bin)) return { status: 'present' };
  if (process.env.AURA_AGENTS_FAKE_INSTALL === '1') {
    const bin = path.join(toolsDir(), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, agent.bin + (IS_WIN ? '.cmd' : '')), IS_WIN ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
    return { status: 'installed', fake: true };
  }
  if (agent.install.npm) {
    const npm = npmCommand();
    if (!npm) return { status: 'failed', detail: 'npm was not found, and AURA has no bundled npm to use' };
    const prefix = npmGlobalPrefixWritable(npm);
    const args = [...npm.pre, 'install', '-g', agent.install.npm];
    if (!prefix) args.push('--prefix', toolsDir()); // never sudo: AURA's own prefix instead
    const r = await run(npm.cmd, args, onLine);
    if (r.code !== 0) return { status: 'failed', detail: r.error ?? `npm exited with ${r.code}` };
    return which(agent.bin) ? { status: 'installed' } : { status: 'failed', detail: `installed, but ${agent.bin} is not on PATH` };
  }
  if (agent.install.script) {
    onLine(`running the official installer from ${agent.install.source}`);
    const r = await run(agent.install.script.cmd, agent.install.script.args, onLine);
    if (r.code !== 0) return { status: 'failed', detail: r.error ?? `installer exited with ${r.code}` };
    return { status: 'installed' };
  }
  return { status: 'failed', detail: 'no installer for this agent' };
}

/** The common-context MCP server itself; returns the command agents should start. */
export async function ensureMcpServer(onLine) {
  let bin = which(MCP_PACKAGE);
  if (!bin) {
    const r = await install({ bin: MCP_PACKAGE, install: { npm: MCP_PACKAGE } }, onLine);
    if (r.status === 'failed') return { ok: false, detail: r.detail };
    bin = which(MCP_PACKAGE);
  }
  return bin ? { ok: true, command: bin } : { ok: false, detail: `${MCP_PACKAGE} is not on PATH after install` };
}

/* ── commands ──────────────────────────────────────────────────────────── */

function version(bin) {
  const p = which(bin);
  if (!p) return null;
  const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 15000, shell: IS_WIN && /\.(cmd|bat)$/i.test(p) });
  return ((r.stdout || r.stderr || '').trim().split(/\r?\n/).pop() || '').slice(0, 60) || null;
}

function mcpConnected(agent) {
  if (agent.mcp.kind === 'toml') {
    try { return /^\[mcp_servers\.(common-context|"common-context")\]/m.test(fs.readFileSync(agent.mcp.file(), 'utf8')); } catch { return false; }
  }
  try {
    const raw = fs.readFileSync(agent.mcp.file(), 'utf8');
    const j = JSON.parse(agent.mcp.jsonc ? stripJsonc(raw) : raw);
    return !!dig(j, mcpPath(agent))?.[MCP_NAME];
  } catch { return false; }
}

/* ── the workspace's agents ────────────────────────────────────────────── */

const selectionFile = () => path.join(auraHome(), 'agents.json');

/** The agents in this workspace: the person's choice, or the four defaults. */
export function selectedAgents() {
  try {
    const j = JSON.parse(fs.readFileSync(selectionFile(), 'utf8'));
    if (Array.isArray(j.selected)) return j.selected.filter((id) => agentById(id));
  } catch { /* no choice yet */ }
  return [...DEFAULT_AGENTS];
}

export function saveSelection(ids) {
  const clean = AGENTS.map((a) => a.id).filter((id) => ids.includes(id));
  writeWithBackup(selectionFile(), JSON.stringify({ selected: clean }, null, 2) + '\n');
  return clean;
}

/** Take an agent off the workspace. The program and its sign-in stay on the machine. */
export function removeAgent(id) {
  if (!agentById(id)) throw new Error(`unknown agent "${id}"`);
  return saveSelection(selectedAgents().filter((x) => x !== id));
}

/** Put an agent on the workspace and set it up (install if missing, connect common-context). */
export async function addAgent(id, emit = () => {}) {
  if (!agentById(id)) throw new Error(`unknown agent "${id}"`);
  saveSelection([...selectedAgents(), id]);
  return setup({ only: [id], emit });
}

export function listAgents() {
  const chosen = selectedAgents();
  return {
    selected: chosen,
    available: AGENTS.filter((a) => !chosen.includes(a.id)).map((a) => ({ id: a.id, name: a.name, signIn: a.login ? a.login.via : 'skipped' })),
  };
}

export function status({ withVersion = true, all = false } = {}) {
  const chosen = selectedAgents();
  return AGENTS.filter((a) => all || chosen.includes(a.id)).map((a) => {
    const installed = !!which(a.bin);
    let signedIn = false;
    try { signedIn = a.signedIn(); } catch { /* unreadable reads as not signed in */ }
    return {
      id: a.id, name: a.name, installed,
      version: installed && withVersion ? version(a.bin) : null,
      mcpConnected: mcpConnected(a),
      signedIn,
      signIn: a.login ? a.login.via : 'skipped',
      hint: a.login?.hint ?? null,
      headless: a.headless,
    };
  });
}

/** Set up the chosen agents; `emit` receives one event per step. */
export async function setup({ only = null, emit = () => {} } = {}) {
  const ids = only ?? selectedAgents();
  const chosen = AGENTS.filter((a) => ids.includes(a.id));
  const server = await ensureMcpServer((line) => emit({ agent: MCP_PACKAGE, step: 'install', status: 'log', detail: line }));
  emit({ agent: MCP_PACKAGE, step: 'install', status: server.ok ? 'done' : 'failed', detail: server.detail ?? server.command });
  const results = [];
  for (const a of chosen) {
    const r = { id: a.id, install: null, mcp: null, rules: null, error: null };
    try {
      emit({ agent: a.id, step: 'install', status: 'running' });
      r.install = await install(a, (line) => emit({ agent: a.id, step: 'install', status: 'log', detail: line }));
      emit({ agent: a.id, step: 'install', status: r.install.status === 'failed' ? 'failed' : 'done', detail: r.install.detail ?? r.install.status });
      if (r.install.status !== 'failed' && server.ok) {
        r.mcp = connectMcp(a, server.command);
        emit({ agent: a.id, step: 'mcp', status: 'done', detail: `${r.mcp.status} ${r.mcp.file}` });
        if (a.extra) {
          const x = a.extra();
          emit({ agent: a.id, step: 'permissions', status: 'done', detail: `${x.status} ${x.file}` });
        }
        r.rules = writeRules(a);
        if (r.rules.file) emit({ agent: a.id, step: 'rules', status: 'done', detail: `${r.rules.status} ${r.rules.file}` });
      } else if (!server.ok) {
        emit({ agent: a.id, step: 'mcp', status: 'failed', detail: 'the common-context server could not be installed' });
      }
    } catch (e) {
      r.error = String(e?.message ?? e);
      emit({ agent: a.id, step: 'error', status: 'failed', detail: r.error });
    }
    emit({ agent: a.id, step: 'finished', status: r.error || r.install?.status === 'failed' ? 'failed' : 'done' });
    results.push(r);
  }
  return results;
}

/** Hand the terminal to the agent's own sign-in. Resolves with its exit code. */
export function login(id) {
  const a = agentById(id);
  if (!a) return Promise.resolve({ code: 2, detail: `unknown agent "${id}"` });
  if (!a.login) return Promise.resolve({ code: 0, detail: 'skipped' });
  const bin = which(a.bin);
  if (!bin) return Promise.resolve({ code: 1, detail: `${a.name} is not installed; run setup first` });
  if (a.login.hint) process.stdout.write(`${a.login.hint}\n`);
  return new Promise((resolve) => {
    const child = spawn(bin, a.login.args, { stdio: 'inherit', shell: IS_WIN && /\.(cmd|bat)$/i.test(bin) });
    child.on('close', (code) => resolve({ code: code ?? 0 }));
    child.on('error', (e) => resolve({ code: 1, detail: e.message }));
  });
}

function doctor() {
  const lines = [];
  if (!npmCommand()) lines.push('npm not found: npm-based agents cannot be installed. Install Node.js, or run this from AURA Hub.');
  for (const s of status({ withVersion: false })) {
    if (!s.installed) lines.push(`${s.name}: not installed — run \`aura-agents setup --only ${s.id}\`.`);
    else if (!s.mcpConnected) lines.push(`${s.name}: common-context not connected — run setup again.`);
    if (s.installed && !s.signedIn && s.signIn !== 'skipped') lines.push(`${s.name}: not signed in — run \`aura-agents login ${s.id}\` (${s.signIn}).`);
  }
  const bin = path.join(toolsDir(), 'bin');
  if (fs.existsSync(bin) && !(process.env.PATH ?? '').split(path.delimiter).includes(bin)) {
    lines.push(`Agents installed by AURA live in ${bin}; add it to your PATH to use them in your own terminal.`);
  }
  return lines.length ? lines : ['Everything is set up.'];
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  if (cmd === 'status') {
    const s = status();
    if (json) process.stdout.write(JSON.stringify(s) + '\n');
    else for (const a of s) process.stdout.write(`${a.name.padEnd(16)} ${a.installed ? (a.version ?? 'installed') : 'missing'} · mcp ${a.mcpConnected ? 'on' : 'off'} · ${a.signIn === 'skipped' ? 'sign-in skipped' : a.signedIn ? 'signed in' : 'not signed in'}\n`);
    return 0;
  }
  if (cmd === 'setup') {
    const i = rest.indexOf('--only');
    const only = i >= 0 ? (rest[i + 1] ?? '').split(',').filter(Boolean) : null;
    const results = await setup({
      only,
      emit: (e) => process.stdout.write(json ? JSON.stringify(e) + '\n' : e.status === 'log' ? `  ${e.agent}: ${e.detail}\n` : `${e.agent} ${e.step}: ${e.status}${e.detail ? ` — ${e.detail}` : ''}\n`),
    });
    return results.some((r) => r.error || r.install?.status === 'failed') ? 1 : 0;
  }
  if (cmd === 'login') {
    const r = await login(rest[0]);
    if (r.detail) process.stdout.write(`${r.detail}\n`);
    return r.code;
  }
  if (cmd === 'doctor') { for (const l of doctor()) process.stdout.write(l + '\n'); return 0; }
  if (cmd === 'list') {
    const l = listAgents();
    process.stdout.write(json ? JSON.stringify(l) + '\n' : `workspace: ${l.selected.join(', ')}\ncan add: ${l.available.map((a) => a.id).join(', ') || 'none'}\n`);
    return 0;
  }
  if (cmd === 'remove') {
    const left = removeAgent(rest[0]);
    process.stdout.write(json ? JSON.stringify({ selected: left }) + '\n' : `removed ${rest[0]}; workspace: ${left.join(', ')}\n`);
    return 0;
  }
  if (cmd === 'add') {
    const results = await addAgent(rest[0], (e) => process.stdout.write(json ? JSON.stringify(e) + '\n' : `${e.agent} ${e.step}: ${e.status}${e.detail ? ` — ${e.detail}` : ''}\n`));
    return results.some((r) => r.error || r.install?.status === 'failed') ? 1 : 0;
  }
  process.stdout.write('usage: aura-agents setup [--only ids] [--json] | status [--json] | list [--json] | add <agent> | remove <agent> | login <agent> | doctor\n');
  return cmd ? 2 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
