import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startService, type ServiceHandle } from '../server';

let svc: ServiceHandle;
let base = '';
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-route-'));

beforeAll(async () => {
  process.env.AURA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-home-'));
  svc = await startService({ port: 0 });
  base = `http://127.0.0.1:${svc.port}`;
});
afterAll(async () => { await svc?.close?.(); });

const post = async (route: string, body: Record<string, unknown>) => {
  const r = await fetch(`${base}/context/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: project, agent: 'opencode', ...body }),
  });
  return { status: r.status, body: await r.json() as Record<string, any> };
};

describe('/context routes', () => {
  it('save then search then load round-trips through the project’s common-context.json', async () => {
    expect((await post('save', { key: 'plan', value: 'footer work' })).status).toBe(200);
    expect((await post('search', { query: 'footer' })).body.results[0].key).toBe('plan');
    expect((await post('load', {})).body.brief).toContain('footer work');
    expect(fs.existsSync(path.join(project, 'common-context.json'))).toBe(true);
  });

  it('refuses a project folder that does not exist', async () => {
    const r = await post('load', { projectPath: path.join(project, 'nope') });
    expect(r.status).toBe(400);
  });
});
