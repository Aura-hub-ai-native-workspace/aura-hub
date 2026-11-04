// node --test scripts/agents/aura-agents.test.mjs — runs against a fake home, never the real one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let home;
let mod;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-agents-home-'));
  process.env.AURA_AGENTS_HOME = home;
  process.env.AURA_TOOLS_DIR = path.join(home, '.aura', 'tools');
  process.env.AURA_AGENTS_PATH = path.join(home, 'empty-path');
  process.env.AURA_AGENTS_FAKE_INSTALL = '1';
  process.env.AURA_HOME = path.join(home, '.aura');
  process.env.CODEX_HOME = path.join(home, '.codex');
  mod ??= await import('./aura-agents.mjs');
});

const read = (rel) => fs.readFileSync(path.join(home, rel), 'utf8');
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };

test('the agents, with the owner’s sign-in choices; four are the workspace default', () => {
  assert.deepEqual(mod.AGENTS.map((a) => a.id), ['opencode', 'kilo-code', 'freebuff', 'claude-code', 'codex-cli', 'agy', 'pi']);
  assert.deepEqual(mod.DEFAULT_AGENTS, ['opencode', 'kilo-code', 'claude-code', 'codex-cli']);
  assert.equal(mod.agentById('codex-cli').login.via, 'ChatGPT account');
  assert.equal(mod.agentById('opencode').login.via, 'OpenCode Go');
  assert.equal(mod.agentById('kilo-code').login.via, 'Kilo Gateway');
  assert.equal(mod.agentById('freebuff').login.via, 'Chrome');
  assert.equal(mod.agentById('agy').login.via, 'Chrome');
  assert.equal(mod.agentById('pi').login.via, 'Radius');
  assert.equal(mod.agentById('claude-code').login, null);
});

test('connecting keeps every other MCP server and setting, and backs the file up', () => {
  write('.claude.json', JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
  const r = mod.connectMcp(mod.agentById('claude-code'), '/bin/ccm');
  assert.equal(r.status, 'updated');
  assert.ok(r.backup && fs.existsSync(r.backup));
  const j = JSON.parse(read('.claude.json'));
  assert.equal(j.theme, 'dark');
  assert.deepEqual(j.mcpServers.other, { command: 'x' });
  assert.deepEqual(j.mcpServers['common-context'], { command: '/bin/ccm' });
});

test('OpenCode-style entries use the local/command-array shape', () => {
  mod.connectMcp(mod.agentById('opencode'), '/bin/ccm');
  const j = JSON.parse(read('.config/opencode/opencode.json'));
  assert.deepEqual(j.mcp.servers['common-context'], { type: 'local', command: ['/bin/ccm'] });
});

test('a second run changes nothing', () => {
  const a = mod.agentById('pi');
  assert.equal(mod.connectMcp(a, '/bin/ccm').status, 'updated');
  assert.equal(mod.connectMcp(a, '/bin/ccm').status, 'unchanged');
  assert.equal(mod.writeRules(a).status, 'updated');
  assert.equal(mod.writeRules(a).status, 'unchanged');
});

test("Kilo's JSONC keeps its comments", () => {
  write('.config/kilo/kilo.jsonc', '{\n  // my settings\n  "$schema": "https://kilo.ai/config.json", // trailing\n  "permission": { "edit": "allow" },\n}\n');
  mod.connectMcp(mod.agentById('kilo-code'), '/bin/ccm');
  const text = read('.config/kilo/kilo.jsonc');
  assert.match(text, /\/\/ my settings/);
  assert.match(text, /\/\/ trailing/);
  const j = JSON.parse(mod.stripJsonc(text));
  assert.deepEqual(j.mcp['common-context'], { type: 'local', command: ['/bin/ccm'] });
  assert.deepEqual(j.permission, { edit: 'allow' });
});

test('Kilo: an existing mcp block gets the server added inside it', () => {
  write('.config/kilo/kilo.jsonc', '{\n  "mcp": {\n    // keep me\n    "other": { "type": "local", "command": ["o"] }\n  }\n}\n');
  mod.connectMcp(mod.agentById('kilo-code'), '/bin/ccm');
  const text = read('.config/kilo/kilo.jsonc');
  assert.match(text, /\/\/ keep me/);
  const j = JSON.parse(mod.stripJsonc(text));
  assert.ok(j.mcp.other && j.mcp['common-context']);
});

test('an empty config file (as agy ships it) is filled in', () => {
  write('.gemini/config/mcp_config.json', '');
  mod.connectMcp(mod.agentById('agy'), '/bin/ccm');
  assert.deepEqual(JSON.parse(read('.gemini/config/mcp_config.json')).mcpServers['common-context'], { command: '/bin/ccm' });
});

test('rules: an AURA block is added once and the person’s own text is kept', () => {
  write('.claude/CLAUDE.md', '# My rules\n');
  mod.writeRules(mod.agentById('claude-code'));
  const t = read('.claude/CLAUDE.md');
  assert.match(t, /^# My rules/);
  assert.equal(t.split('aura:common-context:begin').length, 2);
});

test('rules: a hand-written protocol section is not duplicated', () => {
  write('.claude/CLAUDE.md', '## common-context protocol (mandatory)\nmine\n');
  assert.equal(mod.writeRules(mod.agentById('claude-code')).status, 'unchanged');
});

test('setup installs what is missing and connects every agent; one failure does not stop the rest', async () => {
  write('.config/kilo/kilo.jsonc', '{ not json');
  mod.saveSelection(mod.AGENTS.map((a) => a.id));
  const events = [];
  const results = await mod.setup({ emit: (e) => events.push(e) });
  assert.equal(results.length, 7);
  const kilo = results.find((r) => r.id === 'kilo-code');
  assert.ok(kilo.error, 'broken kilo config is reported');
  for (const r of results.filter((x) => x.id !== 'kilo-code')) assert.equal(r.mcp.status, 'updated', r.id);
  assert.ok(events.some((e) => e.agent === 'pi' && e.step === 'finished' && e.status === 'done'));
  const s = mod.status({ withVersion: false });
  assert.ok(s.every((a) => a.installed));
  assert.deepEqual(s.filter((a) => a.mcpConnected).map((a) => a.id).sort(), ['agy', 'claude-code', 'codex-cli', 'freebuff', 'opencode', 'pi']);
});

test('status reads sign-in from credential presence, never values', () => {
  write('.local/share/kilo/auth.json', JSON.stringify({ kilo: { type: 'oauth', access: 'SECRET' } }));
  write('.pi/agent/auth.json', JSON.stringify({ radius: {} }));
  const s = Object.fromEntries(mod.status({ withVersion: false, all: true }).map((a) => [a.id, a]));
  assert.equal(s['kilo-code'].signedIn, true);
  assert.equal(s.pi.signedIn, true);
  assert.equal(s.opencode.signedIn, false);
  assert.equal(s['claude-code'].signIn, 'skipped');
  assert.ok(!JSON.stringify(s).includes('SECRET'));
});

test('login: Claude Code is skipped and unknown agents are refused', async () => {
  assert.deepEqual(await mod.login('claude-code'), { code: 0, detail: 'skipped' });
  assert.equal((await mod.login('rm -rf')).code, 2);
});

test('agy: headless MCP use is allowed for common-context only, other settings kept', () => {
  write('.gemini/antigravity-cli/settings.json', JSON.stringify({ model: 'x', permissions: { allow: ['command(git status)'] } }));
  assert.equal(mod.agentById('agy').extra().status, 'updated');
  const j = JSON.parse(read('.gemini/antigravity-cli/settings.json'));
  assert.equal(j.model, 'x');
  assert.deepEqual(j.permissions.allow, ['command(git status)', 'mcp(common-context/*)']);
  assert.equal(mod.agentById('agy').extra().status, 'unchanged');
});

test('Codex: common-context is appended to config.toml once, other settings kept', () => {
  write('.codex/config.toml', 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  assert.equal(mod.connectMcp(mod.agentById('codex-cli'), '/bin/ccm').status, 'updated');
  const t = read('.codex/config.toml');
  assert.match(t, /^model = "gpt-5"/);
  assert.match(t, /\[mcp_servers\.other\]/);
  assert.match(t, /\[mcp_servers\.common-context\]\ncommand = "\/bin\/ccm"/);
  assert.equal(mod.connectMcp(mod.agentById('codex-cli'), '/bin/ccm').status, 'unchanged');
});

test('the workspace starts with four agents; remove and add change only the choice', async () => {
  assert.deepEqual(mod.selectedAgents(), ['opencode', 'kilo-code', 'claude-code', 'codex-cli']);
  assert.deepEqual(mod.status({ withVersion: false }).map((a) => a.id), ['opencode', 'kilo-code', 'claude-code', 'codex-cli']);
  mod.removeAgent('kilo-code');
  assert.deepEqual(mod.selectedAgents(), ['opencode', 'claude-code', 'codex-cli']);
  assert.deepEqual(mod.listAgents().available.map((a) => a.id), ['kilo-code', 'freebuff', 'agy', 'pi']);
  const results = await mod.addAgent('pi');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'pi');
  assert.deepEqual(mod.selectedAgents(), ['opencode', 'claude-code', 'codex-cli', 'pi']);
  assert.throws(() => mod.removeAgent('nope'), /unknown agent/);
});

test('setup with no choice saved sets up only the four defaults', async () => {
  const results = await mod.setup();
  assert.deepEqual(results.map((r) => r.id), ['opencode', 'kilo-code', 'claude-code', 'codex-cli']);
});

test('JSONC: a ", }" inside a string is kept; trailing commas are dropped', () => {
  const j = JSON.parse(mod.stripJsonc('{ "a": "x, }", // c\n "b": [1, 2, ], }'));
  assert.equal(j.a, 'x, }');
  assert.deepEqual(j.b, [1, 2]);
});
