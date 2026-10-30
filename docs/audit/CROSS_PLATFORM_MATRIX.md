# AURA Hub — Cross-platform compatibility matrix and findings (Alpha loop 5)

Date: 2026-10-28. Source: branch `feat/laya-shadow-planner`, HEAD `df2cc92` plus uncommitted changes (nothing committed or pushed).
Evidence: `docs/audit/evidence/cross-platform/` (every gate recorded by `run_gate.sh`: command, timestamps, versions, exit code).

## 0. What was actually executed, and where

The only machine available is **Arch Linux x86_64** (kernel 6.18, glibc 2.44, Node 22.23, Python 3.12.7). There is no Windows host, no macOS
host, no Debian/Ubuntu host, no running Docker daemon, and no passwordless root. Therefore:

- **Linux** results are from the Arch host (native).
- **Ubuntu/Debian**: static analysis only (glibc symbol floor). No runtime execution.
- **Windows and macOS**: **nothing was executed natively.** Linux tests that simulate Windows paths or patch `os.name` are listed as
  simulations and are **not** counted as a Windows pass.

Status vocabulary: PASS = executed on that platform and passed; FAIL = executed and reproduced a defect; BLOCKED = a documented
prerequisite is missing; PARTIAL = some required checks passed; NOT RUN = no execution evidence.

## 1. Documented support matrix (from the repository)

| Source | Claim |
|---|---|
| `docs/INSTALL.md` | Linux x64 (AppImage, .deb), Windows x64 (NSIS), macOS arm64 and x64 (.dmg). Linux ARM and Windows ARM "not built and not supported". macOS and Windows installers are unsigned; Linux has no signing expectation. |
| `apps/desktop/src-tauri/tauri.conf.json` + `tauri.windows.conf.json` + `tauri.macos.conf.json` | targets appimage, deb, nsis; macOS overlay app+dmg; updater endpoint on GitHub releases with a public key; `createUpdaterArtifacts` needs `TAURI_SIGNING_PRIVATE_KEY`. |
| `.github/workflows/ci.yml` | **Typecheck/build and unit tests: ubuntu only. Backend pytest: ubuntu only, deliberately** (the file says Windows/macOS legs would be "noisy" before a first real run). **Desktop packaging matrix: four native legs** (ubuntu, windows-latest, macos-latest arm64, macos-15-intel), each builds its own artifact and runs `scripts/desktop-runtime-verify.mjs` plus a per-OS install/launch step. A release job requires a `v*` tag. |
| `docs/AURA_HUB_V0.1.20_CROSS_PLATFORM_RELEASE_REPORT.md` | Windows and macOS runtime: "NOT VERIFIED - ENVIRONMENT LIMITATION" (pipeline ready, not runtime verified). |

There is no evidence in the repository that the Windows or macOS legs have gone green for this source tree, and they cannot run on
local uncommitted changes (a push is required, which is not authorized here).

## 2. Test matrix

| Area | Linux (Arch x86_64 host) | Windows x64 | macOS arm64 / x64 |
|---|---|---|---|
| Install / build / package | **PARTIAL** — AppImage and .deb built through `npm run desktop:build`; the command exits 1 only at updater signing (no private key), so no updater artifacts or `.sig` exist. Ubuntu/Debian: static glibc floor only (section 5). | NOT RUN (CI leg configured, not executed) | NOT RUN (CI legs configured, not executed) |
| Application launch | **PASS** — packaged verifier 62/62 (exit 0), acceptance B/C, GUI session, under my own Xvfb + minimal i3. Ubuntu/Debian: **BLOCKED** (no Debian-family host, Docker daemon down, nspawn needs root). | NOT RUN | NOT RUN |
| Backend / service startup | **PASS** — packaged harness 60/60, verifier, ownership proof; graceful quit in 1.9–2.7 s. | NOT RUN | NOT RUN |
| Filesystem / path handling | **PASS** — backend suite incl. new hostile-path test (spaces, `#`, `%`, `&`, `'`, non-ASCII) and SQLite URI check. | NOT RUN. (Linux *simulations* of Windows paths exist in the suite; not a Windows pass.) | NOT RUN (NFD filename normalisation untested) |
| Authentication / governance | **PASS** — instance-token guard, governance hook fail-closed, acceptance B/C (0 foreign requests). | NOT RUN. Defect X-04 found by code trace, unverified natively. | NOT RUN |
| Tool execution and subprocesses | **PASS** after fixes X-01..X-03 (regression tests that failed before). | NOT RUN (X-02, X-04 are Windows-specific and only simulated/unit-tested) | NOT RUN |
| Cancellation and cleanup | **PARTIAL** — process trees now end on Stop/timeout (Node runner, MCP client); GUI: chat Stop incl. repeated Stop and completed-run observed; workflow/automation Stop, failed/unconfirmed cancel and retry-wait covered by tests only. | NOT RUN (`taskkill /T` paths simulated) | NOT RUN |
| Local model / Ollama | **PARTIAL** — works end-to-end through a user-run server; the system service is broken (F-33, owner action). | NOT RUN | NOT RUN |
| Document ingestion / generation | **PASS** — packaged harness: DOCX, XLSX, PDF generation + ingestion + search, scanned/locked/corrupt refusals, with the bundled Python and its native wheels. | NOT RUN | NOT RUN |
| Network destination security | **PASS** — HTTP policy/redirect tests, acceptance B/C; snapshot of the app's sockets showed loopback only (a snapshot, not a continuous capture). | NOT RUN | NOT RUN |
| Project-scoped knowledge | **PASS** — backend tests, packaged harness (tool + REST scoping), hostile-path test. | NOT RUN | NOT RUN |
| Update / signature verification | **BLOCKED** — no `TAURI_SIGNING_PRIVATE_KEY`; nothing was signed or verified. | **BLOCKED** (also no Authenticode certificate) | **BLOCKED** (no Developer ID, not notarized) |
| UI and window management | **PARTIAL** — Xvfb with a minimal i3 only (verifier window checks 3d/3e pass under it). No real desktop environment, Wayland, HiDPI or multi-monitor run. | NOT RUN | NOT RUN |

Also **NOT RUN on this artifact**: the packaged UI smoke of git status / git diff / read inside a project (loop 4's PASS belongs to artifact
`fca9a7af...`), and the identity-mismatch banner in the UI for acceptance B/C (the 0-request property was re-verified).

## 3. Confirmed defects found and fixed this loop

All fixes are uncommitted. Each regression test was run **before** the fix and failed (except the coverage test X-07 and the contract
pin noted), then passed after.

| ID | Sev | Platform | Defect | Reproduction | Fix | Regression test |
|---|---|---|---|---|---|---|
| X-01 | P2 | all (Node service = what the desktop uses) | Stop and timeout ended only the agent's own process. `execFile`'s `timeout`/`signal` signal one process, and `execFile` silently **drops** the `detached` option, so workers an agent started kept running after "Stop"; with a surviving worker holding the output pipe, a **timeout never returned**. | A stand-in `opencode` that forks `sleep 300`; `runAgent(...)` then abort: grandchild alive after cancel (probe printed `grandchildAliveAfterCancel: true`). | `packages/ai-service/src/exec/process.ts`: `spawn` with `detached` on POSIX, reproduces `execFile`'s result shape (exit code, `killed`, `signal`, abort, max buffer, ENOENT), SIGTERM then SIGKILL to the process group, `taskkill /F /T` on Windows (not natively verified). | `exec/processTree.test.ts` (3; 2 failed before). `fabric/terminalInstallGuard.test.ts` spy extended to `spawn` — otherwise its four "an install never spawns" assertions would have passed vacuously. |
| X-02 | P3 | Windows | Installer executor's timeout/error path called only `proc.kill()` on Windows; npm → node → postinstall children kept running after "timeout". The two sibling helpers already used `taskkill /F /T`. | Simulated platform: no `taskkill` call issued. | `backend/aura/environment/executor.py` `_terminate_tree`. | `tests/unit/test_install_executor_windows_tree_kill.py` (3; 1 failed before). Linux simulation. |
| X-03 | P3 | POSIX | `StdioMcpClient.close()` terminated only the server process; a launcher (`npx`, `uvx`, a shell wrapper) exits on stdin EOF while its worker keeps running. | Stand-in server that forks `sleep 300`; after `close()` the worker is alive. | `backend/aura/central_agent/mcp_transport.py`: sweep the server's session/process group after the graceful path. | `tests/unit/test_mcp_transport_tree_cleanup.py` (1; failed before). |
| X-04 | P2 | **Windows only** | The Windows shell asks the Node service to shut down by `POST /shutdown` with only `x-aura-shutdown`. Since the loop-3 ownership guard every route except `/health` and `/instance/proof` needs `x-aura-instance-token`, and the guard runs **before** the route, so the request is refused (401) and every Windows quit waits 5 s and then hard-terminates the service (no graceful close/state flush). Linux uses SIGTERM and never sees this. Found by tracing code, **not observed on Windows**. | On Linux: `decide('POST','/shutdown',{'x-aura-shutdown':'1'},token,null)` returns `refused 401`. | `apps/desktop/src-tauri/src/service.rs`: platform-independent `post_request(port, path, token)` adds the token header; `http_post`/`request_graceful_shutdown` pass the handle's token. | Rust `shutdown_request_tests` (2, run on Linux); `instanceGuard.test.ts` contract case (refuses header-only, accepts with token). **The Linux binary does not contain this code (compiled out); it is unverifiable until a Windows build is run.** |
| X-05 | P3 | Windows | The Python backend has **no** `/shutdown` route, so on Windows it is always hard-terminated after the 5 s wait. | Code trace: `grep shutdown backend/aura/api/*.py` shows no route. | **Not fixed** (out of the safe scope of this loop; needs a route behind the same guard). | — |
| X-06 | info | Linux distros | Minimum glibc was undocumented. Measured: the main binary's hard floor is **2.34** (its `GLIBC_2.39` references, `pidfd_spawnp`/`pidfd_getpid`, are flagged WEAK), bundled Node 2.28, bundled Python wheels ≤ 2.34. So Ubuntu 22.04+/Debian 12+ are statically loadable; Debian 11 and Ubuntu 20.04 are not. | `node scripts/glibc-floor-verify.mjs <binary> <resources>`; negative control with `--max 2.30` fails. | New guard script `scripts/glibc-floor-verify.mjs` (static analysis; not wired into CI). | The script itself (PASS on 46 ELF files; negative control FAIL). |
| X-07 | — | all | No test ran the real tools in a project path with spaces, `#`, `%`, `&`, and non-ASCII text. | — | none needed (no defect) | `tests/unit/test_hostile_project_paths.py` (4). Coverage addition; passed first time. |

Checked and found **not** defective: `localhost`/IPv6 (every production default uses `127.0.0.1`; the one `localhost` in the registry is a
docstring); SQLite read-only URI (`Path.as_uri()`, verified with `#`, `%`, `?`, spaces, non-ASCII); `fcntl` and `os.getuid()` (both guarded
for Windows); `exec_/` and `environment/procexec.py` (Windows-aware); app-data directory (`AURA_HOME` or `~/.aura` on every OS);
Rust fixed `/usr/...` paths (all inside `cfg(unix)` fallbacks).

## 4. Findings still open

| ID | Sev | Item |
|---|---|---|
| F-33 | P3 env | Ollama system service restart-loops (2064 restarts). See section 6. Owner action; nothing changed. |
| X-05 | P3 | Python backend has no graceful-shutdown route on Windows. |
| X-08 | P3 docs | `docs/INSTALL.md` states no minimum glibc, WebKitGTK 4.1 / libsoup 3 requirement, or that Debian 11 / Ubuntu 20.04 are unsupported. Not edited (documentation decision); numbers above can be used. |
| X-09 | info | CI runs the backend suite on Linux only; Windows/macOS legs run the packaging runtime check but not pytest. X-02/X-04-style defects are invisible to CI. |
| F-08/F-24 | P2 | GUI coverage for failed/unconfirmed cancel, retry-wait, workflow Stop and automation Stop is not automated. |
| F-09 | — | Signing BLOCKED (no key). |
| F-16 | — | Windows and macOS never executed. |
| Unconfirmed | — | One orphaned `aura-hub` that ignored SIGTERM after its AppImage runtime was signalled; not reproduced through the supported quit path (see `packaged-acceptance-and-gui.txt`). |

## 5. Ubuntu / Debian

- Runtime: **BLOCKED.** Docker is installed but its daemon is not running (starting it is a system change needing root); `systemd-nspawn`
  needs root; no `debootstrap`.
- Static: `scripts/glibc-floor-verify.mjs` on the release binary and bundled runtimes: 46 ELF files, none above glibc 2.34.
- The `.deb` declares `nodejs`; the AppImage does not (documented). `libwebkit2gtk-4.1` and `libsoup-3.0` are required by the binary
  (`readelf -d`); present on Ubuntu 22.04+/Debian 12+ by default, not checked here.
- CI builds the shipped Linux artifact on `ubuntu-latest` and installs the `.deb` there (`apt-get install ./*.deb`) — this is the only
  Ubuntu execution path in the repository, and it was **not run** for this tree.

## 6. F-33 — Ollama service (read-only diagnosis; nothing changed)

- Effective unit: `/etc/systemd/system/ollama.service` (admin-made, no drop-ins; shadows the package unit).
  `ExecStart=/usr/local/bin/ollama serve` — that path does not exist. The binary is `/usr/bin/ollama` (package `ollama 0.40.10-1`).
  Status: `activating (auto-restart)`, `ExecMainStatus=203/EXEC`, 2061–2064 restarts and counting.
- The unit runs as `ollama` (uid 957, shell `/bin/false`). The models (qwen3.5:2b, nomic-embed-text, 2.8 GB) are in `/mnt/storage/.ollama`
  owned by `Groot:Groot`. A service as `ollama` would see an empty store (`/var/lib/ollama`) — fixing only `ExecStart` would serve no models.
- Network: no `OLLAMA_HOST` anywhere, so the default `127.0.0.1:11434` applies; the user-run server (pid 132494) listens on loopback only.
- Hardening gaps in the current unit: `PATH` lists `/home/Groot/...` directories for a daemon account; `Restart=always` with no start limit;
  `WantedBy=default.target` on a system unit; no sandboxing options.
- **Recommended (needs your authorization; not executed):** option A — run Ollama as the user who owns the models, as a *user* service, no
  root for the service itself: `docs/audit/evidence/cross-platform/ollama-option-A-user-service.service` (install to
  `~/.config/systemd/user/ollama.service`, then `systemctl --user daemon-reload && systemctl --user enable --now ollama`), after
  `sudo systemctl disable --now ollama` stops the restart loop (**the one root command**). Option B (system service as `Groot`, loopback,
  hardened) is in `ollama-option-B-system-service.service`. No symlink `/usr/local/bin/ollama` was created: it would start a model-less
  server and hide the mismatch.
- A user-owned Ollama (pid 132494, started 20:11) is running; it is not mine and was not touched.

## 7. Cancellation

See `packaged-acceptance-and-gui.txt` (GUI) and the test counts in `VALIDATION_REPORT.md` Run 11.
Verified by execution: Stop during a running chat answer (state "Stopping..." then "Stopped" only after the agent confirmed), repeated Stop,
and a completed run (no Stop offered); process-tree termination on abort and on timeout (Node runner, MCP client); automation and workflow
state machines (F-29 tests: first terminal state wins, cancel-vs-failure, cancel-vs-completion, repeated cancel).
Remaining behaviour, stated exactly: a Stop does **not** interrupt an action already running inside the automation engine (it sets an abort flag
that actions may not honour; the run record says cancelled while that action finishes); the Python backend has no graceful-shutdown route on
Windows (X-05).

## 8. Signing and artifact provenance

`TAURI_SIGNING_PRIVATE_KEY` is not set (0 `TAURI_SIGNING*` variables); no key was created, requested or bypassed. The build exits 1 at
updater signing, so the AppImage/.deb exist but no `.sig`. `scripts/stage-release-artifacts.mjs` (guard 2) refuses to stage an updater
artifact without a signature, so this local build cannot be promoted into a release by that pipeline. The artifact record
(`artifact-final.txt`) labels it **INTERNAL TEST, UNSIGNED**, with its SHA-256 and the commit it was built from (plus uncommitted changes).

## 9. Reproducible native validation (prepared, NOT run)

Windows x64 (PowerShell, from a clean clone of the commit under test):
```powershell
node -v; python --version; rustc --version
npm ci
npm run typecheck; npm run test:front; npm run test:service
python -m venv .venv; .\.venv\Scripts\pip install -e "backend[test]"; .\.venv\Scripts\python -m pytest backend/tests -q
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib      # includes shutdown_request_tests
npm run desktop:build            # needs TAURI_SIGNING_PRIVATE_KEY to finish; unsigned build otherwise exits 1 at signing
node scripts/desktop-runtime-verify.mjs
```
macOS (Terminal): the same on arm64 and on Intel, plus `xattr -dr com.apple.quarantine "AURA Hub.app"` before the first launch.
Targeted manual checks that only a native host can answer: (1) quit AURA and confirm the Node service closes without waiting 5 s (X-04);
(2) cancel an install and confirm no `node.exe` child survives (X-02); (3) start an agent that forks a worker, press Stop, confirm the worker
is gone (X-01); (4) a project under `C:\Users\José Müller\My Projects` and one on a UNC share.
CI (needs a push and your authorization): `gh workflow run ci.yml --ref <branch>` runs the four native packaging legs. Note the CI job
`desktop-build` does not run pytest on Windows/macOS.

---

## Update — loop 6 (2026-10-28): status changes to the matrix above

Source and artifact: see `VALIDATION_REPORT.md` Run 12 (artifact `c1796be7…`). Still executed on Arch Linux x86_64 only.

| Row | Linux | Windows | macOS |
|---|---|---|---|
| Install / build / package | PARTIAL (unchanged; docs now list verified requirements, `INSTALL.md`) | NOT RUN | NOT RUN |
| Backend / service startup | **PASS** + graceful shutdown route verified in the packaged backend (234 ms, exit 0) | NOT RUN. The route X-05 exists now; the Windows request path is unit-pinned, not executed. | NOT RUN |
| Cancellation and cleanup | **PARTIAL → clearer**: cancellation phase (requested/acknowledged/winding-down/complete) implemented and unit-tested in both engines and the UI; GUI re-run on this artifact NOT RUN | NOT RUN | NOT RUN |
| All other rows | unchanged | unchanged | unchanged |

| ID | Status now |
|---|---|
| X-05 | **FIXED on Linux-verified code** (token-guarded `POST /shutdown`; 7 tests incl. real process and packaged check). Windows path unverified. |
| X-08 | **DONE** (INSTALL.md corrected; one stale claim removed). |
| X-09 | **PREPARED, NOT RUN** (three-OS backend matrix in `ci.yml`; needs a push to execute). |
| F-24/F-08 | cancellation phase implemented; automation Stop now says "winding down" truthfully; GUI states not re-driven. |
| X-01, X-02, X-04 | reviewed, extra tests added; Windows execution still NOT RUN. |
| F-33 | **OPEN**, owner action: `evidence/loop6/ollama-recommendation.txt`; note the running user server holds port 11434. |

How the prepared CI validates the Windows/macOS items after authorization: the `backend` matrix runs the full pytest suite natively (platform and toolchain recorded in the job summary, skips listed with reasons, junit kept), and the `desktop-build` legs run `cargo`-built shell plus `desktop-runtime-verify.mjs`. Rust unit tests (`shutdown_request_tests`) are not in the CI matrix yet — adding `cargo test --lib` to `desktop-build` is the next small step.
