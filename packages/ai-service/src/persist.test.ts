import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configHome, homePath, writeJsonFile } from './persist';

const posix = process.platform !== 'win32';
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('the data folder is private to its owner', () => {
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.AURA_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-persist-'));
    process.env.AURA_HOME = path.join(root, '.aura');
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.AURA_HOME;
    else process.env.AURA_HOME = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.runIf(posix)('a new data folder is created owner-only', () => {
    expect(mode(configHome())).toBe(0o700);
  });

  it.runIf(posix)('an existing open data folder is closed', () => {
    const home = process.env.AURA_HOME!;
    fs.mkdirSync(home, { mode: 0o755 });
    fs.chmodSync(home, 0o755);
    configHome();
    expect(mode(home)).toBe(0o700);
  });

  it.runIf(posix)('stores in the data folder are written owner-only, even over an open file', () => {
    const file = homePath('secrets.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeJsonFile(file, { secrets: {} });
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ secrets: {} });
  });

  it.runIf(posix)('files written outside the data folder keep the usual permissions', () => {
    const outside = path.join(root, 'project', 'settings.json');
    writeJsonFile(outside, { a: 1 });
    expect(mode(outside)).toBe(0o666 & ~process.umask());
  });
});
