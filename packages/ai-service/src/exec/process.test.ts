/**
 * The install guard on `terminal.execute`.
 *
 * Routine project commands now run without a prompt (medium risk defaults
 * to auto-execute), so this guard — not an approval card — is what keeps
 * an allow-listed binary from installing software on the machine. These
 * cases pin it: every install verb is refused before anything is spawned,
 * and ordinary project work through the same binaries is not.
 */
import { describe, expect, it } from 'vitest';
import { parseCommand } from './process';

describe('parseCommand refuses installs through allow-listed binaries', () => {
  it.each([
    'npm install --global cowsay',
    'npm i -g cowsay',
    'npm add --global cowsay',
    'cargo install ripgrep',
    'go install example.com/tool@latest',
    'python3 -m pip install requests',
  ])('%s is refused and routed to system.install', (command) => {
    const parsed = parseCommand(command);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/Installing software is not something this can do/);
    expect(parsed.reason).toMatch(/system\.install/);
  });

  it.each([
    'npm test',
    'npm install',
    'npm ci',
    'cargo build',
    'go test ./...',
    'git status',
  ])('%s is ordinary project work and is allowed', (command) => {
    expect(parseCommand(command).ok).toBe(true);
  });

  it('refuses shell operators and binaries off the allow-list', () => {
    expect(parseCommand('npm test && npm i -g cowsay').ok).toBe(false);
    expect(parseCommand('pacman -S cowsay').ok).toBe(false);
    expect(parseCommand('sudo npm i -g cowsay').ok).toBe(false);
  });
});
