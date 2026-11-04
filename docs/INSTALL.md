# Installing AURA Hub

AURA Hub is a Tauri desktop application. It ships as a native installer for
each platform, built on that platform's own CI runner — nothing here is
cross-compiled.

---

## Runtimes: what is bundled and what is not

**The installers ship their own Node.js and CPython with the Python packages the backend needs**, so a
machine with neither installed can run AURA Hub. The versions are pinned in `scripts/build-service-bundle.mjs`
(`NODE_RUNTIME_VERSION = v22.23.2`, `PY_RUNTIME_VERSION = 3.12.14` at 0.1.20; python-build-standalone) and
each CI runner stages the packages for its own platform, so the Windows and macOS installers carry their
own native wheels. The backend needs Python 3.12, which is why the interpreter is shipped: Ubuntu 22.04
ships 3.10 and Debian 12 ships 3.11. At launch the shell picks Node in this
order: `AURA_NODE` (explicit path; an invalid path is an error) → the bundled Node → a Node found on the
machine. A development checkout stages no runtime and uses the machine's Node (18 or newer).

Node also appears in the Connected Environment catalogue as an external tool, like git. The bundled copy
is what runs AURA's own service; it does not hide or replace the Node you use for your projects.

The Debian package still declares `nodejs` as a dependency (see its `Depends`); the bundled runtime means
the application does not need it to start, but the declaration is kept.

| Platform | Node discovery when the bundled runtime is absent (development) |
|---|---|
| Linux | `AURA_NODE` → PATH → `/usr/local/bin`, `/usr/bin` → `~/.local/bin`, `~/.bun/bin` → `~/.nvm/versions/node/*/bin/node` |
| macOS | `AURA_NODE` → PATH → `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin` (Intel) → `~/.nvm/versions/node/*/bin/node` |
| Windows | `AURA_NODE` → PATH (`node.exe`) → `C:\Program Files\nodejs` → Scoop → `%APPDATA%\nvm\*` |

---

## System requirements

Each statement is marked **measured** (checked against the actual build output), **declared** (stated
by the package metadata), or **inferred** (reasoned, not tested on that system). Only an Arch Linux
x86_64 machine has been used to run the application; **no other distribution, Windows or macOS has been
executed**, so none of them is claimed as supported — see `docs/audit/CROSS_PLATFORM_MATRIX.md`.

### Linux x86_64

| Requirement | Value | Basis |
|---|---|---|
| glibc | **2.34 or newer** | measured on the Linux build of 0.1.20 by `node scripts/glibc-floor-verify.mjs`: the shell binary's highest hard requirement is 2.34 (two 2.39 references, `pidfd_spawnp`/`pidfd_getpid`, are weak and do not raise it); bundled Node needs 2.28; bundled Python extension modules need at most 2.34. Re-run the script on any new build: the floor follows the build machine. |
| WebKitGTK | `libwebkit2gtk-4.1` and `libjavascriptcoregtk-4.1` (the 4.1 API, libsoup 3) | measured (`readelf -d`), declared by the `.deb` (`libwebkit2gtk-4.1-0`) |
| GTK and friends | `libgtk-3`, `libgdk-3`, `libgdk_pixbuf-2.0`, `libcairo`, `libglib-2.0`, `libgobject-2.0`, `libgio-2.0`, `libdbus-1`, `libsoup-3.0` | measured; `.deb` declares `libgtk-3-0` and pulls the rest through WebKitGTK |
| Display | an X11 or Wayland session (the app is a GTK window) | inferred; a virtual X display (Xvfb) was used for testing |
| AppImage | FUSE 2 (`libfuse2`) to mount it, or run it with `--appimage-extract-and-run` | inferred from how AppImages work; not tested without FUSE |
| Optional | `update-desktop-database`, `gtk-update-icon-cache` (used only by "Install AURA Hub", failures ignored) | measured in source |
| Tools AURA drives | git, a coding-agent CLI, etc. are detected, not installed by AURA; a capability whose tool is missing is reported unavailable | design, see the Connected Environment |

Consequences of the glibc floor (inferred from the distributions' published glibc versions, **not tested**):
Ubuntu 22.04 (glibc 2.35) and Debian 12 (2.36) and newer meet it; Ubuntu 20.04 (2.31) and Debian 11
(2.31) do not and are not supported. Whether the 4.1 WebKitGTK packages are installable on a given
release has not been checked here. Verified to run: Arch Linux (glibc 2.44) only.

### Windows x64 and macOS (arm64, x64)

The installers are built and smoke-run by CI on native runners (`.github/workflows/ci.yml`), but **no
requirement below that has been verified by running AURA Hub on those systems from this repository's
audits**. Windows needs the WebView2 runtime that the installer expects (inferred from Tauri's
requirements); macOS has no system requirement measured. Treat both as unverified.

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

The `.deb` declares `nodejs`, `libwebkit2gtk-4.1-0` and `libgtk-3-0`, so apt pulls them in. The AppImage
declares nothing: it needs the system libraries listed under System requirements, and carries its own
Node and Python.

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
