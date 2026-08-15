# AURA Hub — Update Engine

How AURA Hub updates itself, what it refuses to do, and what has actually
been verified. Written against `feature/update-experience-v1`.

> **Scope note.** `docs/AURA_HUB_MASTER_HANDOFF.md` does not exist on this
> branch — it is untracked work on `feature/workspace-execution-environment`.
> Its §13 states the shell has **six** IPC commands. That is now **seven**
> (see [IPC surface](#ipc-surface)). Apply that correction when the branches
> converge; it cannot be applied from here.

---

## 1. Authority split

Three parties, three different questions. None of them substitutes for
another, and no layer above re-answers a question below it.

| Question | Owner | Where |
| --- | --- | --- |
| Is this artifact **authentic and intact**? | Tauri updater (minisign) | `tauri-plugin-updater`, pubkey in `tauri.conf.json` |
| Does this candidate **apply to this install**? | AURA policy | `apps/desktop/src/updater/applicability.ts` |
| What is the **user-visible lifecycle**? | AURA service | `apps/desktop/src/updater/updateService.ts` |
| What does the user **see**? | AURA UI | `updater/UpdatePanel.tsx`, `updatePresentation.ts` |
| What **exists to install**? | Release pipeline | `.github/workflows/ci.yml`, `scripts/build-latest-json.mjs` |

```
GitHub Release → latest.json → Tauri updater ─┬─ authenticity (minisign)
                                              └─ artifact selection
                                                     ↓
                                              applicability (AURA)
                                                     ↓
                                              UpdateService
                                                     ↓
                                              UpdatePanel
```

**The UI never verifies a signature, never fetches metadata, never builds
an artifact URL and never compares versions.** Enforced by
`scripts/update-ui-verify.mjs` cases 21–25.

---

## 2. Update states

The vocabulary is `UpdateState` in `updater/types.ts`. One state at a
time; each carries exactly what a renderer needs.

| State | Meaning | Shown as |
| --- | --- | --- |
| `idle` | Nothing attempted yet | Ready |
| `checking` | Asking the endpoint | Checking |
| `up-to-date` | No applicable candidate | Up to date |
| `update-available` | An applicable candidate exists | Update available |
| `downloading` | Native download in progress | Downloading |
| `installing` | Reserved; the native call couples download+install | Installing |
| `ready-to-install` | Downloaded, **verified and installed**; awaiting relaunch | **Ready to restart** |
| `restarting` | Relaunch requested | Restarting |
| `cancelled` | User stopped it; nothing changed | Cancelled |
| `failed` | Carries an `UpdateErrorCode` | Per cause |

Two things worth stating plainly:

- **`ready-to-install` means already installed.** Tauri couples download
  and install into one verified operation, so by the time this state is
  reached the bytes are on disk. Only the relaunch remains, which is why
  the UI says "Ready to restart" rather than implying another step.
- **`installing` is never entered today.** It exists in the vocabulary and
  is presented correctly if it ever is.

### Error codes

`NETWORK_ERROR` · `INVALID_METADATA` · `INVALID_SIGNATURE` ·
`INCOMPATIBLE_PLATFORM` · `UNSUPPORTED_ARCHITECTURE` · `DOWNGRADE_REJECTED` ·
`MISSING_ARTIFACT` · `DOWNLOAD_FAILED` · `INSTALL_FAILED` · `RESTART_FAILED` ·
`UPDATE_CANCELLED` · `UNSUPPORTED_INSTALL`

`INVALID_SIGNATURE` is deliberately distinct and **not offered a retry**:
it is the one failure that may indicate tampering rather than bad luck,
and retrying cannot help.

---

## 3. Install kind, and the `.deb` limitation

Tauri's Linux updater replaces the **running AppImage** in place. A
package-manager install has nothing for it to replace — the files belong
to `dpkg`.

```
InstallKind = 'self-updating' | 'managed' | 'unknown'
```

- `self-updating` — AppImage on Linux; every Windows and macOS install.
- `managed` — installed by a system package manager (`.deb`).
- `unknown` — could not be determined.

**`unknown` is refused**, not assumed updatable: guessing "yes" risks a
failed install, guessing "no" costs only a manual download. An adapter
with no probe at all is likewise refused.

A `managed` install fails with `UNSUPPORTED_INSTALL` **before the network
is contacted**, and the panel shows the manual path:

> Automatic updates aren't available for this installation.
> This copy was installed by your system package manager, which owns
> updating it. → *Latest release*

### Manual upgrade path

`.deb` users download the current `.deb` from the releases page and
install it with their package manager. AURA does not attempt to drive
that, and does not pretend it can.

---

## 4. IPC surface

**Seven** commands. None is a shell.

| Command | Purpose |
| --- | --- |
| `environment_ping` | Bridge health check |
| `service_status` | AURA service lifecycle state |
| `code_read_dir` | Code Workspace listing |
| `code_read_file` | Code Workspace read |
| `code_write_file` | Code Workspace write |
| `code_create_file` | Code Workspace create |
| **`update_install_kind`** | **New.** Reports `self-updating` / `managed` |

`update_install_kind` takes **no arguments**, executes nothing, and reads
only the process's own environment (`APPIMAGE` on Linux; other platforms
answer `self-updating` unconditionally). A caller may ask *what am I*; it
cannot point the command at anything.

---

## 5. Release artifact expectations

`scripts/build-latest-json.mjs` writes `latest.json` and **refuses to
publish** when any of the following is true. Each refusal is exercised by
`scripts/release-gate-verify.mjs`.

| Condition | Refusal |
| --- | --- |
| An artifact has no `.sig` | R1 |
| A `.sig` is empty | R2 |
| Artifacts disagree on version | R3 |
| A supported platform is missing | R4 |
| No artifacts at all | R5 |
| Two artifacts claim one target | R6 |

Expected filenames, as `stage-release-artifacts.mjs` writes them:

```
AURA-Hub-<version>-linux-x64.AppImage.tar.gz
AURA-Hub-<version>-windows-x64.nsis.zip
AURA-Hub-<version>-macos-x64.app.tar.gz
AURA-Hub-<version>-macos-arm64.app.tar.gz
```

Manifest URLs point at **permanent GitHub Release assets**
(`/releases/download/<tag>/`), never at Actions artifacts, which expire.

---

## 6. Signing requirement

Signing is **mandatory**; there is no unsigned path.

- The private key exists only as the CI secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- It is never committed, never echoed, never logged.
- The public key (the trust anchor) lives in `tauri.conf.json` and is not
  a secret.
- An unsigned or empty-signature artifact cannot reach `latest.json`, and
  an artifact that did reach a client unsigned would fail verification on
  every machine.

**Rotating the key breaks every installed copy** — a client only trusts
the pubkey compiled into it. Treat rotation as a migration, not a config
change.

---

## 7. Platform support

| Platform | Artifact | Self-updating |
| --- | --- | --- |
| Linux x86_64 | AppImage | Yes |
| Linux x86_64 | `.deb` | **No** — manual |
| Windows x86_64 | NSIS (`installMode: passive`) | Yes |
| macOS x86_64 | `.app` | Yes |
| macOS aarch64 | `.app` | Yes |

Linux ARM and Windows ARM are not built and are not claimed.

---

## 8. What is NOT verified

Stated so nobody infers otherwise from a green suite:

- **No real minisign verification has been performed outside CI.** Every
  `.sig` in the local suites is arbitrary bytes. The deterministic tests
  prove AURA *handles* a signature failure the native layer reports; they
  prove nothing about the cryptography.
- **No native update has ever run end to end**, on any platform. There is
  no published `latest.json` and no signed updater artifact to update to.
- Windows and macOS behaviour is unverified outside CI builds.
- The `APPIMAGE` probe is compile-verified only; it has not been observed
  running inside a real AppImage or a real `.deb` install.

---

## 9. Verification suites

| Suite | Covers |
| --- | --- |
| `scripts/updater-verify.mjs` | Applicability, state machine, native-boundary confinement, `.deb` refusal (P1–P4) |
| `scripts/update-ui-verify.mjs` | The 25 UI/lifecycle cases, no-fake-progress, no hardcoded version |
| `scripts/release-gate-verify.mjs` | Publish refusals, version authority, signing hygiene |
| `scripts/release-verify.mjs` | Manifest checked before publish (CI) |
