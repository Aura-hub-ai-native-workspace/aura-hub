/**
 * exec/which — finding an executable the way the running OS finds one.
 * ==================================================================
 * Every spawn in this service goes through `execFile` with a bare binary
 * name (`git`, `npm`, `opencode`). On Unix that is complete: the OS
 * resolves the name against PATH and runs it. On Windows it is not, and
 * the gap is not cosmetic:
 *
 *   • PATH is separated by `;`, not `:`;
 *   • an executable is `git.exe`, not `git` — the extension comes from
 *     PATHEXT, which the user can change;
 *   • anything installed by npm (`npm` itself, `npx`, `opencode`, `gh`
 *     extensions) is a `.cmd` shim, and since the fix for CVE-2024-27980
 *     Node refuses to spawn a `.cmd` without a shell at all.
 *
 * The consequence for AURA is worse than a failed command. `environment.ts`
 * decides a tool is "not installed" when the spawn reports ENOENT — so on
 * Windows, every npm-installed tool the user genuinely has would be
 * reported absent. A confident wrong answer about the machine is the exact
 * failure this codebase refuses to produce, so detection has to resolve
 * executables the way Windows does rather than the way Unix does.
 *
 * Everything here is a pure function over an injected platform, PATH,
 * PATHEXT and file test. That is deliberate: it means the Windows branch
 * can be exercised and proved on Linux, instead of being reasoned about
 * and hoped for.
 */

import { statSync, accessSync, constants } from 'node:fs';

export type Platform = 'win32' | 'posix';

/** How the current process should be treated. */
export const currentPlatform = (): Platform => (process.platform === 'win32' ? 'win32' : 'posix');

export interface ResolveEnv {
  platform: Platform;
  /** Raw PATH value. Split with the platform's own delimiter, never `:`. */
  pathEnv: string;
  /** Raw PATHEXT value (Windows only). */
  pathExt?: string;
  /** Is this exact path a file we may execute? Injected so tests are real. */
  isExecutableFile: (candidate: string) => boolean;
}

/** What Windows uses when PATHEXT is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Path separator for a platform — never taken from the host we run on. */
const delimiterFor = (platform: Platform) => (platform === 'win32' ? ';' : ':');

const sepFor = (platform: Platform) => (platform === 'win32' ? '\\' : '/');

/** Does this look like a path rather than a bare name? */
export function isPathLike(name: string, platform: Platform): boolean {
  return platform === 'win32'
    ? name.includes('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
    : name.includes('/');
}

/**
 * The real file on disk for a bare binary name, or null.
 *
 * On Windows a name is tried both as given (the user may have written
 * `node.exe`) and with each PATHEXT extension, in PATHEXT order, because
 * that order is what decides which of `foo.exe` and `foo.cmd` actually
 * runs. The current directory is deliberately NOT searched: Windows'
 * command interpreter does search it, and that is precisely how a stray
 * `git.exe` in a project folder would hijack a probe.
 */
export function resolveExecutableWith(name: string, env: ResolveEnv): string | null {
  const raw = (name ?? '').trim();
  if (!raw) return null;

  const sep = sepFor(env.platform);
  // PATHEXT is uppercase by convention (`.EXE`) while files on disk are
  // not (`git.exe`). NTFS is case-insensitive so either finds the file, but
  // the resolved path is shown to users and stored in results — so it is
  // built in the casing the file actually has. Order is preserved, because
  // PATHEXT order is what decides whether `foo.exe` or `foo.cmd` wins.
  const extensions =
    env.platform === 'win32'
      ? ['', ...(env.pathExt ?? DEFAULT_PATHEXT).split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)]
      : [''];

  const tryDir = (dir: string): string | null => {
    for (const ext of extensions) {
      // Already carries a known extension — do not build `node.exe.exe`.
      if (ext && raw.toLowerCase().endsWith(ext.toLowerCase())) continue;
      const candidate = dir ? `${dir}${dir.endsWith(sep) ? '' : sep}${raw}${ext}` : `${raw}${ext}`;
      if (env.isExecutableFile(candidate)) return candidate;
    }
    return null;
  };

  // An explicit path is used as given, not searched for.
  if (isPathLike(raw, env.platform)) return tryDir('');

  for (const dir of env.pathEnv.split(delimiterFor(env.platform))) {
    if (!dir) continue;
    // Windows tolerates quoted PATH entries; Unix does not quote them.
    const clean = env.platform === 'win32' ? dir.replace(/^"|"$/g, '') : dir;
    const hit = tryDir(clean);
    if (hit) return hit;
  }
  return null;
}

/** `isExecutableFile` for the machine this process is actually on. */
export function isExecutableFileOnDisk(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  // Windows has no execute bit — being a file with an executable extension
  // is the whole test there, and X_OK would answer for the wrong OS.
  if (process.platform === 'win32') return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve against the real environment of the running process. */
export function resolveExecutable(name: string): string | null {
  return resolveExecutableWith(name, {
    platform: currentPlatform(),
    pathEnv: process.env.PATH ?? '',
    pathExt: process.env.PATHEXT,
    isExecutableFile: isExecutableFileOnDisk,
  });
}

/* ── launching what we found ─────────────────────────────────────── */

export interface SpawnTarget {
  file: string;
  args: string[];
}

export class UnsafeArgumentError extends Error {}

/**
 * Characters that survive `cmd.exe`'s second parse and change meaning.
 *
 * `&`, `|`, `<`, `>`, `^` and `(` `)` can be neutralised by quoting, but
 * `%` cannot: `cmd /c` expands `%FOO%` inside quotes as well as outside,
 * so an argument containing `%` could interpolate an environment variable
 * — leaking its value into a command line, or into an agent's task text.
 * A double quote is equally unfixable, because it ends the quoting the
 * escape depends on. Neither is worth guessing at, so both are refused.
 */
const CMD_UNQUOTABLE = /[%"\r\n]/;

/**
 * Wrap one argument so `cmd.exe` passes it through unchanged.
 *
 * Inside double quotes cmd stops treating `& | < > ^ ( )` as syntax, which
 * is why quoting is the escape and not caret-prefixing every character.
 */
export function quoteForCmd(arg: string): string {
  if (CMD_UNQUOTABLE.test(arg)) {
    throw new UnsafeArgumentError(
      `On Windows this argument has to pass through cmd.exe, which would reinterpret ${
        /%/.test(arg) ? "'%'" : /["]/.test(arg) ? 'the quote character' : 'the line break'
      } in it. AURA will not guess at what you meant — remove it and try again.`,
    );
  }
  return `"${arg}"`;
}

/**
 * Turn a resolved executable into something `execFile` can actually run.
 *
 * On Unix, and for a real `.exe`, this is the file itself. A `.cmd`/`.bat`
 * shim is not a program — it is a script for the command interpreter — so
 * it goes to `cmd.exe /d /s /c`, with each argument quoted individually.
 * `windowsVerbatimArguments` is set by the caller so Node hands our quoting
 * to Windows untouched instead of applying a second, C-runtime-shaped one
 * on top of it.
 */
export function spawnTargetFor(resolved: string, args: string[], platform: Platform): SpawnTarget {
  if (platform !== 'win32') return { file: resolved, args };
  const lower = resolved.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return { file: resolved, args };
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', quoteForCmd(resolved), ...args.map(quoteForCmd)],
  };
}

/** True when `spawnTargetFor` produced a cmd.exe invocation. */
export const isCmdShim = (resolved: string, platform: Platform): boolean =>
  platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);

/**
 * What to hand `execFile` for a bare binary name.
 *
 * Returns null when the binary genuinely is not on PATH, so the caller can
 * report "not installed" honestly instead of surfacing an ENOENT from a
 * name that was never resolvable.
 *
 * On Unix an unresolvable name still falls back to the bare name: the OS
 * resolver has always been the authority there, and this must not turn a
 * tool that `execFile` can find into one AURA claims is missing.
 */
export function launchSpec(name: string, args: string[]): { target: SpawnTarget; resolved: string | null } {
  const platform = currentPlatform();
  const resolved = resolveExecutable(name);
  // Unresolved: hand the bare name to `execFile` and let the OS have the
  // final word. On Windows that will fail for a `.cmd` — which is correct,
  // because a `.cmd` we could not find is one we cannot safely launch.
  if (!resolved) return { target: { file: name, args }, resolved: null };
  return { target: spawnTargetFor(resolved, args, platform), resolved };
}

/** `execFile` options that must accompany a `spawnTargetFor` result. */
export const spawnFlags = (target: SpawnTarget) =>
  currentPlatform() === 'win32' && /cmd\.exe$/i.test(target.file)
    ? { windowsVerbatimArguments: true, windowsHide: true }
    : { windowsHide: true };
