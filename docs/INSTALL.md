# Installing AURA Hub

AURA Hub is a Tauri desktop application. It ships as a native installer for
each platform, built on that platform's own CI runner — nothing here is
cross-compiled.

---

## Requirement: Node.js 18 or newer

**Node is required on every platform, and AURA Hub does not bundle it.**

That is a deliberate architectural choice, not an omission. AURA treats Node
as an external execution node — it appears in the Connected Environment
catalogue and in `SAFE_BINARIES` like any other tool — so the application
runs on *the same* Node it reports detecting. Bundling a private copy would
mean the Hub executes on one runtime while telling you about another.

If Node is missing, the application says so plainly at launch instead of
failing obscurely. Set `AURA_NODE` to an explicit interpreter path to
override discovery.

| Platform | Discovery order |
|---|---|
| Linux | `AURA_NODE` → PATH → `/usr/local/bin`, `/usr/bin` → `~/.local/bin`, `~/.bun/bin` → `~/.nvm/versions/node/*/bin/node` |
| macOS | `AURA_NODE` → PATH → `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin` (Intel) → `~/.nvm/versions/node/*/bin/node` |
| Windows | `AURA_NODE` → PATH (`node.exe`) → `C:\Program Files\nodejs` → Scoop → `%APPDATA%\nvm\*` |

---

## Downloads

Artifacts are published as GitHub Actions artifacts, named:

```
AURA-Hub-<version>-<os>-<arch>.<ext>
```

| Platform | Architecture | Artifact |
|---|---|---|
| Linux | x64 | `AURA-Hub-<version>-linux-x64.AppImage` |
| Linux | x64 | `AURA-Hub-<version>-linux-x64.deb` |
| Windows | x64 | `AURA-Hub-<version>-windows-x64.exe` (NSIS installer) |
| macOS | Apple Silicon | `AURA-Hub-<version>-macos-arm64.dmg` |
| macOS | Intel | `AURA-Hub-<version>-macos-x64.dmg` |

Linux ARM and Windows ARM are **not built and not supported** — claiming them
without a runner to build and test on would be a guess.

---

## Linux

**AppImage** — self-contained, no installation:

```bash
chmod +x AURA-Hub-<version>-linux-x64.AppImage
./AURA-Hub-<version>-linux-x64.AppImage
```

**Debian / Ubuntu**:

```bash
sudo apt install ./AURA-Hub-<version>-linux-x64.deb
aura-hub
```

The `.deb` declares a dependency on `nodejs`, so apt will pull it in if it is
missing. The AppImage cannot declare dependencies — install Node yourself.

## macOS

Open the `.dmg` and drag **AURA Hub** to Applications. Pick the artifact
matching your machine: `arm64` for Apple Silicon, `x64` for Intel.

**The artifacts are unsigned and un-notarized** (see below), so the first
launch is blocked by Gatekeeper. Right-click the app → **Open** → **Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/AURA Hub.app"
```

## Windows

Run `AURA-Hub-<version>-windows-x64.exe` and follow the installer.

**The installer is unsigned**, so SmartScreen will warn on first run:
**More info** → **Run anyway**.

---

## What happens at launch

```
launch → resolve app directories → locate bundled service → resolve Node
       → start service → health gate → verify identity → show window
```

The window is shown only once the local service answers `/health` *and*
identifies as AURA. A spawned process that is still starting, or that died,
is not a running service, so readiness is never assumed.

**Port 4319.** The service binds `127.0.0.1:4319`.

- Nothing listening → AURA starts its own service.
- A compatible AURA service already running → it is reused, and left alone on
  exit because it belongs to whoever started it.
- Something else on the port → AURA **refuses to start** and says so. It will
  not adopt a service it cannot identify, and it will never kill a process
  that was there first.

On quit, a service AURA started is shut down gracefully — `SIGTERM` on
Unix, and a loopback shutdown request on Windows, which has no `SIGTERM`
and where a hard terminate would deny the service its clean close. No orphan
process is left holding the port.

## Where your data lives

User state is written to `AURA_HOME`, defaulting to `~/.aura`, and never
inside the installed application (which may be read-only). Set `AURA_HOME` to
relocate it. Logs are at `$AURA_HOME/logs/ai-service.log`.

---

## Code signing and notarization

| Platform | Status |
|---|---|
| Linux | **NOT APPLICABLE** — no signing expectation for AppImage/deb |
| macOS | **SIGNING: NOT CONFIGURED** — unsigned, un-notarized |
| Windows | **SIGNING: NOT CONFIGURED** — unsigned |

AURA Hub is **not** "App Store ready" and **not** "Gatekeeper trusted". For
production distribution you would need:

- **macOS** — an Apple Developer ID Application certificate, signing with
  hardened runtime, then notarization and stapling. In CI: `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID`, which Tauri's bundler reads directly.
- **Windows** — an Authenticode code-signing certificate (ideally EV, which
  clears SmartScreen reputation immediately), configured via
  `tauri.conf.json`'s `bundle.windows.certificateThumbprint` or a signing
  command.

No signing material is present in this repository, and none is implied.

## Verification status

Every platform is built and runtime-tested on its own native runner. A build
is not a run, and this table never converts one into the other — see the
release report for the current per-platform results.
