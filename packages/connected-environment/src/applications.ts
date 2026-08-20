/**
 * applications — an adapter FORMAT, not an adapter per application.
 * ==================================================================
 * The temptation with desktop integration is to write one hand-rolled
 * module per application: a VS Code adapter, a Photoshop adapter, a
 * Xcode adapter. That approach fails in a specific and predictable way —
 * it is the least durable code anyone writes, because it breaks whenever
 * an application redesigns, and there is no upper bound on how many
 * applications exist.
 *
 * So an application here is *data*: how to detect it on each platform,
 * how to reach it at each rung of the ladder, and what observing it
 * costs. Adding an application is an entry in `APPLICATION_ADAPTERS`.
 * No scanner, no policy, no driver and no UI is touched.
 *
 * Three commitments this file inherits from `catalog.ts`, and keeps:
 *
 *   • **It never asserts presence.** This is knowledge about what exists
 *     in the world. Presence is measured at runtime by a scanner, and a
 *     detection source that does not answer means absent, never assumed.
 *
 *   • **It refuses to guess.** `catalog.ts` deliberately gives desktop
 *     applications no probe, because "run `photoshop --version`" is not
 *     a dependable test on any platform. The same instinct governs here:
 *     an adapter declares detection only where a real, checkable source
 *     exists (a `.desktop` file, a bundle identifier, a registry
 *     uninstall key), and a platform with no such source is declared
 *     *undetectable* rather than given a hopeful binary name.
 *
 *   • **It declares, it does not assume.** Every rung an adapter claims
 *     carries a per-platform declaration. A tier absent from the list is
 *     a tier this application does not offer — not one to try anyway.
 *
 * ── Why discovery is itself a governed, sensitive act ──────────────
 *
 * Enumerating the applications on somebody's machine is not a neutral
 * read. The list is a portrait: `org.torproject.torbrowser-launcher`
 * says something about a person that `gcc` does not, and a support
 * transcript or a model context window containing either is a different
 * document for having contained the first.
 *
 * So every adapter carries an `observationSensitivity`, the scanner
 * stamps it onto each discovered record, and the discovery capability
 * passes the same policy engine as any other capability. Read-only is
 * not the same as harmless, and this file does not pretend otherwise.
 */

import type { ActuationTier, PlatformDeclaration, TargetPlatform } from './tiers';

/* ══════════════════════════════════════════════════════════════════
   1. What observing an application costs
   ══════════════════════════════════════════════════════════════════ */

/**
 * How sensitive it is to have *observed* that this application exists.
 *
 * About the observation, not the application. Nothing here is a judgement
 * of the software; it is a statement about what learning of its presence
 * discloses about the person using the machine.
 *
 *   inventory     — developer tooling. Says what the machine is for.
 *                   `git`, `docker`, an IDE, a terminal emulator.
 *   personal      — says something about the person rather than the
 *                   machine: what they read, watch, play, or use to talk
 *                   to people. A messaging client belongs here.
 *   confidential  — presence alone can imply something a person may have
 *                   strong reasons to keep private: anonymity tooling,
 *                   health software, tools tied to a protected
 *                   characteristic or to circumventing surveillance.
 *
 * The ladder matters because the scanner reports the HIGHEST sensitivity
 * it touched, and a caller that asked for an inventory scan and got a
 * confidential answer must be told so.
 */
export type ObservationSensitivity = 'inventory' | 'personal' | 'confidential';

const SENSITIVITY_RANK: Record<ObservationSensitivity, number> = {
  inventory: 0,
  personal: 1,
  confidential: 2,
};

/** The higher of two sensitivities. Like `stricter()`, this only escalates. */
export function higherSensitivity(
  a: ObservationSensitivity,
  b: ObservationSensitivity,
): ObservationSensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/* ══════════════════════════════════════════════════════════════════
   2. How to detect an application — per platform, per source
   ══════════════════════════════════════════════════════════════════ */

/**
 * Where a detection answer came from. Recorded on every discovered
 * record, because "we found Chromium" and "we found a `.desktop` file
 * claiming Chromium" are different confidences and the caller is
 * entitled to know which one it got.
 */
export type DetectionSource =
  /** A freedesktop `.desktop` entry in an XDG application directory. */
  | 'desktop-entry'
  /** An executable resolved on PATH. */
  | 'path-binary'
  /** A `.app` bundle under an Applications directory (macOS). */
  | 'app-bundle'
  /** A `DisplayName` under a registry uninstall key (Windows). */
  | 'registry-uninstall'
  /** A shortcut in a Start Menu programs directory (Windows). */
  | 'start-menu';

export interface LinuxDetection {
  /**
   * `.desktop` basenames, WITHOUT the extension, searched across
   * `$XDG_DATA_HOME` and `$XDG_DATA_DIRS` in specification order.
   *
   * The primary Linux source, and the good one: the entry is installed
   * by the package manager, carries the application's own declared name
   * and Exec line, and exists for GUI applications that have no
   * command-line presence at all.
   */
  desktopEntries?: string[];
  /**
   * Bare executable names to look for on PATH.
   *
   * A weaker source than a desktop entry and used as corroboration or as
   * the only source for applications that genuinely ship no entry.
   */
  binaries?: string[];
}

export interface DarwinDetection {
  /**
   * Bundle identifiers, e.g. `com.microsoft.VSCode`.
   *
   * The authoritative macOS source. `LSCopyApplicationURLsForBundleIdentifier`
   * resolves one to every install on the machine regardless of where the
   * user actually put the bundle, which is the thing a directory listing
   * of `/Applications` cannot do.
   */
  bundleIds?: string[];
  /**
   * `.app` bundle names to look for under the Applications directories,
   * WITHOUT the `.app` suffix. The fallback for when Launch Services
   * cannot be queried.
   */
  appNames?: string[];
  binaries?: string[];
}

export interface WindowsDetection {
  /**
   * `DisplayName` values under the uninstall keys, matched as a prefix
   * so that `Google Chrome` finds `Google Chrome` at any version.
   *
   * Read from all three of `HKLM\\...\\Uninstall`, its `WOW6432Node`
   * sibling and `HKCU\\...\\Uninstall`, because a per-user install
   * appears in none of the machine-wide ones and missing it is how a
   * scanner tells a user their editor is not installed.
   */
  uninstallNames?: string[];
  /** Start Menu `.lnk` basenames, without the extension. */
  startMenuNames?: string[];
  binaries?: string[];
}

/**
 * Per-platform detection. A platform key that is ABSENT means this
 * adapter cannot detect the application there and says so — which is a
 * real answer and the honest one. It is never taken to mean "try the
 * binaries from another platform".
 */
export interface ApplicationDetection {
  linux?: LinuxDetection;
  darwin?: DarwinDetection;
  win32?: WindowsDetection;
}

/* ══════════════════════════════════════════════════════════════════
   3. How to reach an application — the declared ladder
   ══════════════════════════════════════════════════════════════════ */

/**
 * One rung this application offers, and what it is on each platform.
 *
 * `effect` is the read/write boundary and it is load-bearing: everything
 * this phase ships is `observe`, and an `actuate` rung is a capability
 * that changes somebody's document. They are not governed identically
 * and must not be declared identically.
 */
export interface ApplicationTierDeclaration {
  tier: ActuationTier;
  /** What this rung concretely IS for this application, in one line. */
  summary: string;
  /** Read-only observation, or a change to the application's state. */
  effect: 'observe' | 'actuate';
  /**
   * Per-platform support. Required, and required to name every platform
   * the adapter claims to detect on — a rung that is silent about a
   * platform is a rung that will be tried there and guess.
   */
  platforms: PlatformDeclaration[];
}

export interface ApplicationAdapter {
  /** Stable, lowercase, hyphenated. Matches the node catalogue id where one exists. */
  id: string;
  name: string;
  category:
    | 'editor'
    | 'browser'
    | 'terminal'
    | 'design'
    | 'file-manager'
    | 'communication'
    | 'media'
    | 'office'
    | 'devtool';
  /** One line the UI can show. */
  summary: string;
  /** What learning of this application's presence discloses. §1 above. */
  observationSensitivity: ObservationSensitivity;
  detect: ApplicationDetection;
  /** Every rung this application offers. May be empty — see below. */
  tiers: ApplicationTierDeclaration[];
  /**
   * The `catalog.ts` node this application corresponds to, when it is
   * also a node. Present so the two are correlated by id rather than by
   * a second copy of the node's data living here.
   */
  nodeId?: string;
}

/** Platforms this adapter claims it can detect on at all. */
export function detectablePlatforms(adapter: ApplicationAdapter): TargetPlatform[] {
  const out: TargetPlatform[] = [];
  if (adapter.detect.linux) out.push('linux');
  if (adapter.detect.darwin) out.push('darwin');
  if (adapter.detect.win32) out.push('win32');
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   4. Reusable platform declarations
   ══════════════════════════════════════════════════════════════════ */

const NO_TIER = (platform: TargetPlatform, note: string): PlatformDeclaration => ({
  platform,
  supported: false,
  requires: [],
  note,
});

const YES_TIER = (
  platform: TargetPlatform,
  requires: string[],
  note: string,
): PlatformDeclaration => ({ platform, supported: true, requires, note });

/**
 * Tier 5 on Linux is AT-SPI, and AT-SPI has a requirement that is easy
 * to miss: the *bus* existing is not the same as applications *publishing*
 * to it. `org.a11y.Bus` is launched on nearly every desktop session; the
 * trees on it are only there for toolkits that enabled accessibility.
 * Both are named so a probe can report which one is missing.
 */
const ATSPI_LINUX = YES_TIER(
  'linux',
  ['org.a11y.Bus', 'gdbus'],
  'Reads the AT-SPI accessibility tree over the a11y D-Bus. Applications publish a tree only when their toolkit has accessibility enabled, so the bus answering is necessary but not sufficient.',
);

/**
 * Tier 6 on Linux is X11-only here, and that is a hard boundary rather
 * than a gap to fill in later. Wayland has no protocol by which one
 * client synthesises input into another — that is the point of Wayland's
 * design, not an oversight — so the tools exist (`ydotool`, `wtype`) only
 * as privileged shims outside the display protocol. AURA declares X11 and
 * reports `not-executed` under Wayland rather than asking a user to
 * install a uinput daemon so an agent can type at their screen.
 */
const X11_GUI = YES_TIER(
  'linux',
  ['DISPLAY', 'xdotool'],
  'Drives the X11 session with xdotool. Wayland is deliberately NOT claimed: it has no in-protocol path for one client to synthesise input into another, and the out-of-protocol ones need privileges AURA will not ask for.',
);

const WIN32_GUI = YES_TIER(
  'win32',
  ['powershell'],
  'Enumerates top-level windows through user32 EnumWindows. In-box, and no permission grant is involved.',
);

/**
 * Tier 6 is refused on macOS. `CGWindowListCopyWindowInfo` needs the
 * Screen Recording permission and a native binding this project does not
 * have, and the scriptable alternative — System Events — IS the
 * accessibility API, which is tier 5. Answering a tier-6 request with
 * tier 5 would be the silent downward substitution the ladder exists to
 * prevent, so the rung is declared unsupported instead.
 */
const NO_GUI_DARWIN = NO_TIER(
  'darwin',
  'macOS exposes no window list below the accessibility layer without Screen Recording permission and a native binding, and answering tier 6 with the AX API would be a silent substitution.',
);

const AX_DARWIN = YES_TIER(
  'darwin',
  ['osascript', 'accessibility-permission'],
  'Reads the macOS Accessibility (AX) API. Requires the user to grant AURA Accessibility permission in System Settings; until they do, the API returns empty trees rather than an error.',
);

const UIA_WIN32 = YES_TIER(
  'win32',
  ['powershell', 'UIAutomationClient'],
  'Reads the UIAutomation tree through the in-box UIAutomationClient assembly. No third-party runtime is required.',
);

/* ══════════════════════════════════════════════════════════════════
   5. The adapters
   ══════════════════════════════════════════════════════════════════ */

/**
 * Deliberately a short list of applications whose detection sources and
 * command-line surfaces were each checked, rather than a long list of
 * plausible ones. `catalog.ts` earns its trust by refusing to guess; a
 * hundred half-checked adapters here would spend that trust immediately.
 */
export const APPLICATION_ADAPTERS: ApplicationAdapter[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'editor',
    summary: 'Microsoft\'s editor. Reachable through a documented CLI on every platform.',
    observationSensitivity: 'inventory',
    nodeId: 'vscode',
    detect: {
      linux: { desktopEntries: ['code', 'com.visualstudio.code'], binaries: ['code'] },
      darwin: { bundleIds: ['com.microsoft.VSCode'], appNames: ['Visual Studio Code'], binaries: ['code'] },
      win32: { uninstallNames: ['Microsoft Visual Studio Code'], startMenuNames: ['Visual Studio Code'], binaries: ['code'] },
    },
    tiers: [
      {
        tier: 5,
        summary: 'The Electron accessibility tree — the editor\'s own tree, not the window manager\'s.',
        effect: 'observe',
        platforms: [
          {
            platform: 'linux',
            supported: true,
            requires: ['org.a11y.Bus', 'gdbus', '--force-renderer-accessibility'],
            note: 'Electron publishes an AT-SPI tree on Linux only when renderer accessibility is on, which it is not by default. Declared, and reported unavailable when the tree is absent rather than assumed present because the bus is.',
          },
          AX_DARWIN,
          UIA_WIN32,
        ],
      },
      {
        tier: 3,
        summary: '`code --status` reports the running instance, its window list and its open folders, without opening anything.',
        effect: 'observe',
        platforms: [
          YES_TIER('linux', ['code'], 'The `code` CLI ships with the editor and is on PATH once the user has run "Install code command in PATH".'),
          YES_TIER('darwin', ['code'], 'Same CLI. Not on PATH by default on macOS — the user installs the shell command explicitly.'),
          YES_TIER('win32', ['code'], 'Installed on PATH by the system installer; a `.cmd` shim, so it is launched through the resolver in exec/which.'),
        ],
      },
    ],
  },

  {
    id: 'cursor',
    name: 'Cursor',
    category: 'editor',
    summary: 'An AI-native editor forked from VS Code, and so carrying the same CLI surface.',
    observationSensitivity: 'inventory',
    nodeId: 'cursor',
    detect: {
      linux: { desktopEntries: ['cursor'], binaries: ['cursor'] },
      darwin: { bundleIds: ['com.todesktop.230313mzl4w4u92'], appNames: ['Cursor'], binaries: ['cursor'] },
      win32: { uninstallNames: ['Cursor'], startMenuNames: ['Cursor'], binaries: ['cursor'] },
    },
    tiers: [
      {
        tier: 5,
        summary: 'The Electron accessibility tree — the editor\'s own tree, not the window manager\'s.',
        effect: 'observe',
        platforms: [
          {
            platform: 'linux',
            supported: true,
            requires: ['org.a11y.Bus', 'gdbus', '--force-renderer-accessibility'],
            note: 'Electron publishes an AT-SPI tree on Linux only when renderer accessibility is on, which it is not by default. Declared, and reported unavailable when the tree is absent rather than assumed present because the bus is.',
          },
          AX_DARWIN,
          UIA_WIN32,
        ],
      },
      {
        tier: 3,
        summary: '`cursor --status`, inherited from the VS Code CLI it was forked from.',
        effect: 'observe',
        platforms: [
          YES_TIER('linux', ['cursor'], 'The AppImage installs a `cursor` launcher; on this machine it lives in ~/.local/bin.'),
          YES_TIER('darwin', ['cursor'], 'Shell command installed from the editor, as with VS Code.'),
          YES_TIER('win32', ['cursor'], 'Installed by the Windows installer.'),
        ],
      },
    ],
  },

  {
    id: 'chromium',
    name: 'Chromium',
    category: 'browser',
    summary: 'The open-source browser. A tier-4 automation surface exists but is owned by the browser driver, not by this adapter.',
    observationSensitivity: 'inventory',
    detect: {
      linux: { desktopEntries: ['chromium'], binaries: ['chromium', 'chromium-browser'] },
      darwin: { bundleIds: ['org.chromium.Chromium'], appNames: ['Chromium'] },
      win32: { uninstallNames: ['Chromium'], startMenuNames: ['Chromium'] },
    },
    tiers: [
      {
        tier: 3,
        summary: '`chromium --version`. Enough to observe presence and version; nothing is opened.',
        effect: 'observe',
        platforms: [
          YES_TIER('linux', ['chromium'], 'Packaged as `chromium` on Arch and Fedora, `chromium-browser` on Debian and Ubuntu — both names are tried.'),
          NO_TIER('darwin', 'The bundle ships no PATH executable; detection is by bundle id and actuation belongs to the browser driver.'),
          NO_TIER('win32', 'No PATH executable is installed. Detection is by registry, and actuation belongs to the browser driver.'),
        ],
      },
      {
        tier: 6,
        summary: 'Its windows, as the window manager sees them — titles and geometry only, nothing read from inside the page.',
        effect: 'observe',
        platforms: [X11_GUI, WIN32_GUI, NO_GUI_DARWIN],
      },
    ],
  },

  {
    id: 'gimp',
    name: 'GIMP',
    category: 'design',
    summary: 'Raster image editor with a real, documented scripting console.',
    observationSensitivity: 'inventory',
    detect: {
      linux: { desktopEntries: ['gimp', 'org.gimp.GIMP'], binaries: ['gimp'] },
      darwin: { bundleIds: ['org.gimp.gimp'], appNames: ['GIMP'] },
      win32: { uninstallNames: ['GIMP'], startMenuNames: ['GIMP'] },
    },
    tiers: [
      {
        tier: 3,
        summary: '`gimp --version`, and `gimp -i -b` for a batch Script-Fu console — a genuine non-GUI surface.',
        effect: 'observe',
        platforms: [
          YES_TIER('linux', ['gimp'], 'On PATH from the distribution package.'),
          NO_TIER('darwin', 'The bundle installs no PATH executable by default.'),
          NO_TIER('win32', 'The installer does not add GIMP to PATH.'),
        ],
      },
    ],
  },

  {
    id: 'dolphin',
    name: 'Dolphin',
    category: 'file-manager',
    summary: 'The KDE file manager. Publishes both a D-Bus interface and an accessibility tree.',
    observationSensitivity: 'inventory',
    detect: {
      linux: { desktopEntries: ['org.kde.dolphin'], binaries: ['dolphin'] },
    },
    tiers: [
      {
        tier: 2,
        summary: 'A per-instance D-Bus service on the session bus, listing the open windows.',
        effect: 'observe',
        platforms: [
          YES_TIER('linux', ['DBUS_SESSION_BUS_ADDRESS', 'gdbus'], 'Registers `org.kde.dolphin-<pid>` on the session bus while running.'),
        ],
      },
      {
        tier: 5,
        summary: 'The Qt accessibility tree, published on the AT-SPI bus while the application is running.',
        effect: 'observe',
        platforms: [ATSPI_LINUX],
      },
    ],
  },

  {
    id: 'thunar',
    name: 'Thunar',
    category: 'file-manager',
    summary: 'The Xfce file manager. Publishes an accessibility tree; no stable CLI query surface.',
    observationSensitivity: 'inventory',
    detect: {
      linux: { desktopEntries: ['thunar'], binaries: ['thunar'] },
    },
    tiers: [
      {
        tier: 5,
        summary: 'The GTK accessibility tree, published on the AT-SPI bus while the application is running.',
        effect: 'observe',
        platforms: [ATSPI_LINUX],
      },
    ],
  },

  {
    id: 'xcode',
    name: 'Xcode',
    category: 'devtool',
    summary: 'Apple\'s IDE. macOS only — and declared as macOS only rather than being probed hopefully elsewhere.',
    observationSensitivity: 'inventory',
    nodeId: 'xcode',
    detect: {
      darwin: { bundleIds: ['com.apple.dt.Xcode'], appNames: ['Xcode'], binaries: ['xcodebuild'] },
    },
    tiers: [
      {
        tier: 3,
        summary: '`xcodebuild -version` and `xcrun --find`, both documented and both non-interactive.',
        effect: 'observe',
        platforms: [
          YES_TIER('darwin', ['xcodebuild'], 'Provided by the Command Line Tools, which Xcode installs.'),
          NO_TIER('linux', 'Xcode does not exist on Linux. There is nothing to detect and nothing to reach.'),
          NO_TIER('win32', 'Xcode does not exist on Windows. There is nothing to detect and nothing to reach.'),
        ],
      },
    ],
  },

  {
    id: 'photoshop',
    name: 'Adobe Photoshop',
    category: 'design',
    summary: 'Reachable only through a plugin AURA does not ship, so it is detectable but not actuable.',
    observationSensitivity: 'inventory',
    nodeId: 'photoshop',
    detect: {
      darwin: { bundleIds: ['com.adobe.Photoshop'], appNames: ['Adobe Photoshop 2024', 'Adobe Photoshop 2025'] },
      win32: { uninstallNames: ['Adobe Photoshop'], startMenuNames: ['Adobe Photoshop'] },
    },
    /**
     * Empty on purpose, and the most honest entry in this file.
     *
     * Photoshop's automation surface is UXP: a plugin the user installs
     * into Photoshop, signed and distributed through Adobe. AURA ships no
     * such plugin. Declaring a tier-6 "we could click the menus" rung
     * instead would be exactly the guess this format exists to prevent —
     * so the application is discoverable, reported present, and reported
     * as having no way in. `selectTier` turns that into `not-executed`
     * with a reason a user can act on.
     */
    tiers: [],
  },

  {
    id: 'telegram',
    name: 'Telegram Desktop',
    category: 'communication',
    summary: 'A messaging client. Detected for inventory completeness; observing it is a personal disclosure.',
    /**
     * `personal`, not `inventory`. Which messaging clients a person has
     * says something about who they talk to and how, and that belongs in
     * a different category from which compiler they have — even though
     * the mechanics of detecting the two are identical.
     */
    observationSensitivity: 'personal',
    detect: {
      linux: { desktopEntries: ['org.telegram.desktop', 'telegramdesktop'], binaries: ['telegram-desktop'] },
      darwin: { bundleIds: ['ru.keepcoder.Telegram'], appNames: ['Telegram'] },
      win32: { uninstallNames: ['Telegram Desktop'], startMenuNames: ['Telegram Desktop'] },
    },
    /** No rung. AURA has no business driving somebody's messaging client. */
    tiers: [],
  },

  {
    id: 'tor-browser',
    name: 'Tor Browser',
    category: 'browser',
    summary: 'Anonymity tooling. Detectable, never actuable, and the highest observation sensitivity in this file.',
    /**
     * `confidential`. The presence of anonymity tooling on a machine can
     * imply things about a person — their profession, their jurisdiction,
     * their risk — that they may have decided, carefully, not to
     * disclose. A scan that touches this entry says so in its result, so
     * that a caller which asked for an application inventory does not
     * discover afterwards that it collected this too.
     */
    observationSensitivity: 'confidential',
    detect: {
      linux: {
        desktopEntries: ['org.torproject.torbrowser-launcher', 'torbrowser'],
        binaries: ['torbrowser-launcher'],
      },
      darwin: { bundleIds: ['org.torproject.torbrowser'], appNames: ['Tor Browser'] },
      win32: { uninstallNames: ['Tor Browser'], startMenuNames: ['Tor Browser'] },
    },
    tiers: [],
  },
];

export const applicationAdapter = (id: string): ApplicationAdapter | undefined =>
  APPLICATION_ADAPTERS.find((a) => a.id === id);

/* ══════════════════════════════════════════════════════════════════
   6. What a scan produces
   ══════════════════════════════════════════════════════════════════ */

/**
 * One application, as measured on this machine.
 *
 * `present: false` with `via: null` is the ordinary answer and carries no
 * apology — most applications are absent from most machines, and saying
 * so plainly is the whole value of a scanner that refuses to guess.
 */
export interface DiscoveredApplication {
  id: string;
  name: string;
  category: ApplicationAdapter['category'];
  present: boolean;
  /** Which source answered. `null` when nothing did. */
  via: DetectionSource | null;
  /**
   * What was actually found — the `.desktop` path, the resolved binary,
   * the registry `DisplayName`. Evidence, so a user can check the claim
   * rather than take it.
   */
  evidence: string | null;
  /**
   * Stamped by the scanner from the adapter, on every record.
   *
   * Carried on the record rather than looked up later because the record
   * is what travels — into a result, a journal entry, possibly a model's
   * context — and a sensitivity that has to be re-derived at each of
   * those points is one that will be dropped at one of them.
   */
  sensitivity: ObservationSensitivity;
  /** Every rung declared for this application, with its measured availability. */
  tiers: import('./tiers').TierProbe[];
  /** Detection was not attempted because the adapter does not claim this platform. */
  undetectableHere: boolean;
}

export interface ApplicationScan {
  at: string;
  platform: TargetPlatform | null;
  applications: DiscoveredApplication[];
  /**
   * The highest sensitivity this scan actually TOUCHED — computed over
   * the adapters that were examined, present or not.
   *
   * Over examined rather than found on purpose. Determining that Tor
   * Browser is *absent* still required looking, and a scan that reports
   * `inventory` because the confidential entry happened to miss would be
   * describing its results rather than its reach.
   */
  sensitivity: ObservationSensitivity;
  /** How many adapters could not be detected on this platform at all. */
  undetectableCount: number;
}
