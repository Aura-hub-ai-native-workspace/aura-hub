/** The Central Agent's view of the provider store: useful, and never a secret. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-view-'));
  process.env.AURA_HOME = home;
  vi.resetModules();
});

async function load() {
  const store = await import('./credentialStore');
  const view = await import('./agentView');
  view.startAgentViewSync();
  return { store, view };
}
const read = () => JSON.parse(fs.readFileSync(path.join(home, 'agent', 'providers.settings.json'), 'utf8'));

describe('agent view', () => {
  it('says nothing is active when nothing is configured', async () => {
    await load();
    expect(read().active).toBeNull();
  });

  it('publishes the address and model of an active self-hosted provider, and follows changes', async () => {
    const { store } = await load();
    store.storeKey('ollama', 'http://127.0.0.1:11434', 'http://127.0.0.1:11434');
    store.setActive('ollama', 'qwen2.5-coder:1.5b');
    expect(read().active).toEqual({ providerId: 'ollama', model: 'qwen2.5-coder:1.5b', callable: true, baseUrl: 'http://127.0.0.1:11434/v1' });
    store.setActive('ollama', 'qwen3:4b');                       // model switching
    expect(read().active.model).toBe('qwen3:4b');
    store.removeKey('ollama');                                    // deletion
    expect(read().active).toBeNull();
  });

  it('is not callable without a model, and says why', async () => {
    const { store } = await load();
    store.storeKey('ollama', 'http://127.0.0.1:11434', 'x');
    store.setActive('ollama', '');
    expect(read().active).toMatchObject({ callable: false, reason: expect.stringContaining('no-model') });
  });

  it('never shares an API key, in the file or anywhere in it', async () => {
    const { store } = await load();
    const key = 'sk-test-SECRET-1234567890abcdef';
    store.storeKey('openai', key);
    store.setActive('openai', 'gpt-x');
    const raw = fs.readFileSync(path.join(home, 'agent', 'providers.settings.json'), 'utf8');
    expect(raw).not.toContain(key);
    expect(raw).not.toContain('encryptedKey');
    expect(read().active).toMatchObject({ providerId: 'openai', callable: false, reason: expect.stringContaining('needs-api-key') });
  });
});
