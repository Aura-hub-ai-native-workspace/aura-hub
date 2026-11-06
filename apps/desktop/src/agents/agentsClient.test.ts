import { describe, expect, it } from 'vitest';
import { AGENT_IDS, DEFAULT_AGENTS, reduceSetup, signInLabel, type AgentStatus } from './agentsClient';

const base = (over: Partial<AgentStatus>): AgentStatus => ({
  id: 'opencode', name: 'OpenCode', installed: true, version: '1', mcpConnected: true,
  signedIn: false, signIn: 'OpenCode Go', hint: null, headless: true, ...over,
});

describe('agent setup progress', () => {
  it('walks a row from waiting to ready', () => {
    let rows = {};
    rows = reduceSetup(rows, { agent: 'pi', step: 'install', status: 'running' });
    expect(rows).toEqual({ pi: { state: 'working', detail: 'Installing…' } });
    rows = reduceSetup(rows, { agent: 'pi', step: 'install', status: 'done', detail: 'present' });
    expect((rows as Record<string, { detail: string }>).pi.detail).toBe('Already installed');
    rows = reduceSetup(rows, { agent: 'pi', step: 'mcp', status: 'done' });
    rows = reduceSetup(rows, { agent: 'pi', step: 'finished', status: 'done' });
    expect(rows).toEqual({ pi: { state: 'ready', detail: 'Ready' } });
  });

  it('keeps the failure reason and ignores log lines and non-agent events', () => {
    let rows = reduceSetup({}, { agent: 'agy', step: 'install', status: 'failed', detail: 'installer exited with 1' });
    rows = reduceSetup(rows, { agent: 'agy', step: 'finished', status: 'failed' });
    expect(rows).toEqual({ agy: { state: 'failed', detail: 'installer exited with 1' } });
    expect(reduceSetup(rows, { agent: 'common-context-mcp', step: 'install', status: 'done' })).toBe(rows);
    expect(reduceSetup(rows, { agent: 'agy', step: 'install', status: 'log', detail: 'x' })).toBe(rows);
  });

  it('knows every agent and starts a workspace with four', () => {
    expect([...AGENT_IDS]).toEqual(['opencode', 'kilo-code', 'freebuff', 'claude-code', 'codex-cli', 'agy', 'pi']);
    expect(DEFAULT_AGENTS).toEqual(['opencode', 'kilo-code', 'claude-code', 'codex-cli']);
  });
});

describe('sign-in labels', () => {
  it('says how each agent signs in, and that Claude Code is skipped', () => {
    expect(signInLabel(base({}))).toBe('Not signed in · OpenCode Go');
    expect(signInLabel(base({ signedIn: true }))).toBe('Signed in');
    expect(signInLabel(base({ signIn: 'skipped' }))).toBe('Skipped — sign in later');
    expect(signInLabel(base({ installed: false }))).toBe('Not installed');
  });
});
