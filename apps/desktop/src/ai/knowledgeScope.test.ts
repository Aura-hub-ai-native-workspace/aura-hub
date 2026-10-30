/**
 * Knowledge is scoped to a project (F-26) — the UI client's side of the rule.
 *
 * The backend refuses a document or knowledge request that names no registered
 * project, so the client must send the open project on every call and must
 * refuse, before any request, when no project is open. Only the HTTP layer is
 * faked here; the backend's enforcement is covered by its own tests.
 *
 * Run with `npm run test:front` from the repo root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../backend/backendSession', async (orig) => ({
  ...(await orig<typeof import('../backend/backendSession')>()),
  backendFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

import { centralAgentClient } from './centralAgentClient';

const requests: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, documents: [], results: [], chunkCount: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
});

const file = () => new File(['text'], 'notes.txt', { type: 'text/plain' });

describe('document upload', () => {
  it('sends the open project with the file', async () => {
    await centralAgentClient.ingestDocument(file(), 'proj-alpha-1');
    expect(requests).toHaveLength(1);
    const form = requests[0].init?.body as FormData;
    expect(form.get('projectId')).toBe('proj-alpha-1');
    expect((form.get('file') as File).name).toBe('notes.txt');
  });

  it.each([null, undefined, ''])('refuses with no project (%j) and sends nothing', async (projectId) => {
    await expect(centralAgentClient.ingestDocument(file(), projectId as never)).rejects.toThrow(/open a project/i);
    expect(requests).toHaveLength(0);
  });

  it('shows the backend refusal instead of hiding it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no such project' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    })));
    await expect(centralAgentClient.ingestDocument(file(), 'proj-gone')).rejects.toThrow(/no such project/);
  });
});

describe('listing and search', () => {
  it('lists one project and says which', async () => {
    await centralAgentClient.listDocuments('proj alpha/1');
    expect(new URL(requests[0].url, 'http://x').searchParams.get('projectId')).toBe('proj alpha/1');
    expect(new URL(requests[0].url, 'http://x').pathname).toMatch(/\/documents\/list$/);
  });

  it('searches one project and says which', async () => {
    await centralAgentClient.searchKnowledge('budget & plan', 'proj-alpha-1', 3);
    const url = new URL(requests[0].url, 'http://x');
    expect(url.pathname).toMatch(/\/knowledge\/search$/);
    expect(url.searchParams.get('projectId')).toBe('proj-alpha-1');
    expect(url.searchParams.get('q')).toBe('budget & plan');
    expect(url.searchParams.get('top_k')).toBe('3');
  });
});
