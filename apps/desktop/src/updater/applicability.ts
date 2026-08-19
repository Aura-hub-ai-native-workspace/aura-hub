/**
 * Is this candidate applicable to THIS install?
 * ==================================================================
 * Pure functions, no I/O, no Tauri. This is the client-side policy gate
 * the update engine runs before it will download anything, and it is the
 * part of the updater AURA actually owns — so it is testable to the last
 * branch without a native runtime.
 *
 * It answers applicability, never authenticity. A candidate that passes
 * every check here is still worthless until `tauri-plugin-updater` has
 * verified its minisign signature; nothing in this file substitutes for
 * that, and no result here may be read as "safe to install".
 *
 * ── Fail closed ──────────────────────────────────────────────────────
 * Every function refuses on anything it does not positively understand.
 * A malformed version, an unrecognised target, a missing field: all are
 * rejections, never "probably fine". The update path is the one place a
 * permissive default would let a server decide what runs on the user's
 * machine.
 */

import {
  SUPPORTED_TARGETS,
  type UpdateCandidate,
  type UpdateErrorCode,
  type UpdateTarget,
} from './types';

/* ── Semantic versions ───────────────────────────────────────────── */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers, e.g. `beta.1`. Empty for a stable release. */
  prerelease: string[];
}

/**
 * Strict parse. Deliberately narrower than the full semver grammar:
 * build metadata is not accepted, because this product does not publish
 * it and silently tolerating an unknown shape is how a malformed version
 * becomes an installed one.
 */
export function parseVersion(input: unknown): SemVer | null {
  if (typeof input !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  // Reject leading zeros — "01.2.3" and "1.2.3" must not both be accepted
  // as the same version by different readers.
  if (/^0\d/.test(major) || /^0\d/.test(minor) || /^0\d/.test(patch)) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split('.') : [],
  };
}

/** -1 if a < b, 0 if equal, 1 if a > b. Semver precedence rules. */
export function compareVersions(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A pre-release always precedes its own release: 1.0.0-beta < 1.0.0.
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;

  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    // Numeric identifiers rank below alphanumeric ones, and numerically
    // among themselves.
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/* ── Target identity ─────────────────────────────────────────────── */

/**
 * Map a runtime OS/arch pair onto the four targets this product ships.
 *
 * Anything unrecognised returns null and is refused upstream. AURA does
 * not guess a "closest" target — installing an artifact built for another
 * platform is the failure this exists to prevent.
 */
export function resolveTarget(os: string, arch: string): UpdateTarget | null {
  const o = os.trim().toLowerCase();
  const a = arch.trim().toLowerCase();

  const arch64 = a === 'x86_64' || a === 'x64' || a === 'amd64';
  const armMac = a === 'aarch64' || a === 'arm64';

  if (o === 'linux' && arch64) return 'linux-x86_64';
  if ((o === 'windows' || o === 'win32') && arch64) return 'windows-x86_64';
  if (o === 'darwin' || o === 'macos') {
    if (arch64) return 'darwin-x86_64';
    if (armMac) return 'darwin-aarch64';
  }
  return null;
}

export function isSupportedTarget(target: string): target is UpdateTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}

/* ── Metadata ────────────────────────────────────────────────────── */

/**
 * The shape Tauri's updater publishes. Restated here only so AURA can
 * pre-validate it — this is NOT a second manifest format, and AURA never
 * writes one. Tauri remains the authority on what it will accept.
 */
export interface UpdateMetadata {
  version: string;
  pub_date?: string;
  notes?: string;
  /** AURA extension, optional. Absent means "not mandatory". */
  mandatory?: boolean;
  platforms: Record<string, { signature: string; url: string }>;
}

export type MetadataValidation =
  | { ok: true; metadata: UpdateMetadata }
  | { ok: false; code: UpdateErrorCode; detail: string };

/**
 * Structural validation of update metadata.
 *
 * Rejects anything that is not unambiguously well-formed, including a
 * platform entry with an empty signature — an artifact offered without a
 * signature can never become installable, so refusing it here means the
 * user is told why instead of watching a download fail at verification.
 */
export function validateMetadata(raw: unknown): MetadataValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_METADATA', detail: 'Update metadata is not an object.' };
  }
  const m = raw as Record<string, unknown>;

  if (!parseVersion(m.version)) {
    return { ok: false, code: 'INVALID_METADATA', detail: `Update metadata has no usable version (${JSON.stringify(m.version)}).` };
  }
  if (m.platforms === null || typeof m.platforms !== 'object' || Array.isArray(m.platforms)) {
    return { ok: false, code: 'INVALID_METADATA', detail: 'Update metadata has no platforms map.' };
  }

  const platforms = m.platforms as Record<string, unknown>;
  if (Object.keys(platforms).length === 0) {
    return { ok: false, code: 'INVALID_METADATA', detail: 'Update metadata lists no platforms.' };
  }

  for (const [key, value] of Object.entries(platforms)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, code: 'INVALID_METADATA', detail: `Platform "${key}" is not an object.` };
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.url !== 'string' || entry.url.length === 0) {
      return { ok: false, code: 'INVALID_METADATA', detail: `Platform "${key}" has no artifact URL.` };
    }
    if (typeof entry.signature !== 'string' || entry.signature.length === 0) {
      return { ok: false, code: 'INVALID_METADATA', detail: `Platform "${key}" has no signature.` };
    }
    // Only https. A plaintext or file URL in signed metadata is not a
    // transport choice worth honouring.
    if (!/^https:\/\//i.test(entry.url)) {
      return { ok: false, code: 'INVALID_METADATA', detail: `Platform "${key}" artifact URL is not https.` };
    }
  }

  if (m.mandatory !== undefined && typeof m.mandatory !== 'boolean') {
    return { ok: false, code: 'INVALID_METADATA', detail: '`mandatory` must be a boolean when present.' };
  }

  return { ok: true, metadata: m as unknown as UpdateMetadata };
}

/* ── The gate ────────────────────────────────────────────────────── */

export type Applicability =
  | { applicable: true; candidate: UpdateCandidate }
  | { applicable: false; code: UpdateErrorCode; detail: string };

export interface ApplicabilityInput {
  currentVersion: string;
  target: UpdateTarget | null;
  metadata: unknown;
}

/**
 * The RUNTIME gate.
 *
 * By the time the native updater hands us a pending update it has already
 * chosen this machine's artifact out of the metadata's `platforms` map and
 * does not expose the map itself — so at runtime there is no platform
 * table left to inspect. Running the full metadata gate here would
 * therefore reject every real update for a missing artifact, which is why
 * the two gates are separate rather than one function pretending to serve
 * both.
 *
 * What remains AURA's to decide at runtime, and is decided here:
 *   • the running target must be one this product actually publishes;
 *   • the offered version must parse;
 *   • it must be strictly newer than what is installed.
 *
 * Platform ARTIFACT selection and signature verification stay with the
 * native updater. This gate narrows what it offers; it never widens it.
 */
export interface RuntimeCandidateInput {
  currentVersion: string;
  target: UpdateTarget | null;
  version: unknown;
  releaseDate?: unknown;
  notes?: unknown;
  mandatory?: unknown;
}

export function evaluateRuntimeCandidate(input: RuntimeCandidateInput): Applicability {
  const current = parseVersion(input.currentVersion);
  if (!current) {
    return { applicable: false, code: 'INVALID_METADATA', detail: `The installed version (${JSON.stringify(input.currentVersion)}) is not a usable version.` };
  }
  if (!input.target) {
    return { applicable: false, code: 'INCOMPATIBLE_PLATFORM', detail: 'This platform and architecture are not a target AURA Hub publishes.' };
  }
  if (!isSupportedTarget(input.target)) {
    return { applicable: false, code: 'UNSUPPORTED_ARCHITECTURE', detail: `"${input.target}" is not a supported target.` };
  }

  const next = parseVersion(input.version);
  if (!next) {
    return { applicable: false, code: 'INVALID_METADATA', detail: `The offered version (${JSON.stringify(input.version)}) is not a usable version.` };
  }

  const order = compareVersions(next, current);
  if (order === 0) {
    return { applicable: false, code: 'DOWNGRADE_REJECTED', detail: `Version ${next.major}.${next.minor}.${next.patch} is already installed.` };
  }
  if (order < 0) {
    return { applicable: false, code: 'DOWNGRADE_REJECTED', detail: `The offered version is older than the installed ${input.currentVersion}.` };
  }

  return {
    applicable: true,
    candidate: {
      version: String(input.version),
      currentVersion: input.currentVersion,
      releaseDate: typeof input.releaseDate === 'string' ? input.releaseDate : null,
      notes: typeof input.notes === 'string' ? input.notes : null,
      mandatory: input.mandatory === true,
    },
  };
}

/**
 * The FULL metadata gate: may this `latest.json` proceed at all?
 *
 * Used where the whole document is in hand — release-time validation of a
 * manifest before it is published, and the verification suite. The runtime
 * path uses `evaluateRuntimeCandidate` above, because the native updater
 * has already consumed and discarded the platforms map by then.
 *
 * Order matters. Metadata is validated before anything is read out of it,
 * the target is resolved before an artifact is looked up, and the version
 * comparison happens before any of it can influence the outcome — so a
 * server cannot use a higher version number to skip a platform check.
 */
export function evaluateCandidate({ currentVersion, target, metadata }: ApplicabilityInput): Applicability {
  const current = parseVersion(currentVersion);
  if (!current) {
    // If we cannot establish what is installed, we cannot establish that
    // anything is newer. Refuse rather than assume.
    return { applicable: false, code: 'INVALID_METADATA', detail: `The installed version (${JSON.stringify(currentVersion)}) is not a usable version.` };
  }

  const validated = validateMetadata(metadata);
  if (!validated.ok) return { applicable: false, code: validated.code, detail: validated.detail };
  const meta = validated.metadata;

  if (!target) {
    return { applicable: false, code: 'INCOMPATIBLE_PLATFORM', detail: 'This platform and architecture are not a target AURA Hub publishes.' };
  }
  if (!isSupportedTarget(target)) {
    return { applicable: false, code: 'UNSUPPORTED_ARCHITECTURE', detail: `"${target}" is not a supported target.` };
  }

  const entry = meta.platforms[target];
  if (!entry) {
    const offered = Object.keys(meta.platforms).sort().join(', ') || 'none';
    return {
      applicable: false,
      code: 'MISSING_ARTIFACT',
      // Named explicitly: "there is a release, but not for you" is a very
      // different situation from "there is no release".
      detail: `This release has no artifact for ${target}. It offers: ${offered}.`,
    };
  }

  const next = parseVersion(meta.version)!;
  const order = compareVersions(next, current);
  if (order === 0) {
    return { applicable: false, code: 'DOWNGRADE_REJECTED', detail: `Version ${meta.version} is already installed.` };
  }
  if (order < 0) {
    return { applicable: false, code: 'DOWNGRADE_REJECTED', detail: `Version ${meta.version} is older than the installed ${currentVersion}.` };
  }

  return {
    applicable: true,
    candidate: {
      version: meta.version,
      currentVersion,
      releaseDate: typeof meta.pub_date === 'string' ? meta.pub_date : null,
      notes: typeof meta.notes === 'string' ? meta.notes : null,
      mandatory: meta.mandatory === true,
    },
  };
}
