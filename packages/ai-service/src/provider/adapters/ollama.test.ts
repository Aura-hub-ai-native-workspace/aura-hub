import { describe, expect, it } from 'vitest';
import { normaliseOllamaUrl, defaultOllamaBaseUrl, OllamaAdapter } from './ollama';

/**
 * The normaliser is allowed to fix a spelling. It is never allowed to
 * change which server the user meant — that would move inference to a
 * different host without telling anyone, which is the one failure here
 * with real consequences.
 */
describe('normaliseOllamaUrl', () => {
  it.each([
    ['http://localhost:11434', 'http://localhost:11434'],
    ['http://localhost:11434/', 'http://localhost:11434'],
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://192.168.1.50:11434', 'http://192.168.1.50:11434'],
    ['https://remote.example.com', 'https://remote.example.com'],
    ['https://remote.example.com/', 'https://remote.example.com'],
    ['https://remote.example.com/v1', 'https://remote.example.com'],
    ['192.168.1.50:11434', 'http://192.168.1.50:11434'],
  ])('%s -> %s', (input, want) => {
    expect(normaliseOllamaUrl(input)).toBe(want);
  });

  it('keeps a path-mounted server mounted where it is', () => {
    expect(normaliseOllamaUrl('https://ai.college.edu/ollama/v1')).toBe('https://ai.college.edu/ollama');
  });

  it('never alters host, port or protocol', () => {
    for (const raw of [
      'https://gpu.example.edu:8443/v1',
      'http://10.0.0.20:11500/',
      'https://xyz.trycloudflare.com/v1',
    ]) {
      const out = new URL(normaliseOllamaUrl(raw));
      const original = new URL(raw);
      expect(out.hostname).toBe(original.hostname);
      expect(out.port).toBe(original.port);
      expect(out.protocol).toBe(original.protocol);
    }
  });

  it('returns empty for an empty address rather than inventing localhost', () => {
    expect(normaliseOllamaUrl('')).toBe('');
    expect(normaliseOllamaUrl('   ')).toBe('');
  });
});

describe('defaultOllamaBaseUrl', () => {
  it('prefers the configured deployment address', () => {
    const before = process.env.AURA_OLLAMA_BASE_URL;
    process.env.AURA_OLLAMA_BASE_URL = 'https://gpu.college.edu:11434/v1';
    try {
      expect(defaultOllamaBaseUrl()).toBe('https://gpu.college.edu:11434');
    } finally {
      if (before === undefined) delete process.env.AURA_OLLAMA_BASE_URL;
      else process.env.AURA_OLLAMA_BASE_URL = before;
    }
  });

  it('suggests loopback only when nothing is configured', () => {
    const before = process.env.AURA_OLLAMA_BASE_URL;
    delete process.env.AURA_OLLAMA_BASE_URL;
    try {
      expect(defaultOllamaBaseUrl()).toBe('http://127.0.0.1:11434');
    } finally {
      if (before !== undefined) process.env.AURA_OLLAMA_BASE_URL = before;
    }
  });
});

describe('OllamaAdapter', () => {
  const adapter = new OllamaAdapter();

  it('is addressed, not keyed, and says so in its identity', () => {
    expect(adapter.metadata.selfHosted).toBe(true);
    expect(adapter.metadata.name).toMatch(/self-hosted/i);
    // No model is assumed: a wrong default would become a wrong model.
    expect(adapter.metadata.defaultModel).toBe('');
  });

  it('never claims to detect a key', () => {
    expect(adapter.detect()).toBe(false);
  });

  it('refuses an empty address with an instruction, not a stack trace', async () => {
    const r = await adapter.validate('');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/enter your ollama server address/i);
  });

  it('reports an unreachable server as unreachable', async () => {
    const r = await adapter.validate('http://127.0.0.1:9');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot reach the configured ollama server/i);
    // The address tried is in the message; it is a destination, not a secret.
    expect(r.error).toContain('http://127.0.0.1:9');
  });

  it('discovers nothing from an address that is not a server', async () => {
    await expect(adapter.discoverModels('http://127.0.0.1:9')).resolves.toEqual([]);
  });
});
