/**
 * desktop/drivers — tiers 5 and 6, read-only.
 * ==================================================================
 * The bottom two rungs of the actuation ladder, and the honest framing
 * for both: this is the least durable code in the system. It breaks when
 * applications redesign, it is fragmented across three platforms that
 * share nothing, and on each of them it is gated by a permission the
 * operating system will not let AURA grant itself. None of that is
 * fixable by design. It is presented as best-effort and never as a
 * guarantee.
 *
 * What this file ships is **observation only**. Tier 5 reads an
 * accessibility tree; tier 6 enumerates windows. Nothing here presses a
 * key, moves a pointer, focuses a window or changes an application's
 * state. That boundary is deliberate and it is where this phase stops:
 * synthetic input is a larger commitment than an adapter format, and
 * shipping the reading half first is what makes the writing half
 * governable when somebody builds it.
 *
 * ── The registry interface ─────────────────────────────────────────
 *
 * Phase 4 owns the driver registry and tiers 1–4; this file owns tiers 5
 * and 6 and is written against the interface below. `TierDriver` is
 * deliberately minimal — an id, a tier, a per-platform declaration, a
 * probe and a read — so that adopting Phase 4's registry is a matter of
 * deleting `DesktopTierRegistry` here and registering the same two
 * drivers there. The exact assumption is recorded in HANDOFF.md. There
 * is one registry in this file and it does not reach past tier 5 and 6,
 * so it cannot become a competing home for tiers 1–4.
 */

import {
  TIER_NAME,
  type ActuationTier,
  type PlatformDeclaration,
  type TargetPlatform,
  type TierProbe,
} from '@aura/connected-environment';
import { detectDesktopSession, runDesktopCommand, type DesktopSession } from './session';
import { resolveExecutable } from '../exec/which';

/* ══════════════════════════════════════════════════════════════════
   1. The interface
   ══════════════════════════════════════════════════════════════════ */

/** One thing a driver observed. Deliberately flat and printable. */
export interface ObservedItem {
  /** Stable within one observation — a window id, a bus name, a handle. */
  ref: string;
  /** What the platform calls it. Never invented; absent if not published. */
  title: string | null;
  /** The owning application, where the platform reports one. */
  application: string | null;
  /** Owning process id, where the platform reports one. */
  pid: number | null;
  /** Screen rectangle, where the platform reports one. */
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface Observation {
  tier: ActuationTier;
  /** Which platform mechanism produced this, named so a user can check it. */
  via: string;
  items: ObservedItem[];
  detail: string;
}

export type ObservationResult =
  | { ok: true; observation: Observation }
  /**
   * The driver could not read. Carries the same information a `TierProbe`
   * does, because a caller that asked for a reading and got a refusal
   * needs to know what is missing, not merely that it failed.
   */
  | { ok: false; reason: string; missing: string[] };

/**
 * A driver for exactly one rung of the ladder.
 *
 * `platforms` is declared data, checked by `desktop-tier-verify` against
 * what this machine actually is. `probe` measures; `observe` reads. The
 * two are separate because policy needs the first before it will permit
 * the second, and a probe that read as a side effect of measuring would
 * make the availability question itself an observation of the user's
 * screen.
 */
export interface TierDriver {
  readonly id: string;
  readonly tier: ActuationTier;
  readonly platforms: PlatformDeclaration[];
  probe(refresh?: boolean): Promise<TierProbe>;
  observe(): Promise<ObservationResult>;
}

export interface TierDriverRegistry {
  register(driver: TierDriver): void;
  get(tier: ActuationTier): TierDriver | undefined;
  all(): TierDriver[];
  probeAll(refresh?: boolean): Promise<TierProbe[]>;
}

/* ══════════════════════════════════════════════════════════════════
   2. Helpers shared by both drivers
   ══════════════════════════════════════════════════════════════════ */

const platformOf = (session: DesktopSession) => session.platform;

/** The declaration this driver made about the platform it is running on. */
function declarationFor(
  driver: Pick<TierDriver, 'platforms'>,
  platform: TargetPlatform | null,
): PlatformDeclaration | null {
  if (!platform) return null;
  return driver.platforms.find((p) => p.platform === platform) ?? null;
}

/**
 * Turn a declaration plus a set of unmet requirements into a probe.
 *
 * Centralised so that every driver produces the same four answers with
 * the same meanings, and in particular so that "we did not check" can
 * never be spelled the same way as "we checked and it is fine".
 */
function probeFrom(
  tier: ActuationTier,
  platform: TargetPlatform | null,
  declaration: PlatformDeclaration | null,
  missing: string[],
  availableDetail: string,
): TierProbe {
  if (!platform) {
    return {
      tier,
      availability: 'unsupported',
      platform: null,
      detail: `This operating system (${process.platform}) is not one AURA ships desktop drivers for.`,
    };
  }
  if (!declaration || !declaration.supported) {
    return {
      tier,
      availability: 'unsupported',
      platform,
      detail: declaration?.note ?? `Tier ${tier} (${TIER_NAME[tier]}) is not claimed on ${platform}.`,
    };
  }
  if (missing.length) {
    return {
      tier,
      availability: 'unavailable',
      platform,
      missing,
      detail: `Tier ${tier} (${TIER_NAME[tier]}) needs ${missing.join(', ')} on ${platform}, which ${
        missing.length === 1 ? 'is' : 'are'
      } not available on this machine. ${declaration.note}`,
    };
  }
  return { tier, availability: 'available', platform, detail: availableDetail };
}

/* ══════════════════════════════════════════════════════════════════
   3. Tier 5 — accessibility
   ══════════════════════════════════════════════════════════════════ */

/**
 * The macOS reading. `System Events` is the scriptable front end to the
 * AX API, so this genuinely is the accessibility tier and not a
 * substitute for it. It returns nothing at all until the user grants
 * AURA Accessibility permission in System Settings — the OS does not
 * report an error for a missing grant, it reports an empty world, which
 * is why the driver treats an empty answer as unavailable rather than as
 * "no applications are running".
 */
const AX_SCRIPT =
  'tell application "System Events" to get the name of every application process whose background only is false';

/**
 * The Windows reading, through the in-box UIAutomationClient assembly.
 *
 * No third-party runtime and no download: `UIAutomationClient` and
 * `UIAutomationTypes` ship with the .NET Framework that is present on
 * every supported Windows. The root element's direct children are the
 * top-level windows, which is exactly the tier-5 view.
 *
 * `-NoProfile` matters. A user's PowerShell profile is arbitrary code,
 * and running it as a side effect of probing accessibility would make a
 * read-only observation execute whatever happens to be in it.
 */
const UIA_SCRIPT = [
  'Add-Type -AssemblyName UIAutomationClient;',
  'Add-Type -AssemblyName UIAutomationTypes;',
  '$root=[System.Windows.Automation.AutomationElement]::RootElement;',
  '$cond=New-Object System.Windows.Automation.PropertyCondition(',
  '[System.Windows.Automation.AutomationElement]::IsControlElementProperty,$true);',
  '$found=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond);',
  'foreach($e in $found){',
  '$c=$e.Current;',
  'Write-Output ("{0}`t{1}`t{2}" -f $c.NativeWindowHandle,$c.ProcessId,$c.Name)',
  '}',
].join(' ');

class AccessibilityDriver implements TierDriver {
  readonly id = 'accessibility';
  readonly tier: ActuationTier = 5;
  readonly platforms: PlatformDeclaration[] = [
    {
      platform: 'linux',
      supported: true,
      requires: ['gdbus', 'org.a11y.Bus', 'a published accessibility tree'],
      note: 'Reads the AT-SPI tree over the accessibility D-Bus. The bus running is not enough — an application has to have published a tree to it.',
    },
    {
      platform: 'darwin',
      supported: true,
      requires: ['osascript', 'Accessibility permission'],
      note: 'Reads the AX API through System Events. macOS returns an empty tree rather than an error until the user grants Accessibility permission, so an empty reading is reported as unavailable, not as an empty desktop.',
    },
    {
      platform: 'win32',
      supported: true,
      requires: ['powershell'],
      note: 'Reads the UIAutomation tree through the in-box UIAutomationClient assembly. No third-party runtime and no user permission grant is involved.',
    },
  ];

  async probe(refresh = false): Promise<TierProbe> {
    const session = await detectDesktopSession(refresh);
    const platform = platformOf(session);
    const declaration = declarationFor(this, platform);
    const missing: string[] = [];
    let detail = '';

    if (platform === 'linux') {
      if (!session.tools.gdbus) missing.push('gdbus');
      const a = session.atspi;
      if (!a?.busPresent) missing.push('an accessibility bus (org.a11y.Bus)');
      // A bus with no trees on it is a bus that answers every query with
      // nothing. Reporting that as available would produce a driver that
      // succeeds at reading emptiness, which is worse than one that says
      // it cannot read.
      else if (!a.applicationCount) missing.push('an application publishing an accessibility tree');
      detail = a?.detail ?? '';
    } else if (platform === 'darwin') {
      if (!session.tools.osascript) missing.push('osascript');
      detail = 'The AX API is reachable through System Events. Whether it returns anything depends on the Accessibility permission, which is checked when it is read.';
    } else if (platform === 'win32') {
      if (!session.tools.powershell) missing.push('powershell');
      detail = 'The UIAutomation tree is reachable through the in-box UIAutomationClient assembly.';
    }

    return probeFrom(this.tier, platform, declaration, missing, detail);
  }

  async observe(): Promise<ObservationResult> {
    const probe = await this.probe();
    if (probe.availability !== 'available') {
      return { ok: false, reason: probe.detail, missing: probe.missing ?? [] };
    }
    const session = await detectDesktopSession();
    switch (session.platform) {
      case 'linux':
        return this.observeAtspi(session);
      case 'darwin':
        return this.observeAx();
      case 'win32':
        return this.observeUia();
      default:
        return { ok: false, reason: 'No accessibility driver for this platform.', missing: [] };
    }
  }

  /**
   * Read the AT-SPI registry: every application publishing a tree, by
   * name.
   *
   * Two documented calls. `GetChildren` on the registry's root returns
   * `(bus-name, object-path)` pairs — one per application — and the
   * `Name` property on each is what that application calls itself. The
   * child is addressed on the *accessibility* bus by its own bus name,
   * which is why the address from `org.a11y.Bus` is threaded through
   * rather than the session bus being used.
   */
  private async observeAtspi(session: DesktopSession): Promise<ObservationResult> {
    const gdbus = resolveExecutable('gdbus');
    const address = session.atspi?.address;
    if (!gdbus || !address) {
      return { ok: false, reason: 'The accessibility bus address is not available.', missing: ['org.a11y.Bus'] };
    }

    const raw = await runDesktopCommand(gdbus, [
      'call', '--address', address,
      '--dest', 'org.a11y.atspi.Registry',
      '--object-path', '/org/a11y/atspi/accessible/root',
      '--method', 'org.a11y.atspi.Accessible.GetChildren',
    ]);
    if (!raw) {
      return { ok: false, reason: 'The accessibility registry did not answer.', missing: ['org.a11y.atspi.Registry'] };
    }

    // ([(':1.0', objectpath '/org/a11y/atspi/accessible/root'), (':1.2', '/…')],)
    const refs = [...raw.matchAll(/\('(:[0-9.]+)',\s*(?:objectpath\s*)?'([^']+)'\)/g)];
    const items: ObservedItem[] = [];
    for (const [, busName, objectPath] of refs) {
      const nameRaw = await runDesktopCommand(gdbus, [
        'call', '--address', address,
        '--dest', busName,
        '--object-path', objectPath,
        '--method', 'org.freedesktop.DBus.Properties.Get',
        'org.a11y.atspi.Accessible', 'Name',
      ]);
      items.push({
        ref: `${busName}${objectPath}`,
        // An application that publishes no name gets `null`, not a
        // guess derived from its bus name.
        title: nameRaw?.match(/<'([^']*)'>/)?.[1] ?? null,
        application: nameRaw?.match(/<'([^']*)'>/)?.[1] ?? null,
        pid: null,
        bounds: null,
      });
    }

    return {
      ok: true,
      observation: {
        tier: 5,
        via: 'AT-SPI (org.a11y.atspi.Registry over the accessibility D-Bus)',
        items,
        detail: `${items.length} application${items.length === 1 ? '' : 's'} publish an accessibility tree on this session.`,
      },
    };
  }

  private async observeAx(): Promise<ObservationResult> {
    const osascript = resolveExecutable('osascript');
    if (!osascript) return { ok: false, reason: 'osascript is not available.', missing: ['osascript'] };
    const raw = await runDesktopCommand(osascript, ['-e', AX_SCRIPT]);
    if (!raw) {
      // macOS answers a missing Accessibility grant with silence, not an
      // error, so this is where that grant is actually detected.
      return {
        ok: false,
        reason: 'System Events returned nothing. On macOS that is what a missing Accessibility permission looks like — grant AURA Accessibility in System Settings › Privacy & Security.',
        missing: ['Accessibility permission'],
      };
    }
    const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      ok: true,
      observation: {
        tier: 5,
        via: 'macOS AX API (System Events)',
        items: names.map((name) => ({ ref: name, title: name, application: name, pid: null, bounds: null })),
        detail: `${names.length} foreground application${names.length === 1 ? '' : 's'} are visible to the accessibility API.`,
      },
    };
  }

  private async observeUia(): Promise<ObservationResult> {
    const powershell = resolveExecutable('powershell');
    if (!powershell) return { ok: false, reason: 'powershell is not available.', missing: ['powershell'] };
    const raw = await runDesktopCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', UIA_SCRIPT]);
    if (!raw) return { ok: false, reason: 'The UIAutomation tree returned nothing.', missing: ['UIAutomationClient'] };
    const items: ObservedItem[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const [handle, pid, ...rest] = line.split('\t');
      if (!handle) continue;
      items.push({
        ref: handle.trim(),
        title: rest.join('\t').trim() || null,
        application: null,
        pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
        bounds: null,
      });
    }
    return {
      ok: true,
      observation: {
        tier: 5,
        via: 'Windows UIAutomation (UIAutomationClient)',
        items,
        detail: `${items.length} top-level element${items.length === 1 ? '' : 's'} are visible to UIAutomation.`,
      },
    };
  }
}

/* ══════════════════════════════════════════════════════════════════
   4. Tier 6 — GUI
   ══════════════════════════════════════════════════════════════════ */

/**
 * The Windows window enumeration.
 *
 * `EnumWindows` through P/Invoke, which is in-box: `Add-Type` compiles
 * the declaration against the .NET Framework already on the machine.
 * Only visible windows with a title are emitted, because the full
 * enumeration includes several hundred invisible message-only windows
 * that would drown the answer.
 */
const ENUM_WINDOWS_SCRIPT = [
  'Add-Type @"',
  'using System;using System.Text;using System.Runtime.InteropServices;',
  'public class AuraWin{',
  'public delegate bool Proc(IntPtr h,IntPtr l);',
  '[DllImport("user32.dll")]public static extern bool EnumWindows(Proc p,IntPtr l);',
  '[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);',
  '[DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);',
  '[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int c);',
  '[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out uint p);',
  '[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);',
  'public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}',
  '}',
  '"@;',
  '$cb=[AuraWin+Proc]{param($h,$l)',
  'if([AuraWin]::IsWindowVisible($h) -and [AuraWin]::GetWindowTextLength($h) -gt 0){',
  '$sb=New-Object System.Text.StringBuilder 512;',
  '[void][AuraWin]::GetWindowText($h,$sb,512);',
  '$p=0;[void][AuraWin]::GetWindowThreadProcessId($h,[ref]$p);',
  '$r=New-Object AuraWin+RECT;[void][AuraWin]::GetWindowRect($h,[ref]$r);',
  'Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f $h,$p,$r.Left,$r.Top,($r.Right-$r.Left),($r.Bottom-$r.Top),$sb.ToString())',
  '}',
  'return $true};',
  '[void][AuraWin]::EnumWindows($cb,[IntPtr]::Zero)',
].join(' ');

class GuiDriver implements TierDriver {
  readonly id = 'gui';
  readonly tier: ActuationTier = 6;
  readonly platforms: PlatformDeclaration[] = [
    {
      platform: 'linux',
      supported: true,
      requires: ['DISPLAY', 'wmctrl'],
      note: 'X11 only. Wayland is deliberately not claimed: it has no in-protocol way for one client to read or drive another\'s windows, and the out-of-protocol tools (ydotool, wtype) need a privileged uinput daemon that AURA will not ask a user to install so that an agent can type at their screen.',
    },
    {
      platform: 'win32',
      supported: true,
      requires: ['powershell'],
      note: 'Enumerates top-level windows through user32 EnumWindows. In-box; no permission grant and no third-party runtime.',
    },
    {
      /**
       * Refused, and this is the honest answer rather than a gap.
       *
       * The macOS window list lives behind `CGWindowListCopyWindowInfo`,
       * which needs the Screen Recording permission and a native binding
       * this project does not have — and the scriptable alternative
       * (System Events) IS the accessibility API, which is tier 5.
       * Claiming tier 6 here and quietly answering it with tier 5 would
       * be precisely the silent downward substitution the ladder exists
       * to prevent.
       */
      platform: 'darwin',
      supported: false,
      requires: [],
      note: 'macOS has no window enumeration available to AURA below the accessibility layer: CGWindowListCopyWindowInfo needs Screen Recording permission and a native binding, and the scriptable alternative is the AX API, which is tier 5. Answering a tier-6 request with tier 5 would be a silent substitution, so tier 6 is declared unsupported here instead.',
    },
  ];

  async probe(refresh = false): Promise<TierProbe> {
    const session = await detectDesktopSession(refresh);
    const platform = platformOf(session);
    const declaration = declarationFor(this, platform);
    const missing: string[] = [];
    let detail = '';

    if (platform === 'linux') {
      if (session.display === 'wayland') {
        return {
          tier: 6,
          availability: 'unavailable',
          platform,
          missing: ['an X11 session'],
          detail: 'This is a Wayland session. Wayland has no in-protocol way for one client to read or drive another\'s windows — that is its design, not a missing feature — so AURA reports tier 6 as unavailable rather than asking you to install a privileged input daemon.',
        };
      }
      if (session.display === 'headless') {
        return {
          tier: 6,
          availability: 'unavailable',
          platform,
          missing: ['a display (DISPLAY is unset)'],
          detail: 'There is no display attached to this session, so there are no windows to observe.',
        };
      }
      if (!session.tools.wmctrl) missing.push('wmctrl');
      detail = 'An X11 session is attached and its window list is readable.';
    } else if (platform === 'win32') {
      if (!session.tools.powershell) missing.push('powershell');
      detail = 'Top-level windows are enumerable through user32.';
    }

    return probeFrom(this.tier, platform, declaration, missing, detail);
  }

  async observe(): Promise<ObservationResult> {
    const probe = await this.probe();
    if (probe.availability !== 'available') {
      return { ok: false, reason: probe.detail, missing: probe.missing ?? [] };
    }
    const session = await detectDesktopSession();
    if (session.platform === 'linux') return this.observeX11();
    if (session.platform === 'win32') return this.observeWin32();
    return { ok: false, reason: 'No GUI driver for this platform.', missing: [] };
  }

  /**
   * `wmctrl -lpG`: window id, desktop, pid, x, y, width, height, host,
   * then the title — which may itself contain spaces, so the split is
   * bounded at eight fields and the remainder is the title verbatim.
   */
  private async observeX11(): Promise<ObservationResult> {
    const wmctrl = resolveExecutable('wmctrl');
    if (!wmctrl) return { ok: false, reason: 'wmctrl is not available.', missing: ['wmctrl'] };
    const raw = await runDesktopCommand(wmctrl, ['-lpG']);
    if (raw === null) {
      return { ok: false, reason: 'The window manager did not answer a window list.', missing: ['an EWMH-compliant window manager'] };
    }
    const items: ObservedItem[] = [];
    for (const line of raw.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8) continue;
      const [ref, , pid, x, y, w, h] = f;
      items.push({
        ref,
        title: f.slice(8).join(' ') || null,
        application: null,
        pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
        bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
      });
    }
    return {
      ok: true,
      observation: {
        tier: 6,
        via: 'X11 EWMH window list (wmctrl -lpG)',
        items,
        detail: `${items.length} window${items.length === 1 ? '' : 's'} are open on this X11 session.`,
      },
    };
  }

  private async observeWin32(): Promise<ObservationResult> {
    const powershell = resolveExecutable('powershell');
    if (!powershell) return { ok: false, reason: 'powershell is not available.', missing: ['powershell'] };
    const raw = await runDesktopCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', ENUM_WINDOWS_SCRIPT]);
    if (!raw) return { ok: false, reason: 'EnumWindows returned nothing.', missing: ['user32'] };
    const items: ObservedItem[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const f = line.split('\t');
      if (f.length < 7) continue;
      const [ref, pid, x, y, w, h, ...rest] = f;
      items.push({
        ref: ref.trim(),
        title: rest.join('\t').trim() || null,
        application: null,
        pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
        bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
      });
    }
    return {
      ok: true,
      observation: {
        tier: 6,
        via: 'Windows user32 EnumWindows',
        items,
        detail: `${items.length} visible top-level window${items.length === 1 ? '' : 's'}.`,
      },
    };
  }
}

/* ══════════════════════════════════════════════════════════════════
   5. The registry
   ══════════════════════════════════════════════════════════════════ */

class DesktopTierRegistry implements TierDriverRegistry {
  private drivers = new Map<ActuationTier, TierDriver>();

  register(driver: TierDriver): void {
    // Registering two drivers for one rung would make "which one ran"
    // unanswerable, which is the question the ladder exists to answer.
    if (this.drivers.has(driver.tier)) {
      throw new Error(
        `Tier ${driver.tier} already has a driver (${this.drivers.get(driver.tier)!.id}); a rung has exactly one.`,
      );
    }
    this.drivers.set(driver.tier, driver);
  }

  get(tier: ActuationTier): TierDriver | undefined {
    return this.drivers.get(tier);
  }

  all(): TierDriver[] {
    return [...this.drivers.values()].sort((a, b) => a.tier - b.tier);
  }

  async probeAll(refresh = false): Promise<TierProbe[]> {
    return Promise.all(this.all().map((d) => d.probe(refresh)));
  }
}

export const accessibilityDriver = new AccessibilityDriver();
export const guiDriver = new GuiDriver();

/**
 * The tiers this phase owns, and only those.
 *
 * Tiers 1–4 are Phase 4's, and this registry deliberately holds nothing
 * for them: an empty slot that another registry fills is a seam, while a
 * placeholder driver claiming tier 3 would be a competing authority.
 */
export const desktopTierRegistry: TierDriverRegistry = new DesktopTierRegistry();
desktopTierRegistry.register(accessibilityDriver);
desktopTierRegistry.register(guiDriver);
