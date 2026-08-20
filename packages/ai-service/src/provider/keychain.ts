/**
 * provider/keychain — the operating system's secret store, or nothing.
 * ==================================================================
 * What this replaces was not encryption. `credentialStore.ts` encrypted
 * provider API keys with AES-256-GCM and then wrote the key beside the
 * ciphertext, in the same JSON file, derived by an unsalted SHA-256 of a
 * random seed also in that file. Anyone who could read the file could
 * decrypt it by reading the file. That is obfuscation — it raises the
 * cost of reading a stolen key from "open it" to "open it and run four
 * lines of node" — and describing it as encryption is worse than not
 * having it, because a user who believes their keys are encrypted stores
 * keys they would not otherwise store.
 *
 * The real answer is that the machine already has a place for this, and
 * that place is guarded by the user's login session rather than by a
 * secret sitting next to the thing it protects:
 *
 *   linux   — the Secret Service API, through `secret-tool` (libsecret).
 *   darwin  — the login keychain, through `security`.
 *   win32   — DPAPI, through PowerShell's ConvertFrom-SecureString,
 *             which binds the ciphertext to this user on this machine.
 *
 * ── Why no npm package ─────────────────────────────────────────────
 *
 * The backend has zero third-party runtime dependencies, and every
 * keychain binding on npm is a native module: a compiler at install
 * time, a prebuilt binary per platform and per Node ABI, and a new
 * supply-chain surface for the one component whose whole job is holding
 * secrets. So each backend here drives the OS's own command-line tool
 * instead. The trade-off is real and is recorded in QUESTIONS.md — the
 * tools are less expressive than the C APIs, and `secret-tool` is not
 * installed everywhere — but it keeps the dependency count at zero and
 * keeps the code auditable in one file.
 *
 * ── Two rules ──────────────────────────────────────────────────────
 *
 *   • **The secret never touches a command line.** Every backend takes
 *     it on stdin. An argument vector is readable by any process on the
 *     machine through `ps`, which would defeat the point entirely.
 *
 *   • **A backend that cannot be verified is unavailable.** Probing is a
 *     real round trip — write a value, read it back, delete it — not a
 *     check that a binary exists. On this project's development machine
 *     `secret-tool` is installed while no Secret Service is running, and
 *     a probe that stopped at "the binary is there" would report a
 *     keychain that silently fails to store anything.
 *
 * Synchronous throughout, deliberately. These operations are rare and
 * user-initiated (connecting a provider, reading a key to make a
 * request), and `credentialStore`'s callers are synchronous. Making the
 * whole provider stack async to spawn a process a handful of times would
 * be a large change for no benefit.
 */

import { execFileSync } from 'node:child_process';
import { resolveExecutable } from '../exec/which';

/** Namespace for every secret AURA stores. One service, many accounts. */
const SERVICE = 'aura-hub';

const TIMEOUT_MS = 10_000;

export type KeychainBackendId = 'libsecret' | 'macos-keychain' | 'windows-dpapi';

export interface KeychainProbe {
  backend: KeychainBackendId | null;
  available: boolean;
  /** Plain language. Names what is missing when it is not available. */
  detail: string;
  missing: string[];
}

/**
 * Run a command, handing it `input` on stdin, and return stdout.
 *
 * Returns null on any failure. A keychain operation that half-worked is
 * not a category this module recognises: either the secret is in the
 * store and readable, or it is not there and the caller must be told.
 */
function run(file: string, args: string[], input?: string): string | null {
  try {
    return execFileSync(file, args, {
      input: input ?? '',
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
      // stderr is captured rather than inherited so a backend's
      // diagnostics never leak into the service's own output — on some
      // of these tools that output can include the attributes a secret
      // was stored under.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════
   Backends
   ══════════════════════════════════════════════════════════════════ */

interface Backend {
  id: KeychainBackendId;
  /** The executable this backend drives. */
  tool: string;
  set(tool: string, account: string, secret: string): boolean;
  get(tool: string, account: string): string | null;
  remove(tool: string, account: string): boolean;
}

/**
 * Linux — the freedesktop Secret Service, through libsecret's CLI.
 *
 * `secret-tool store` reads the secret from stdin, which is precisely
 * why it is usable here: the value never appears in an argument vector.
 * The attribute pair (`service`, `account`) is the lookup key and is not
 * itself secret.
 */
const libsecret: Backend = {
  id: 'libsecret',
  tool: 'secret-tool',
  set: (tool, account, secret) =>
    run(tool, ['store', '--label', `AURA Hub — ${account}`, 'service', SERVICE, 'account', account], secret) !== null,
  get: (tool, account) => {
    const out = run(tool, ['lookup', 'service', SERVICE, 'account', account]);
    // `secret-tool lookup` prints the secret with no trailing newline of
    // its own, but a secret may legitimately end in whitespace, so only
    // a single trailing newline the tool might add is removed.
    return out === null ? null : out.replace(/\n$/, '');
  },
  remove: (tool, account) => run(tool, ['clear', 'service', SERVICE, 'account', account]) !== null,
};

/**
 * macOS — the login keychain, through `security`.
 *
 * `-w` with no value makes `add-generic-password` read the password from
 * stdin rather than from the command line. `-U` updates an existing item
 * instead of failing on a duplicate.
 *
 * NOT RUNTIME VERIFIED: this project has no macOS machine. See
 * HANDOFF.md for the exact command a human must run on one.
 */
const macosKeychain: Backend = {
  id: 'macos-keychain',
  tool: 'security',
  set: (tool, account, secret) =>
    run(tool, ['add-generic-password', '-U', '-a', account, '-s', SERVICE, '-w'], secret) !== null,
  get: (tool, account) => {
    const out = run(tool, ['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
    return out === null ? null : out.replace(/\n$/, '');
  },
  remove: (tool, account) =>
    run(tool, ['delete-generic-password', '-a', account, '-s', SERVICE]) !== null,
};

/**
 * Windows — DPAPI, through PowerShell.
 *
 * `ConvertFrom-SecureString` protects with DPAPI under the CURRENT USER
 * scope: the ciphertext is decryptable only by this user on this
 * machine, by the operating system, without AURA holding a key at all.
 * That is the property the old scheme lacked.
 *
 * The protected blob is stored on disk by the caller rather than in
 * Credential Manager, because `cmdkey` — the only in-box CLI for
 * Credential Manager — cannot read a stored password back out. DPAPI
 * gives the guarantee that matters; Credential Manager would only add a
 * place to put it.
 *
 * `-NoProfile` because a user's PowerShell profile is arbitrary code and
 * must not run as a side effect of reading a secret.
 *
 * NOT RUNTIME VERIFIED: this project has no Windows machine.
 */
const PS_PROTECT = '$s=[Console]::In.ReadToEnd().TrimEnd("`r","`n");' +
  '$ss=ConvertTo-SecureString -String $s -AsPlainText -Force;' +
  'Write-Output (ConvertFrom-SecureString -SecureString $ss)';

const PS_UNPROTECT = '$e=[Console]::In.ReadToEnd().Trim();' +
  '$ss=ConvertTo-SecureString -String $e;' +
  '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);' +
  'try{Write-Output ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}' +
  'finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}';

/**
 * DPAPI blobs, held in memory for the life of the process and persisted
 * by `credentialStore`.
 *
 * Windows is the one backend that is not itself a store — DPAPI protects
 * a value, it does not keep it — so the ciphertext has to live
 * somewhere. `credentialStore` writes it into `providers.json`, which is
 * safe in a way the old scheme was not: the key is held by the operating
 * system under the user's login, and is not in the file.
 */
const dpapiBlobs = new Map<string, string>();

const windowsDpapi: Backend = {
  id: 'windows-dpapi',
  tool: 'powershell',
  set: (tool, account, secret) => {
    const blob = run(tool, ['-NoProfile', '-NonInteractive', '-Command', PS_PROTECT], secret);
    if (!blob) return false;
    dpapiBlobs.set(account, blob.trim());
    return true;
  },
  get: (tool, account) => {
    const blob = dpapiBlobs.get(account);
    if (!blob) return null;
    const out = run(tool, ['-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT], blob);
    return out === null ? null : out.replace(/\r?\n$/, '');
  },
  remove: (_tool, account) => {
    dpapiBlobs.delete(account);
    return true;
  },
};

/** The DPAPI ciphertext for an account, so the caller can persist it. */
export const dpapiBlobFor = (account: string): string | undefined => dpapiBlobs.get(account);

/** Reinstate a persisted DPAPI ciphertext after a restart. */
export const restoreDpapiBlob = (account: string, blob: string): void => {
  dpapiBlobs.set(account, blob);
};

function backendForPlatform(): Backend | null {
  if (process.platform === 'linux') return libsecret;
  if (process.platform === 'darwin') return macosKeychain;
  if (process.platform === 'win32') return windowsDpapi;
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   Probing — a real round trip, not a `which`
   ══════════════════════════════════════════════════════════════════ */

let probeCache: KeychainProbe | null = null;

/**
 * Is there a working OS secret store here?
 *
 * The probe WRITES a throwaway value, reads it back, compares it, and
 * deletes it. Nothing less is sufficient: on this project's development
 * machine `secret-tool` is installed and on PATH while no Secret Service
 * is running to answer it, so a presence check would report a keychain
 * that accepts every store and returns nothing. The round trip is the
 * only test that distinguishes "installed" from "working".
 *
 * The probe value is random and namespaced, and is removed whether or
 * not the read succeeded.
 */
export function probeKeychain(refresh = false): KeychainProbe {
  if (!refresh && probeCache) return probeCache;

  const backend = backendForPlatform();
  if (!backend) {
    return (probeCache = {
      backend: null,
      available: false,
      detail: `No OS keychain backend exists for ${process.platform}.`,
      missing: ['a supported platform'],
    });
  }

  const tool = resolveExecutable(backend.tool);
  if (!tool) {
    return (probeCache = {
      backend: backend.id,
      available: false,
      detail: `${backend.tool} is not installed, so the ${backend.id} keychain cannot be used.`,
      missing: [backend.tool],
    });
  }

  const account = `__aura_probe_${Math.random().toString(36).slice(2)}`;
  const expected = `probe-${Date.now()}`;
  let readBack: string | null = null;
  const stored = backend.set(tool, account, expected);
  if (stored) readBack = backend.get(tool, account);
  backend.remove(tool, account);

  const available = stored && readBack === expected;
  return (probeCache = {
    backend: backend.id,
    available,
    detail: available
      ? `The ${backend.id} keychain answered a full write, read and delete, so AURA will keep provider keys there.`
      : stored
        ? `${backend.tool} accepted a value but did not return it, so the keychain is not actually storing anything. On Linux this normally means no Secret Service (gnome-keyring or kwallet) is running in this session.`
        : `${backend.tool} is installed but could not store a value. On Linux this normally means no Secret Service is running in this session.`,
    missing: available ? [] : [`a working ${backend.id} service`],
  });
}

/* ══════════════════════════════════════════════════════════════════
   The operations
   ══════════════════════════════════════════════════════════════════ */

/** Store a secret. Returns false when there is no working keychain. */
export function keychainSet(account: string, secret: string): boolean {
  const probe = probeKeychain();
  const backend = backendForPlatform();
  if (!probe.available || !backend) return false;
  const tool = resolveExecutable(backend.tool);
  return tool ? backend.set(tool, account, secret) : false;
}

/** Read a secret back, or null when it is absent or unreadable. */
export function keychainGet(account: string): string | null {
  const probe = probeKeychain();
  const backend = backendForPlatform();
  if (!probe.available || !backend) return null;
  const tool = resolveExecutable(backend.tool);
  return tool ? backend.get(tool, account) : null;
}

/** Remove a secret. True when it is gone afterwards. */
export function keychainDelete(account: string): boolean {
  const backend = backendForPlatform();
  if (!backend) return false;
  const tool = resolveExecutable(backend.tool);
  return tool ? backend.remove(tool, account) : false;
}

/** Drop the probe cache. Used by verification, which measures twice. */
export function resetKeychainProbe(): void {
  probeCache = null;
}
