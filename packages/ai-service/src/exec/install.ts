/**
 * exec/install — turning catalogue knowledge into a governed install plan.
 * ==================================================================
 * This module decides three things and nothing else:
 *
 *   1. which command would install a node,
 *   2. what privilege that genuinely needs ON THIS MACHINE,
 *   3. whether AURA may run it.
 *
 * It performs no installation. It spawns nothing. `system.install`'s
 * executor asks it for a plan, and the plan is either something the
 * existing process primitive can run as the current user, or an
 * instruction for the human (§25.3).
 *
 * The package name never comes from a caller. It comes from
 * `CatalogEntry.install`, which is data in the repository — the same
 * invariant that keeps probing safe, applied to a far more dangerous verb.
 */

import { accessSync, constants, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchSpec, spawnFlags } from './which';
import type { CatalogEntry, InstallPrivilege, InstallSpec } from '@aura/connected-environment';

/** What AURA would do about an install, before any of it happens. */
export interface InstallPlan {
  /** True when AURA may run this itself as the current user. */
  executable: boolean;
  privilege: InstallPrivilege;
  /** Installer binary — always on `INSTALLER_BINARIES` when `executable`. */
  bin: string;
  args: string[];
  /** The whole thing as one line, for display and for the guided path. */
  command: string;
  /** Why this needs the privilege it needs, in plain language. */
  why: string;
}

/** A node that cannot be installed by AURA at all, and the honest reason. */
export interface NoInstallPlan {
  executable: false;
  reason: string;
}

export type PlanResult = InstallPlan | NoInstallPlan;

export const isPlan = (r: PlanResult): r is InstallPlan => 'command' in r;

/* ── privilege detection (§25.2) ──────────────────────────────────── */

/**
 * Can the current user write here, treating a not-yet-created directory
 * as writable if its nearest existing ancestor is?
 *
 * §25.2 C2: `~/.cargo/bin` does not exist until the first `cargo install`
 * creates it. Stat'ing the leaf would report "not writable" and escalate a
 * perfectly ordinary userspace install to the root tier, sending the user
 * to a terminal for no reason.
 */
export function writableWithAncestors(target: string): boolean {
  let dir = path.resolve(target);
  for (;;) {
    try {
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      const parent = path.dirname(dir);
      // Reached the root without finding anything writable.
      if (parent === dir) return false;
      try {
        // Only walk up past directories that genuinely do not exist. A
        // directory that EXISTS and is not writable is a real refusal, not
        // something to look past.
        accessSync(dir, constants.F_OK);
        return false;
      } catch {
        dir = parent;
      }
    }
  }
}

/** Where `npm install -g` would actually write on this machine. */
function npmGlobalRoot(): string | null {
  try {
    // `npm` is `npm.cmd` on Windows, which Node will not spawn directly.
    // Asking by bare name there throws ENOENT, and the catch below would
    // read that as "cannot determine the prefix" and escalate an ordinary
    // userspace install to the root tier — sending every Windows user to a
    // terminal, with a `sudo` command that does not exist on their OS.
    const { target } = launchSpec('npm', ['config', 'get', 'prefix']);
    const prefix = execFileSync(target.file, target.args, {
      encoding: 'utf8',
      timeout: 10_000,
      ...spawnFlags(target),
    }).trim();
    if (!prefix || prefix === 'undefined') return null;
    // Layout is a platform fact, not a preference: Windows keeps global
    // modules directly under the prefix (%APPDATA%\npm\node_modules), Unix
    // under prefix/lib/node_modules.
    return process.platform === 'win32'
      ? path.join(prefix, 'node_modules')
      : path.join(prefix, 'lib', 'node_modules');
  } catch {
    return null;
  }
}

/**
 * The privilege an install genuinely needs here.
 *
 * The catalogue value is a FLOOR (§25.2 C1). This may raise it — never
 * lower it. A machine whose npm prefix is `/usr` needs root for a package
 * the catalogue calls userspace, and answering "user" there produces an
 * EACCES that reads like an AURA defect. Escalating is always safe;
 * de-escalating never happens, at any point in this function.
 */
export function resolvePrivilege(spec: InstallSpec): { privilege: InstallPrivilege; why: string } {
  if (spec.privilege === 'root') {
    return {
      privilege: 'root',
      why: 'Installing a system package changes software for every user on this machine, which needs administrator rights.',
    };
  }

  switch (spec.method) {
    case 'npm-global': {
      const root = npmGlobalRoot();
      if (!root) {
        return {
          privilege: 'root',
          why: 'AURA could not determine where npm installs global packages, so it will not assume it may write there.',
        };
      }
      return writableWithAncestors(root)
        ? { privilege: 'user', why: `npm installs global packages into ${root}, which you own.` }
        : {
            privilege: 'root',
            why: `npm installs global packages into ${root}, which your user cannot write to.`,
          };
    }
    case 'cargo': {
      const home = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
      const bin = path.join(home, 'bin');
      return writableWithAncestors(bin)
        ? { privilege: 'user', why: `cargo installs into ${bin}, which you own.` }
        : { privilege: 'root', why: `cargo would install into ${bin}, which your user cannot write to.` };
    }
    case 'pipx': {
      const bin = process.env.PIPX_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
      return writableWithAncestors(bin)
        ? { privilege: 'user', why: `pipx installs into ${bin}, which you own.` }
        : { privilege: 'root', why: `pipx would install into ${bin}, which your user cannot write to.` };
    }
    case 'gh-extension': {
      const bin = path.join(os.homedir(), '.local', 'share', 'gh');
      return writableWithAncestors(bin)
        ? { privilege: 'user', why: `GitHub CLI keeps extensions in ${bin}, which you own.` }
        : { privilege: 'root', why: `GitHub CLI would write to ${bin}, which your user cannot write to.` };
    }
    case 'system-package':
      return {
        privilege: 'root',
        why: 'Installing a system package changes software for every user on this machine, which needs administrator rights.',
      };
  }
}

/* ── distro detection, for the guided command only ────────────────── */

/**
 * Which distro family this is, from `/etc/os-release`.
 *
 * Used ONLY to name the right package manager in an instruction the user
 * runs themselves. AURA never executes any of these.
 */
export function detectDistro(): { id: string; manager: string; installArgs: string[] } {
  let id = '';
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    id = /^ID=("?)(.+?)\1$/m.exec(release)?.[2]?.trim() ?? '';
    if (!id) {
      id = /^ID_LIKE=("?)(.+?)\1$/m.exec(release)?.[2]?.split(/\s+/)[0]?.trim() ?? '';
    }
  } catch {
    /* Not Linux, or no os-release. Falls through to the unknown case. */
  }

  switch (id) {
    case 'arch':
    case 'manjaro':
    case 'endeavouros':
      return { id: 'arch', manager: 'pacman', installArgs: ['-S', '--needed'] };
    case 'debian':
    case 'ubuntu':
    case 'pop':
    case 'linuxmint':
      return { id: 'debian', manager: 'apt', installArgs: ['install'] };
    case 'fedora':
    case 'rhel':
    case 'centos':
      return { id: 'fedora', manager: 'dnf', installArgs: ['install'] };
    default:
      return { id: id || 'unknown', manager: '', installArgs: [] };
  }
}

/* ── plan construction ────────────────────────────────────────────── */

/** Quote a token for display in a shell instruction, if it needs it. */
const show = (token: string) => (/^[A-Za-z0-9._@/:+-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`);

const line = (bin: string, args: string[]) => [bin, ...args].map(show).join(' ');

/**
 * The same command, marked as needing administrator rights on the platform
 * the user is actually on.
 *
 * `sudo` is a Unix program. Printing it to a Windows user would be an
 * instruction they cannot follow — and this string is the whole deliverable
 * of the guided path (§25.3), so getting it wrong wastes the one thing AURA
 * hands over when it refuses to act.
 */
const elevated = (cmd: string) =>
  process.platform === 'win32' ? `${cmd}   (run this in an Administrator terminal)` : `sudo ${cmd}`;

/**
 * Work out what installing this node would take.
 *
 * Returns a `NoInstallPlan` — not a throw and not a guess — when the
 * catalogue has no `InstallSpec`. "AURA does not know how to install this"
 * is a legitimate answer and must reach the user as one.
 */
export function planInstall(entry: CatalogEntry): PlanResult {
  const spec = entry.install;
  if (!spec) {
    return {
      executable: false,
      reason: `AURA has no verified way to install ${entry.name}, so it will not guess at one. See ${entry.homepage} for the project's own instructions.`,
    };
  }

  const { privilege, why } = resolvePrivilege(spec);

  if (privilege === 'root') {
    const distro = detectDistro();
    // Distro-specific package name where the catalogue records one.
    const pkg = (distro.id && spec.distro?.[distro.id]) || spec.package;

    if (spec.method !== 'system-package') {
      // A userspace method that escalated (§25.2 C1) — e.g. an npm prefix
      // under /usr. The command is still the userspace one; only the
      // privilege changed, so say exactly that rather than inventing a
      // distro package that may not exist.
      const base = userspaceCommand(spec, spec.package);
      return base
        ? { executable: false, privilege, bin: base.bin, args: base.args, command: elevated(line(base.bin, base.args)), why }
        : { executable: false, reason: `AURA has no verified way to install ${entry.name} on this machine.` };
    }

    if (!distro.manager) {
      return {
        executable: false,
        reason: `${entry.name} is a system package, and AURA could not identify this machine's package manager. Install it the way your distribution recommends: ${entry.homepage}`,
      };
    }
    return {
      executable: false,
      privilege,
      bin: distro.manager,
      args: [...distro.installArgs, pkg],
      command: elevated(line(distro.manager, [...distro.installArgs, pkg])),
      why,
    };
  }

  const base = userspaceCommand(spec, spec.package);
  if (!base) {
    return { executable: false, reason: `AURA has no verified way to install ${entry.name} on this machine.` };
  }
  return {
    executable: true,
    privilege: 'user',
    bin: base.bin,
    args: base.args,
    command: line(base.bin, base.args),
    why,
  };
}

/**
 * The argv for a userspace install method.
 *
 * Every binary here is on `INSTALLER_BINARIES`; nothing assembles a shell
 * string, and the package is the only variable part.
 */
function userspaceCommand(spec: InstallSpec, pkg: string): { bin: string; args: string[] } | null {
  switch (spec.method) {
    case 'npm-global':
      return { bin: 'npm', args: ['install', '--global', pkg] };
    case 'pipx':
      return { bin: 'pipx', args: ['install', pkg] };
    case 'cargo':
      return { bin: 'cargo', args: ['install', pkg] };
    case 'gh-extension':
      return { bin: 'gh', args: ['extension', 'install', pkg] };
    case 'system-package':
      // Never userspace, by definition. Reaching here would be a bug in
      // `resolvePrivilege`, so refuse rather than improvise.
      return null;
  }
}

/** Trusted uninstall argv derived from the catalog InstallSpec. */
function userspaceUninstallCommand(spec: InstallSpec, pkg: string): { bin: string; args: string[] } | null {
  switch (spec.method) {
    case 'npm-global':
      return { bin: 'npm', args: ['uninstall', '--global', pkg] };
    case 'pipx':
      return { bin: 'pipx', args: ['uninstall', pkg] };
    case 'cargo':
      return { bin: 'cargo', args: ['uninstall', pkg] };
    case 'gh-extension':
      return { bin: 'gh', args: ['extension', 'remove', pkg] };
    case 'system-package':
      return null;
  }
}

export type UninstallPlanResult = PlanResult;

export function planUninstall(entry: CatalogEntry): PlanResult {
  const spec = entry.install;
  if (!spec) {
    return {
      executable: false,
      reason: `AURA has no verified way to uninstall ${entry.name}, so it will not guess at one. See ${entry.homepage} for the project's own instructions.`,
    };
  }
  const { privilege, why } = resolvePrivilege(spec);
  if (privilege === 'root') {
    const distro = detectDistro();
    const pkg = (distro.id && (spec.distro as Record<string, string> | undefined)?.[distro.id]) || spec.package;
    if (spec.method !== 'system-package') {
      const base = userspaceUninstallCommand(spec, spec.package);
      return base
        ? { executable: false, privilege, bin: base.bin, args: base.args, command: elevated(line(base.bin, base.args)), why }
        : { executable: false, reason: `AURA has no verified way to uninstall ${entry.name} on this machine.` };
    }
    if (!distro.manager) {
      return {
        executable: false,
        reason: `${entry.name} is a system package, and AURA could not identify this machine's package manager. Remove it the way your distribution recommends: ${entry.homepage}`,
      };
    }
    const removeArgs =
      distro.id === 'arch' ? ['-R']
      : distro.id === 'debian' ? ['remove']
      : distro.id === 'fedora' ? ['remove']
      : distro.id === 'macos' ? ['uninstall']
      : distro.id === 'windows' ? ['uninstall']
      : [];
    if (removeArgs.length === 0) {
      return {
        executable: false,
        reason: `AURA has no verified removal command for ${entry.name} on this machine. Remove it the way your distribution recommends: ${entry.homepage}`,
      };
    }
    return {
      executable: false,
      privilege,
      bin: distro.manager,
      args: [...removeArgs, pkg],
      command: elevated(line(distro.manager, [...removeArgs, pkg])),
      why,
    };
  }
  const base = userspaceUninstallCommand(spec, spec.package);
  if (!base) {
    return { executable: false, reason: `AURA has no verified way to uninstall ${entry.name} on this machine.` };
  }
  return { executable: true, privilege: 'user', bin: base.bin, args: base.args, command: line(base.bin, base.args), why };
}
