import { describe, expect, it } from 'vitest';
import { versionForAgent, type AgentVersion } from './workerClient';

const v = (id: string): AgentVersion => ({ id, name: id, installed: '1.0.0', latest: '1.1.0', updateAvailable: true, updateCommand: 'x' });

describe('versionForAgent', () => {
  it('matches the runtime screen ids to the worker ids', () => {
    const all = [v('opencode'), v('kilo-code'), v('codex-cli'), v('qwen-cli')];
    expect(versionForAgent('opencode', all)?.id).toBe('opencode');
    expect(versionForAgent('kilo', all)?.id).toBe('kilo-code');
    expect(versionForAgent('codex', all)?.id).toBe('codex-cli');
    expect(versionForAgent('qwen', all)?.id).toBe('qwen-cli');
    expect(versionForAgent('gemini-cli', all)).toBeNull();
  });
});
