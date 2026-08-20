/**
 * desktop/session — what kind of desktop is this, actually?
 * ==================================================================
 * Every claim a tier-5 or tier-6 driver makes rests on facts about the
 * session that are not knowable from `process.platform` alone. The two
 * that matter most on Linux are invisible to it entirely:
 *
 *   • X11 or Wayland. Synthetic input works on one and is deliberately
 *     impossible on the other. This is not a gap in Wayland; it is the
 *     security property Wayland was designed around, and no amount of
 *     effort here changes it.
 *
 *   • Whether the accessibility bus has trees on it. `org.a11y.Bus` is
 *     started on almost every desktop session, so its presence proves
 *     almost nothing. What matters is whether any application has
 *     actually published a tree to it — which is measured, below, by
 *     asking the registry how many children it has.
 *
 * Everything here is READ-ONLY. Nothing in this file moves a pointer,
 * presses a key, focuses a window or changes any application's state. It
 * runs fixed commands with fixed arguments — no value from any request
 * body reaches a command line — so the same "there is no path from an
 * HTTP request to arbitrary execution" argument that governs
 * `environment.ts` governs this too.
 *
 * Results are cached briefly, for the same reason probes are: a session
 * does not change between two questions asked a second apart, and
 * spawning `gdbus` per capability call would make the ladder expensive
 * exactly where it is meant to be cheap.
 */

import { execFile } from 'node:child_process';
import { resolveExecutable } from '../exec/which';
import { targetPlatformOf, type TargetPlatform } from '@aura/connected-environment';

/** Long enough that a burst of tier probes costs one measurement. */
const SESSION_TTL_MS = 15_000;
const CMD_TIMEOUT_MS = 3000;

/**
 * Run a fixed command and return its output, or null.
 *
 * Never throws, and never distinguishes "failed" from "absent" to the
 * caller: for a probe both mean the same thing, which is that this
 * capability is not available here, and a driver that treated a spawn
 * error as a different kind of unavailable would report two ways of
 * saying "no" as though one of them were a "maybe".
 */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: CMD_TIMEOUT_MS, maxBuffer: 512 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ''}`.trim();
        if (out) return resolve(out);
        if (error) return resolve(null);
        const err = `${stderr ?? ''}`.trim();
        resolve(err || null);
      },
    );
  });
}

/* ══════════════════════════════════════════════════════════════════
   The session facts
   ══════════════════════════════════════════════════════════════════ */

/**
 * The display server, on Linux.
 *
 *   x11      — synthetic input is possible, and window enumeration is a
 *              documented X property (`_NET_CLIENT_LIST`).
 *   wayland  — neither is possible from an ordinary client. Declared and
 *              refused rather than worked around.
 *   headless — no display at all. A CI runner, an SSH session, a
 *              container. Very common and not an error.
 */
export type LinuxDisplayServer = 'x11' | 'wayland' | 'headless';

export interface AtspiStatus {
  /** `org.a11y.Bus` answered and named a bus address. */
  busPresent: boolean;
  /** The address it named, used verbatim by the tier-5 driver. */
  address: string | null;
  /**
   * How many applications have actually published a tree.
   *
   * The number that matters, and the one a boolean would hide: a bus with
   * zero children is a bus that will answer every query with nothing, and
   * reporting it as "accessibility available" would produce a tier-5
   * driver that succeeds at reading emptiness.
   */
  applicationCount: number | null;
  detail: string;
}

export interface DesktopSession {
  platform: TargetPlatform | null;
  /** Linux only; `null` elsewhere. */
  display: LinuxDisplayServer | null;
  /** Linux only; `null` elsewhere. */
  atspi: AtspiStatus | null;
  /**
   * Which of the tools each driver needs actually resolved on PATH.
   * Recorded by name so an unavailable tier can say *what* is missing.
   */
  tools: Record<string, boolean>;
  measuredAt: string;
}

let cached: { at: number; session: DesktopSession } | null = null;

/**
 * Which display server this Linux session is running.
 *
 * `XDG_SESSION_TYPE` is the primary answer because it is what the session
 * manager itself set. `WAYLAND_DISPLAY` is checked before `DISPLAY`
 * because Xwayland sets `DISPLAY` too — a Wayland session that only
 * looked at `DISPLAY` would conclude it was X11 and then declare
 * synthetic input available on a session where it cannot work.
 */
function linuxDisplay(env: NodeJS.ProcessEnv): LinuxDisplayServer {
  const declared = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (declared === 'wayland') return 'wayland';
  if (declared === 'x11') return 'x11';
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'headless';
}

/**
 * Ask the accessibility bus what is on it.
 *
 * Two calls, both documented AT-SPI, and the second is the load-bearing
 * one. `org.a11y.Bus.GetAddress` is answered by the bus launcher on
 * essentially every desktop session, so it proves only that a11y is
 * *installed*. `ChildCount` on the registry's root accessible is how
 * many applications are actually exporting a tree, and that is what a
 * tier-5 driver can read.
 *
 * Note what is NOT used as the test: `org.a11y.Status.IsEnabled`. On this
 * project's development machine that property reads `false` while four
 * applications are publishing trees the registry will happily hand over
 * — it reflects a GTK toolkit setting, not the state of the bus. Trusting
 * it would have AURA report accessibility unavailable on a machine where
 * it demonstrably works.
 */
async function probeAtspi(gdbus: string | null): Promise<AtspiStatus> {
  if (!gdbus) {
    return {
      busPresent: false,
      address: null,
      applicationCount: null,
      detail: 'gdbus is not installed, so the accessibility bus cannot be queried.',
    };
  }

  const raw = await run(gdbus, [
    'call', '--session',
    '--dest', 'org.a11y.Bus',
    '--object-path', '/org/a11y/bus',
    '--method', 'org.a11y.Bus.GetAddress',
  ]);
  // gdbus prints a GVariant tuple: ('unix:path=/run/user/1000/at-spi/bus_0',)
  const address = raw?.match(/\('([^']+)'\s*,?\)/)?.[1] ?? null;
  if (!address) {
    return {
      busPresent: false,
      address: null,
      applicationCount: null,
      detail: 'No accessibility bus is running on this session (org.a11y.Bus did not answer).',
    };
  }

  const children = await run(gdbus, [
    'call', '--address', address,
    '--dest', 'org.a11y.atspi.Registry',
    '--object-path', '/org/a11y/atspi/accessible/root',
    '--method', 'org.freedesktop.DBus.Properties.Get',
    'org.a11y.atspi.Accessible', 'ChildCount',
  ]);
  const count = children?.match(/<(\d+)>/)?.[1];
  const applicationCount = count === undefined ? null : Number(count);

  return {
    busPresent: true,
    address,
    applicationCount,
    detail:
      applicationCount === null
        ? 'The accessibility bus is running, but its registry did not answer a child count.'
        : applicationCount === 0
          ? 'The accessibility bus is running but no application has published a tree to it, so there is nothing to read.'
          : `${applicationCount} application${applicationCount === 1 ? '' : 's'} publish an accessibility tree on this session.`,
  };
}

/** Tools any tier-5 or tier-6 driver may need, by platform. */
const TOOLS: Record<TargetPlatform, string[]> = {
  linux: ['gdbus', 'wmctrl', 'xprop', 'xdotool'],
  darwin: ['osascript'],
  win32: ['powershell'],
};

/**
 * Measure this desktop session.
 *
 * `refresh` forces a re-measurement, for the case a user has just started
 * an application or logged into a different session — the same escape
 * hatch `probeNode` gives for a tool the user just installed.
 */
export async function detectDesktopSession(refresh = false): Promise<DesktopSession> {
  const now = Date.now();
  if (!refresh && cached && now - cached.at < SESSION_TTL_MS) return cached.session;

  const platform = targetPlatformOf(process.platform);
  const tools: Record<string, boolean> = {};
  for (const name of platform ? TOOLS[platform] : []) {
    tools[name] = resolveExecutable(name) !== null;
  }

  const session: DesktopSession = {
    platform,
    display: platform === 'linux' ? linuxDisplay(process.env) : null,
    atspi: platform === 'linux' ? await probeAtspi(resolveExecutable('gdbus')) : null,
    tools,
    measuredAt: new Date().toISOString(),
  };

  cached = { at: now, session };
  return session;
}

/** Drop the cache. Used by verification, which needs to measure twice. */
export function resetDesktopSessionCache(): void {
  cached = null;
}

export { run as runDesktopCommand };
