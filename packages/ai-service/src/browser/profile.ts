/**
 * The browser profile AURA owns - and the grants that fill it.
 * ==================================================================
 * The five `browser.*` capabilities were prose-only extension points
 * with zero implementations. The first decision in implementing them is
 * not which protocol to use; it is WHOSE BROWSER.
 *
 * The tempting answer is the user's daily profile: it is already logged
 * in everywhere, so everything just works. That is precisely why it is
 * the wrong answer. Every live session in that profile - the bank, the
 * work email, the cloud console - becomes ambient authority for an agent
 * that can be talked into things by a web page. The user never granted
 * that; they granted "you may use a browser".
 *
 * So AURA drives a profile it owns, at `~/.aura/browser/profile`, which
 * starts empty and stays empty until the user puts something in it.
 *
 * -- Auth is explicit, per site, per duration, revocable ---------------
 * A grant says: "AURA may act as me on this origin, until this time."
 * It is created by a deliberate act (the user signs in, in AURA's
 * browser window, for that site), it names one origin, it expires on its
 * own, and `revoke()` ends it early. There is no "log in once, agent
 * forever".
 *
 * A grant is NOT a policy decision. The Fabric's policy engine still
 * decides whether a `browser.*` invocation runs at all; a grant only
 * says which origins the profile is allowed to carry a session for.
 * Two questions, two answers, one engine each.
 */

import fs from 'node:fs';
import { homePath, readJsonFile, writeJsonFile } from '../persist';

/** The profile directory AURA owns. Never the user's daily profile. */
export const auraProfileDir = (): string => homePath('browser', 'profile');

const GRANTS_FILE = () => homePath('browser', 'grants.json');

export interface SiteGrant {
  /** Origin exactly: scheme + host + port. Not a domain suffix. */
  origin: string;
  /** ISO time this grant was created. */
  grantedAt: string;
  /** ISO time it stops being valid. Never absent - there is no forever. */
  expiresAt: string;
  /** What the user said this was for. Surfaced when the grant is used. */
  purpose: string;
  /** Set when revoked early. A revoked grant is kept, not deleted. */
  revokedAt?: string;
}

interface GrantsFile {
  grants: SiteGrant[];
}

/** The longest a grant may last. A day is a session, not a standing key. */
export const MAX_GRANT_MS = 24 * 60 * 60 * 1000;

export function normalizeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export class BrowserGrants {
  private file: GrantsFile;

  constructor() {
    this.file = readJsonFile<GrantsFile>(GRANTS_FILE(), { grants: [] });
    if (!Array.isArray(this.file.grants)) this.file = { grants: [] };
  }

  private save(): void {
    writeJsonFile(GRANTS_FILE(), this.file);
  }

  /**
   * Grant AURA a session on one origin, for a bounded time.
   *
   * `durationMs` is clamped rather than rejected: a user asking for a
   * week gets a day and is told, which is better than a failed call that
   * leaves them with nothing and no session at all.
   */
  grant(url: string, purpose: string, durationMs: number): SiteGrant | { error: string } {
    const origin = normalizeOrigin(url);
    if (!origin) return { error: `"${url}" is not an http(s) URL, so no origin could be granted.` };
    const ms = Math.max(60_000, Math.min(MAX_GRANT_MS, durationMs));
    const now = Date.now();
    const grant: SiteGrant = {
      origin,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ms).toISOString(),
      purpose: purpose.slice(0, 400),
    };
    /* One live grant per origin. Re-granting replaces rather than stacks,
       so "how long may AURA act on this site" always has one answer. */
    this.file.grants = this.file.grants.filter((g) => g.origin !== origin || this.isExpired(g));
    this.file.grants.push(grant);
    this.save();
    return grant;
  }

  revoke(url: string): boolean {
    const origin = normalizeOrigin(url);
    if (!origin) return false;
    let changed = false;
    for (const g of this.file.grants) {
      if (g.origin === origin && !g.revokedAt) {
        g.revokedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  private isExpired(g: SiteGrant): boolean {
    return !!g.revokedAt || Date.parse(g.expiresAt) <= Date.now();
  }

  /** The live grant for this URL's origin, or null. */
  find(url: string): SiteGrant | null {
    const origin = normalizeOrigin(url);
    if (!origin) return null;
    return this.file.grants.find((g) => g.origin === origin && !this.isExpired(g)) ?? null;
  }

  /** Every grant, live and dead. History is part of the record. */
  list(): SiteGrant[] {
    return [...this.file.grants];
  }

  live(): SiteGrant[] {
    return this.file.grants.filter((g) => !this.isExpired(g));
  }
}

/**
 * Whether AURA has ever been given a session in its own profile.
 *
 * Used to explain an empty result honestly: "you are not signed in to
 * that site IN AURA'S BROWSER" is a different and far more useful
 * message than "the page had no content".
 */
export function profileExists(): boolean {
  try {
    return fs.statSync(auraProfileDir()).isDirectory();
  } catch {
    return false;
  }
}
