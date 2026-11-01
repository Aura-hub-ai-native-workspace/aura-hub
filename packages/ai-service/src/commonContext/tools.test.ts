import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextTools } from './index.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));

describe('common-context tool layer', () => {
  it('saves a checkpoint that another agent finds by search and in its load brief', () => {
    const d = dir();
    new ContextTools(d, 'opencode').saveContext('plan', 'Add footer to index.html', ['site']);
    const kilo = new ContextTools(d, 'kilo-code');
    expect(kilo.searchContext('footer')[0]).toMatchObject({ key: 'plan', agent: 'opencode' });
    expect(kilo.loadContext().brief).toContain('Add footer to index.html');
    expect(fs.statSync(path.join(d, 'common-context.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps the old value in history when a key is overwritten', () => {
    const t = new ContextTools(dir(), 'a');
    t.saveContext('k', 'one');
    t.saveContext('k', 'two');
    expect(t.snapshot().contexts.k.history.map((h) => h.value)).toEqual(['one']);
  });

  it('never overwrites another agent’s live claim, and only the owner can release it', () => {
    const d = dir();
    const a = new ContextTools(d, 'a');
    const b = new ContextTools(d, 'b');
    expect(a.claimArea('src/')).toEqual({ claimed: true });
    expect(b.claimArea('src/')).toEqual({ claimed: false, heldBy: 'a' });
    expect(b.releaseArea('src/')).toBe(false);
    expect(a.releaseArea('src/')).toBe(true);
    expect(b.claimArea('src/')).toEqual({ claimed: true });
  });

  it('records failures so a later agent sees what not to repeat', () => {
    const d = dir();
    new ContextTools(d, 'a').saveFailure('inline script tag', 'blocked by CSP');
    expect(new ContextTools(d, 'b').loadContext().brief).toContain('blocked by CSP');
    expect(new ContextTools(d, 'b').searchContext('CSP')[0].key).toBe('failure');
  });

  it('completes a session with a summary and releases that agent’s claims', () => {
    const d = dir();
    const a = new ContextTools(d, 'a');
    a.claimArea('x');
    a.saveSummary({ title: 'T', accomplished: 'did it', next_steps: 'review' });
    const snap = a.snapshot();
    expect(snap.sessions.at(-1)).toMatchObject({ status: 'completed', title: 'T' });
    expect(snap.claims).toEqual({});
    expect(new ContextTools(d, 'b').loadContext().brief).toContain('did it');
  });

  it('hands work to the next agent as the first thing it reads', () => {
    const d = dir();
    new ContextTools(d, 'claude-code').handoff('opencode', 'Claude hit its limit; footer half done');
    expect(new ContextTools(d, 'opencode').loadContext().brief).toContain('footer half done');
  });

  it('rejects an empty key and an oversize value', () => {
    const t = new ContextTools(dir(), 'a');
    expect(() => t.saveContext('', 'x')).toThrow();
    expect(() => t.saveContext('k', 'x'.repeat(20_001))).toThrow();
  });
});
