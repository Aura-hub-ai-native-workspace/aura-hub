/** Pipeline.generate: the caller's deadline, streaming with progress, and honest timeout messages. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./provider/modelValidation', async (orig) => ({ ...(await orig<object>()), isModelValidForProvider: () => true }));

let PipelineManager: typeof import('./pipeline').PipelineManager;
beforeAll(async () => {
  process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pipe-'));
  ({ PipelineManager } = await import('./pipeline'));
});

type FakeRuntime = {
  generate: (r: { timeoutMs?: number }) => Promise<unknown>;
  stream: (r: unknown) => AsyncIterable<{ delta: string; done: boolean; usage?: unknown; finishReason?: string }>;
  cancel: () => void;
};

function managerWith(runtime: Partial<FakeRuntime>) {
  const pm = new PipelineManager();
  (pm.runtimeManager as unknown as { active: unknown }).active = {
    type: 'byoak', providerId: 'ollama', model: 'm',
    runtime: { cancel: vi.fn(), ...runtime },
  };
  return pm;
}

describe('generate', () => {
  it('hands the caller deadline to the runtime request', async () => {
    const seen: (number | undefined)[] = [];
    const pm = managerWith({ generate: async (r) => { seen.push(r.timeoutMs); return { content: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } });
    const out = await pm.generate({ user: 'hi', timeoutMs: 123_000 });
    expect(out.ok).toBe(true);
    expect(seen).toEqual([123_000]);
  });

  it('streams, joins the text and reports characters received as they arrive', async () => {
    async function* chunks() {
      yield { delta: '{"a":', done: false };
      yield { delta: '1}', done: false };
      yield { delta: '', done: true, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }, finishReason: 'stop' };
    }
    const pm = managerWith({ stream: chunks });
    const progress: number[] = [];
    const out = await pm.generate({ user: 'plan', stream: true, timeoutMs: 60_000, onProgress: (n) => progress.push(n) });
    expect(out).toMatchObject({ ok: true, text: '{"a":1}', usage: { totalTokens: 5 } });
    expect(progress).toEqual([5, 7]);
  });

  it('a stream that goes silent is a timeout that says so, not a generic failure', async () => {
    async function* silent(): AsyncGenerator<never> { throw new Error('Ollama (self-hosted) sent nothing for 120s. The server may be loading the model, or may be unreachable.'); }
    const pm = managerWith({ stream: silent });
    const out = await pm.generate({ user: 'plan', stream: true, timeoutMs: 60_000 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe('timeout');
      expect(out.error.message).toContain('sent nothing for 120s');
    }
  });

  it('when the overall ceiling is hit, the message names the elapsed time and the limit', async () => {
    const pm = managerWith({ generate: () => new Promise(() => { /* never answers */ }) });
    const out = await pm.generate({ user: 'hi', timeoutMs: 50 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe('timeout');
      expect(out.error.message).toMatch(/timed out after \d+s \(limit \d+s\)/);
    }
  });

  it('cancellation reaches the runtime and is not reported as a timeout', async () => {
    const cancel = vi.fn();
    const pm = managerWith({ generate: () => new Promise(() => { /* hangs */ }), cancel });
    const ac = new AbortController();
    const p = pm.generate({ user: 'hi', timeoutMs: 5_000 }, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const out = await Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 400))]);
    expect(cancel).toHaveBeenCalled();
    if (out !== 'pending') expect(out.ok).toBe(false);
  });

  const USEFUL = 'A mutex lets one thread at a time use a shared resource.\n\n';
  const UNIT = 'Exit the Workspace: Exit the workspace using the `workspace.exit` command.\n```sh\nworkspace.exit\n```\n'
    + 'Exit the Project: Exit the project using the `project.exit` command.\n```sh\nproject.exit\n```\n';
  const pieces = (text: string, n = 30) => Array.from({ length: Math.ceil(text.length / n) }, (_, i) => text.slice(i * n, (i + 1) * n));

  it('a looping stream is stopped, retried ONCE with a repetition penalty, and a second loop is final (never an answer)', async () => {
    const seen: (number | undefined)[] = [];
    async function* looping(req: { frequencyPenalty?: number }) {
      seen.push(req.frequencyPenalty);
      for (const p of pieces(USEFUL + UNIT.repeat(30))) yield { delta: p, done: false };
    }
    const pm = managerWith({ stream: looping as never });
    const out = await pm.generate({ user: 'plan', stream: true, timeoutMs: 60_000 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe('degenerate');
      expect(out.error.message).toContain('began repeating itself');
    }
    expect(seen).toEqual([undefined, 0.6]);                       // exactly two attempts
  });

  it('recovers when the penalised retry produces a real answer', async () => {
    let calls = 0;
    async function* flaky() {
      calls += 1;
      const text = calls === 1 ? USEFUL + UNIT.repeat(30) : '{"tasks": []}';
      for (const p of pieces(text)) yield { delta: p, done: false };
      yield { delta: '', done: true };
    }
    const pm = managerWith({ stream: flaky as never });
    const out = await pm.generate({ user: 'plan', stream: true, timeoutMs: 60_000 });
    expect(out).toMatchObject({ ok: true, text: '{"tasks": []}' });
    expect(calls).toBe(2);
  });

  it('a long legitimate stream is returned whole and costs no retry', async () => {
    const prose = Array.from({ length: 120 }, (_, i) => `Sentence ${i} explains point ${i % 13}.`).join(' ');
    let calls = 0;
    async function* fine() { calls += 1; for (const p of pieces(prose, 50)) yield { delta: p, done: false }; yield { delta: '', done: true }; }
    const out = await managerWith({ stream: fine as never }).generate({ user: 'x', stream: true, timeoutMs: 60_000 });
    expect(out).toMatchObject({ ok: true, text: prose });
    expect(calls).toBe(1);
  });
});
