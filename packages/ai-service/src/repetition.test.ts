import { describe, expect, it } from 'vitest';
import { findLoop, RepetitionGuard } from './repetition';

const UNIT = 'Exit the Workspace: Exit the workspace using the `workspace.exit` command.\n```sh\nworkspace.exit\n```\n'
  + 'Exit the Project: Exit the project using the `project.exit` command.\n```sh\nproject.exit\n```\n';
const USEFUL = 'A mutex lets one thread at a time use a shared resource.\n\n';

describe('loop detection', () => {
  it('finds a verbatim cycle and keeps exactly one copy after the useful text', () => {
    const text = USEFUL + UNIT.repeat(4);
    const cut = findLoop(text)!;
    expect(Math.abs(cut - (USEFUL.length + UNIT.length))).toBeLessThanOrEqual(2);   // at most a shared newline off
    expect(text.slice(0, cut).startsWith(USEFUL)).toBe(true);
  });
  it('never cuts a long legitimate answer', () => {
    const table = '| id | name |\n|---|---|\n' + Array.from({ length: 150 }, (_, i) => `| ${i} | user${i} |\n`).join('');
    const code = Array.from({ length: 80 }, (_, i) => `def handler_${i}(r):\n    return respond(r, ${200 + i})\n\n`).join('');
    const prose = Array.from({ length: 100 }, (_, i) => `Sentence ${i} explains point ${i % 13}.`).join(' ');
    for (const t of [table, code, prose, table + code + prose]) expect(findLoop(t)).toBeNull();
  });
  it('needs three repeats', () => {
    expect(findLoop(USEFUL + UNIT.repeat(2))).toBeNull();
    expect(findLoop('')).toBeNull();
  });
  it('the streaming guard fires well before a long loop ends', () => {
    const text = USEFUL + UNIT.repeat(8);
    const g = new RepetitionGuard();
    let at = -1;
    for (let i = 0; i < text.length; i += 25) if (g.feed(text.slice(i, i + 25))) { at = i; break; }
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(text.length * 0.5);
  });
});
