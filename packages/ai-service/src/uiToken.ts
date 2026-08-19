/**
 * uiToken — telling AURA's own window apart from anything else on the box.
 * ==================================================================
 * The service listens on loopback, and loopback has no notion of *who*
 * is calling. Every request arrived looking identical: the desktop
 * window, a terminal running `curl`, a script. That mattered the moment
 * a capability wanted to distinguish "the user clicked a button" from
 * "something asked on the user's behalf", because the first is consent
 * and the second is a request for it.
 *
 * So the service mints one random token per boot and writes it where
 * only the user can read it. A request carrying that token in
 * `x-aura-ui` came from a client that could read the user's own config
 * directory. Everything else is treated exactly as it was before.
 *
 * What this is NOT
 * ----------------
 * This is not a defence against a hostile process running AS the user.
 * Such a process can read the token file, just as it can read
 * `providers.json`, the user's SSH keys, or simply run `npm install -g`
 * without involving AURA at all. That threat needs OS-level sandboxing
 * and is out of reach from here.
 *
 * What it genuinely does is narrower and still worth having:
 *
 *   · it replaces `actorKind` defaulting to 'human' — a claim any caller
 *     could make for free — with something a caller must *possess*;
 *   · it keeps the privilege on the one channel that has a human at the
 *     other end, instead of granting it to the port;
 *   · it makes the distinction auditable: the decision rule recorded for
 *     a direct action differs from the one recorded for a request.
 *
 * Why a file and not the environment: on Linux `/proc/<pid>/environ` is
 * readable by the same user, so an inherited env var is no more private
 * than a 0600 file — and the file also survives the case where the shell
 * reuses a service it did not spawn (§ service.rs), where there is no
 * env to inherit.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { homePath } from './persist';

/** Where the token lives. Same directory as every other local secret. */
const TOKEN_FILE = () => homePath('ui-token');

/** The header a trusted client presents. */
export const UI_TOKEN_HEADER = 'x-aura-ui';

let token: string | null = null;

/**
 * Mint this boot's token and publish it for the desktop shell.
 *
 * Rewritten on every start on purpose: a token from a previous run must
 * not authorize anything against this one, and a stale file left behind
 * by a crash is worthless rather than dangerous.
 */
export function initUiToken(): string {
  token = crypto.randomBytes(32).toString('hex');
  const file = TOKEN_FILE();
  // 0600 at creation, not chmod-after-write — a world-readable window
  // between the two is exactly the kind of gap this file exists to close.
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  try {
    // Recreate the mode even if the file already existed, since `mode:`
    // above only applies when the file is created.
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows has no POSIX mode. The ACL inherited from the user's
       profile directory is the boundary there, and it is the same one
       protecting providers.json. */
  }
  return token;
}

/**
 * Did this request come from AURA's own window?
 *
 * Compared in constant time. The lengths are compared first because
 * `timingSafeEqual` throws on a mismatch, and a thrown exception is
 * itself a timing signal.
 */
export function isUserDirect(req: http.IncomingMessage): boolean {
  if (!token) return false;
  const raw = req.headers[UI_TOKEN_HEADER];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (typeof presented !== 'string' || presented.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

/** Test seam. Never called by the service itself. */
export function __setUiTokenForTest(value: string | null): void {
  token = value;
}
