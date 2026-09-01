# AURA Hub — Release Handoff (v0.1.0)

Release-focused companion to the
[Master Handoff](./AURA_HUB_MASTER_HANDOFF.md). Everything here was verified on
2026-08-13.

---

## 1. The release

| Field | Value |
| --- | --- |
| Version | **0.1.0** (`apps/desktop/src-tauri/tauri.conf.json`) |
| Tag | **`v0.1.0`** |
| Commit | **`a3826253e713b36134fd1cf479d8462f6d68d9f5`** |
| Release URL | https://github.com/Aura-hub-ai-native-workspace/aura-hub/releases/tag/v0.1.0 |
| State | Published · not draft · not prerelease |
| Source of binaries | CI run **`31693075020`** — downloaded, **never rebuilt** |
| Product identifier | `com.aura.hub`, productName `AURA Hub` |

---

## 2. Artifacts

Permanent asset URLs are
`https://github.com/Aura-hub-ai-native-workspace/aura-hub/releases/download/v0.1.0/<filename>`.

| Filename | Bytes | Platform | Arch | Format |
| --- | --- | --- | --- | --- |
| `AURA-Hub-0.1.0-linux-x64.AppImage` | 80,820,728 | Linux | x64 | ELF static-pie |
| `AURA-Hub-0.1.0-linux-x64.deb` | 6,169,006 | Linux | x64 | Debian 2.0 |
| `AURA-Hub-0.1.0-windows-x64.exe` | 5,302,474 | Windows | x64 | NSIS / PE32 |
| `AURA-Hub-0.1.0-macos-arm64.dmg` | 6,743,912 | macOS | arm64 | Apple DMG v4 |
| `AURA-Hub-0.1.0-macos-x64.dmg` | 6,773,270 | macOS | x64 | Apple DMG v4 |

### SHA-256

```
0fa9fa65cace15a97a4e42be274662192c89b8b645966d5df2e156152f9c07c1  AURA-Hub-0.1.0-linux-x64.AppImage
7f3adad83c08579631e5fc8ef55cb7dfc74656929a0fef9d34437b67caef278b  AURA-Hub-0.1.0-linux-x64.deb
3b3105cd220c56d8caed7b9879bc0ed1e36999523227cec1d5c153a035900f11  AURA-Hub-0.1.0-windows-x64.exe
d173219a47577f8fde476385f24bd358c500dd23d4997acc170288a66a0b433d  AURA-Hub-0.1.0-macos-arm64.dmg
c8655b89213f6ff63310d564635be4aec3c757526cbdd331a36b9cad3a07fbfe  AURA-Hub-0.1.0-macos-x64.dmg
```

Verified **twice**: recomputed from the CI artifacts before upload, then
re-downloaded from the public URLs after publication and re-hashed — all five
`OK`. File types were also confirmed to differ per platform, proving no
artifact was substituted for another.

---

## 3. Platform matrix

| | Linux x64 | Windows x64 | macOS ARM64 | macOS Intel x64 |
| --- | --- | --- | --- | --- |
| Build | BUILT | BUILT | BUILT | BUILT |
| Runtime | **RUNTIME VERIFIED** 29/29 | **RUNTIME VERIFIED** 34/34 | **RUNTIME VERIFIED** 29/29 | **RUNTIME VERIFIED** 29/29 |
| Detection | VERIFIED 20/61 | VERIFIED 11/61 | VERIFIED 22/61 | VERIFIED 21/61 |
| Service lifecycle | VERIFIED | VERIFIED (normal + abnormal) | VERIFIED | VERIFIED |
| Installer | VERIFIED (deb + AppImage, incl. uninstall) | VERIFIED (NSIS, incl. uninstall) | VERIFIED (DMG) | VERIFIED (DMG) |
| Runner | `ubuntu-latest` | `windows-latest` | `macos-latest` | `macos-15-intel` |
| Signing | N/A | **NOT CONFIGURED** | **NOT CONFIGURED** | **NOT CONFIGURED** |

Windows carries 5 extra checks: the abnormal-termination phase kills the shell
with `taskkill /F` and requires the Job Object to have taken the service down
with it, releasing port 4319 without any graceful shutdown having run.

### Installer flows actually exercised

- **Linux `.deb`** — `apt-get install` → `/usr/bin/aura-hub` → launch → health →
  detection through the installed app → `apt-get remove` clean.
- **Linux AppImage** — executed directly → service healthy.
- **Windows NSIS** — silent `/S` install → found via the installer's own
  uninstall-registry `InstallLocation` (`%LOCALAPPDATA%\AURA Hub`, *not* under
  `Programs`) → launch → health → detection → uninstall clean.
- **macOS (both)** — DMG mounted → `.app` copied out → launched → health →
  detection.

---

## 4. CI

`.github/workflows/ci.yml`, job `desktop-build`, `fail-fast: false`.

Steps: `npm ci` → **build (retried 3×)** → xvfb (Linux only) → **runtime
verification on the native OS** → `stage-release-artifacts.mjs` → **installer
verification** → upload.

Two hard-won details:

- **The retry is not cosmetic.** Tauri downloads bundler tooling at build time
  (AppRun/linuxdeploy, NSIS binaries) and GitHub's CDN drops those connections
  intermittently: `failed to bundle project: io: Peer disconnected` hit two
  different platforms in three runs. A genuine build error still fails 3×.
- **`macos-13` was retired in December 2025.** A retired label does not fail a
  job — it **queues it forever**. Eight consecutive runs sat unassigned for ten
  hours, indistinguishable from runner scarcity. The Intel leg is now
  `macos-15-intel`, which GitHub has said is planned to be the **last** Intel
  image. When it goes, Intel coverage ends — report that rather than
  cross-compiling and assuming.

---

## 5. Website distribution

**The deployed site is a separate repository.** `website/` in this monorepo is
a mirror and deploys nothing.

| | Repository | Commit |
| --- | --- | --- |
| Live site | `Aura-hub-ai-native-workspace/aura-hub-website` (`main`) | `f42a7bb3dbec868309ad68d26a8aad9e4e20853c` |
| Mirror | `aura-hub` (`feature/website-deployment`) | `265e690f19a38e66a3c9adc21ceeea14bc004ec3` |

**Hosting:** Cloudflare **Workers Static Assets** (`wrangler.jsonc`,
`assets.directory: "./"`, `not_found_handling: 404-page`). **No build step, no
backend, no database, no API.** Deploy is `npx wrangler deploy`.

**Single source of truth** — one `RELEASE` object holds version, release URL
and all five asset filenames. `v0.1.0` appears **nowhere** in the markup, so
the next release is a one-object edit.

**Download UX** — all five downloads always visible. Detection only adds a
"Recommended for your system" highlight; it never hides, disables or reorders.
macOS architecture is **not guessed** (Safari reports the same platform string
for both, and a Rosetta browser reports Intel on Apple Silicon), so both macOS
builds are shown side by side.

**Validation:** 37/37 browser checks against the file fetched back from
`origin/main` — every link resolves to its own asset, no CI-artifact URLs, no
localhost, no filesystem paths, no placeholders, version displayed, existing
navigation intact, no mobile overflow introduced.

**Live URL note:** `https://aurahub.is-a.dev` returned **HTTP 403** (Cloudflare
error page) when checked on 2026-08-13, browser User-Agent included. Reported
as observed, not diagnosed. The site repo's lychee CI excludes this domain.

---

## 6. Known release limitations

| Limitation | Detail |
| --- | --- |
| **Unsigned everywhere** | Windows: SmartScreen warns. macOS: unsigned **and not notarized**, Gatekeeper quarantines. **The single blocker for public distribution.** |
| **Node.js 18+ required** | Deliberately not bundled, so AURA runs on the Node it reports detecting. |
| **No Linux ARM / Windows ARM** | Not built, not claimed. |
| **Intel macOS is time-limited** | `macos-15-intel` is the planned-final Intel image. |
| **Mission Control unreachable** | Plus ~19 command-palette surfaces. Ships in the build; users cannot open it. |
| **No auto-update** | No updater configured; users re-download. |
| **`verify-providers`** | 10 pre-existing failures (provider-switch lag). |
| **`ui-approval-test`** | 17 pre-existing failures (Mission Control). |
| **`packaging-verify`** | 40/44 locally — 4 environment-dependent, caused by `opencode` living under a custom npm prefix. Safety unaffected (`denied`, `attempts=0`). |
| **No notification test suite** | None exists. Do not invent one to claim coverage. |
| **Live site 403** | See §5. |

---

## 7. Cutting the next release

1. `git status --short` — confirm no user WIP will be swept in.
2. `npm run typecheck` + the regression suites (Master Handoff §18).
3. Push the branch; let **every platform build and runtime-verify natively**.
   A green build is not a green run.
4. Download the CI artifacts; record SHA-256.
5. Tag the **validated commit** and publish:
   ```bash
   gh release create v<version> --target <sha> \
     --title "AURA Hub v<version>" --notes-file <notes> <5 artifacts>
   ```
   Notes must state platforms, Node.js 18+, Windows unsigned, macOS unsigned
   **and not notarized**. Never claim signed, notarized, self-contained or
   zero-install.
6. Re-download all five public URLs; re-hash against step 4.
7. Update the `RELEASE` object in **`aura-hub-website`** — not `website/`.
8. Re-run the website validation; confirm all links resolve.
9. Sync the mirror **from** the deployed file, never over it.
10. Confirm `HEAD == origin` for every repo touched, and that **`main` is
    untouched**.

**DO NOT TOUCH `main` UNLESS EXPLICITLY APPROVED.**
