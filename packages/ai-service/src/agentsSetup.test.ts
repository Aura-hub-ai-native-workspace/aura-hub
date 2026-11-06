import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentStatus, agentsScriptPath, listAgentChoice, removeAgent, runAgentSetup, type AgentSetupEvent } from './agentsSetup';

// Always a fake home with fake installs: these tests must never touch the real machine.
beforeAll(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-agents-svc-'));
  process.env.AURA_AGENTS_HOME = home;
  process.env.AURA_TOOLS_DIR = path.join(home, '.aura', 'tools');
  process.env.AURA_AGENTS_PATH = path.join(home, 'empty');
  process.env.AURA_AGENTS_FAKE_INSTALL = '1';
  process.env.AURA_HOME = path.join(home, '.aura');
  process.env.CODEX_HOME = path.join(home, '.codex');
});

describe('agent setup through the service', () => {
  it('finds the repository copy of the script', () => {
    expect(agentsScriptPath()).toMatch(/aura-agents\.mjs$/);
  });

  it('streams per-agent steps and ends with every agent connected', async () => {
    const events: AgentSetupEvent[] = [];
    const code = await runAgentSetup((e) => events.push(e));
    expect(code).toBe(0);
    const finished = events.filter((e) => e.step === 'finished').map((e) => `${e.agent}:${e.status}`);
    expect(finished).toEqual(['opencode:done', 'kilo-code:done', 'claude-code:done', 'codex-cli:done']);
    const status = await agentStatus();
    expect(status.map((s) => s.id)).toEqual(['opencode', 'kilo-code', 'claude-code', 'codex-cli']);
    expect(status.every((s) => s.installed && s.mcpConnected)).toBe(true);
    expect(status.find((s) => s.id === 'claude-code')?.signIn).toBe('skipped');
  }, 60_000);

  it('remove and add change the workspace’s agents', async () => {
    expect((await removeAgent('kilo-code')).selected).toEqual(['opencode', 'claude-code', 'codex-cli']);
    const events: AgentSetupEvent[] = [];
    expect(await runAgentSetup((e) => events.push(e), { add: 'pi' })).toBe(0);
    expect(events.some((e) => e.agent === 'pi' && e.step === 'finished' && e.status === 'done')).toBe(true);
    const choice = await listAgentChoice();
    expect(choice.selected).toEqual(['opencode', 'claude-code', 'codex-cli', 'pi']);
    expect(choice.available.map((a) => a.id)).toEqual(['kilo-code', 'freebuff', 'agy']);
  }, 60_000);

  it('a missing script is reported, not thrown', async () => {
    const events: AgentSetupEvent[] = [];
    expect(await runAgentSetup((e) => events.push(e), { script: '' })).toBe(1);
    expect(events).toEqual([{ agent: 'aura', step: 'setup', status: 'failed', detail: 'the agent setup script is missing from this install' }]);
  });
});
