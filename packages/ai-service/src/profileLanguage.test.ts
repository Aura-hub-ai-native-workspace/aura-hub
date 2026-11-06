import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProfile } from './profile';

describe('primary language', () => {
  it('a small web app is JavaScript, not Markdown, when each file type appears once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lang-'));
    for (const [f, t] of [['README.md', '# x'], ['index.html', '<p>'], ['style.css', 'p{}'], ['app.js', 'let a=1']]) fs.writeFileSync(path.join(dir, f), t);
    expect(buildProfile('x', dir).primaryLanguage).toBe('JavaScript');
  });
  it('a docs-only folder is still Markdown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-lang-docs-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# x');
    expect(buildProfile('y', dir).primaryLanguage).toBe('Markdown');
  });
});
