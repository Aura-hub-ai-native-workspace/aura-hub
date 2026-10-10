# AURA Hub v0.1.20 — Cross-Platform Release Report

**Version under test:** 0.1.20 (bumped from 0.1.19)
**Branch:** `feature/workspace-v2-aura-execution-ui` @ `15bdeba`
**Verification host:** Arch Linux, kernel `6.18.55-1-lts`, x86_64
**Toolchain:** Node v22.23.2 · npm 10.9.8 · Python 3.12.7 · cargo/rustc 1.99.0 · X11 (`DISPLAY=:0`) + `xvfb-run`
**Report date:** 2026-10-08

---

## 1. What this report is

AURA Hub ships as **one shared core plus per-OS adapters**. This report covers the
work between v0.1.19 and v0.1.20: the cross-platform inspection, the fixes that
were actually necessary, and an honest account of what was verified, on what
machine, and to what depth.

Two rules govern every claim below.

- **A build is not a run.** Compiling an artifact is reported as *build verified*.
  Booting it, exercising its service, and closing it is reported as *runtime verified*.
- **A claim verified on Linux says nothing about Windows or macOS.** Those platforms
  are produced and executed only by their own native runners. Where that is the only
  honest source, this report says **NOT VERIFIED — ENVIRONMENT LIMITATION** rather
  than inferring a pass.

Verification levels used throughout:

| Level | Meaning |
|---|---|
| **VERIFIED** | Executed on this host, with the command and exit status shown. |
| **BUILD VERIFIED** | Compiles/packages successfully; the artifact was **not** executed. |
| **RUNTIME VERIFIED** | The packaged artifact was actually executed and exercised. |
| **NOT VERIFIED — ENVIRONMENT LIMITATION** | Cannot be produced or executed on a Linux host. Native CI runners are the only honest source. |
| **NOT VERIFIED — PRODUCT LIMITATION** | Deliberately absent or unresolved in this release. |

---

## 2. Release-gate verdict

> **PASSED on this host**, after two blocking defects were found and resolved
> (§6.1, §6.3). The version bump to **0.1.20** is applied to all six canonical
> version sources.
>
> Publishing is a separate decision and has **not** been performed: no commit, tag,
> or push was made. The `v*` tag remains the only thing that publishes, and the
> cross-platform artifacts still have to be produced and run by the native CI
> runners before that tag can honestly produce a release.

Three of the four platform legs **cannot** be attested by this host — see §5.2.

---

## 3. Changes in v0.1.20

### 3.1 Necessary cross-platform fixes

| File | Change | Why it was necessary |
|---|---|---|
| `backend/aura/agent_runtime/adapters/claude_code.py` | Replaced the module constant `_BINARY_CANDIDATES = ["/usr/bin/claude", "/usr/local/bin/claude", ~/.local/bin/claude]` with a platform-aware `_binary_candidates()`. Windows → `~/.local/bin/claude.exe`; macOS → `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.local/bin/claude`; Linux → `/usr/bin/claude`, `/usr/local/bin/claude`, `~/.local/bin/claude`. | The list was a hard-coded POSIX assumption evaluated on every platform, so a Windows installation outside `PATH` was never found. `shutil.which("claude")` is still tried first. |
| `backend/tests/unit/test_agent_runtime.py` | Monkeypatch target `_BINARY_CANDIDATES` → `_binary_candidates` (value `lambda: []`). | Follows the implementation change; assertion strength is unchanged. |
| `backend/aura/capabilities/tools.py` | `"shell"` description: `"Command execution boundary (POSIX sh)."` → `"Command execution boundary (allow-listed argv, no shell)."` | The description asserted a POSIX dependency that does not exist. `parse_command()` is allow-list + argv, rejects shell operators, and `safe_shell_with_code` calls `run_file([...])` — no shell is ever introduced, on any platform. |

Deliberately **not** changed after inspection (platform-specific by design, not by
accident): the distro→package-manager maps in `install.py`; the Windows
`cmd.exe`/`ComSpec`/`%APPDATA%\npm` shim handling in `procexec.py`; the OS-gated
inventory sources in `environment/inventory/sources.py`; the per-tool
`cross_platform` catalogue flag; the adapter advisory files. No `/home/...`,
`C:\...`, or `/Users/...` path was introduced or left as a universal assumption in
the code paths changed here.

### 3.2 Release-integrity fixes

| File | Change |
|---|---|
| `package-lock.json` | Reconciled the root-project version `0.1.18` → `0.1.19` (pre-existing drift; see §6.1). |
| `scripts/bump-version.mjs` | `package-lock.json` is now read **and** written across **every** `"name": "aura-hub"` entry, not just the first; two copies that disagree are surfaced as drift instead of being half-corrected (see §6.2). |
| `scripts/release-verify.mjs` | The bump fixture now models the **real** lockfile shape (root entry **and** `packages[""]`), and a new check `7a2` asserts that **both** entries move. |

### 3.3 Release-gate correction

| File | Change |
|---|---|
| `scripts/desktop-runtime-verify.mjs` | Section 4 restated against the **autonomous-delegation contract** (see §6.3): `4a` now asserts the floor on `git.push` (a high-risk, irreversible capability with no exemption); `4a2` asserts the contract's YES branch (`agent.delegate` → `rule=autonomous-delegation`, executed); `4a3` asserts the NO branch (with autonomy off, `agent.delegate` → `irreversible-floor`, `attempts=0`). Check count went **29 → 31**. |

### 3.4 Version bump

`node scripts/bump-version.mjs 0.1.20` moved all six canonical sources in one step:
`package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`,
`apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock`,
`package-lock.json`. `--check` confirms **all six agree on 0.1.20**.

The internal `packages/*` workspaces remain at `0.1.0` — they are independently
versioned internal packages and are deliberately outside the release version.

### 3.5 Documentation

- `CHANGELOG.md` — new `[0.1.20]` section recording the changes, the verified
  results, and the NOT VERIFIED items.
- `README.md` — new `Release Notes (v0.1.20)` section. The v0.1.19 release notes,
  artifact names, and release checklist were left intact: they are an accurate
  record of *that* release, and rewriting `AURA Hub_0.1.19_amd64.AppImage` to
  `0.1.20` would assert an artifact that does not exist.

### 3.6 Not touched

`apps/desktop/src-tauri/tauri.conf.json` carried a **pre-existing uncommitted
working-tree change** (NSIS `installMode: "currentUser"` + `languages: ["English"]`).
It was left exactly as found — the bump touched only the `version` field. Verified
by diff.

---

## 4. Verification performed on this host

### 4.1 Result summary

| # | Gate | Command | Result | Level |
|---|---|---|---|---|
| 1 | TypeScript typecheck | `npm run typecheck` | **PASS** (exit 0) | VERIFIED |
| 2 | Frontend tests | `npm run test:front` | **550 passed / 39 files** (exit 0) | VERIFIED |
| 3 | Service tests | `npm run test:service` | **130 passed / 14 files** (exit 0) | VERIFIED |
| 4 | Frontend production build | `npm run build --workspace @aura/desktop` | **PASS**, built in 1m21s | BUILD VERIFIED |
| 5 | Backend suite (full) | `python -m pytest tests/ -o addopts= -rf` | **2181 passed, 66 skipped, 2 failed**, 985.85s | VERIFIED (§4.2) |
| 6 | Backend autonomy + policy parity | focused 4 files | **77 passed** (exit 0) | VERIFIED |
| 7 | Rust static check | `cargo check --all-targets` | **PASS**, 2m56s | VERIFIED |
| 8 | Rust release profile | `cargo build --release --bin aura-hub` | **PASS**, 3m55s | BUILD VERIFIED |
| 9 | Service bundle staging | `npm run service:bundle` | **PASS** (178 backend files, node + CPython runtimes staged) | VERIFIED |
| 10 | **Desktop runtime verification** | `xvfb-run -a node scripts/desktop-runtime-verify.mjs` | **31/31 PASS** (exit 0) | **RUNTIME VERIFIED** |
| 11 | Release pipeline verification | `node scripts/release-verify.mjs --dir <empty>` | **67/67 PASS** (exit 0) | VERIFIED |
| 12 | Version consistency | `node scripts/bump-version.mjs --check` | **all six agree on 0.1.20** | VERIFIED |

### 4.2 The two backend failures are environment flakiness, not regressions

Run: **2 failed, 2181 passed, 66 skipped, 5 warnings in 985.85s**. Both failures are
in `backend/tests/unit/test_network_allowlist.py::TestRealClients`:

- `test_19b_curl_allowed` — `curl` exit code **28** (operation timeout) after 25.1 s.
- `test_22_python_urllib_denied_allowed_pair` — `urllib` **`TimeoutError: The read operation timed out`** after 36.3 s.

Both reach a **remote allowed host** through the local sandbox proxy
(`127.0.0.1:3128`) and depend on that host answering in time.

Re-run in isolation:

```
$ python -m pytest <the two tests> -o addopts=
2 passed in 1.87s
```

Corroborating evidence that this is environmental: the **same** file produced a
**different** failure set on the previous full run (4 failures, HTTP 403 Forbidden),
and 2 on this run (timeouts). A varying failure set across runs of unchanged code is
the signature of a remote dependency, not a defect. Every other one of the 2249
collected tests behaves consistently. **No genuine regression was found in the
backend suite.**

### 4.3 Desktop runtime verification — the strongest evidence here

`scripts/desktop-runtime-verify.mjs` is run by CI on **all four** platform legs. On
this host it was executed under `xvfb-run` exactly as CI does, against a freshly
staged service bundle built from current source, and it is **31/31 PASS**:

- **Packaged service bundle** — staged Node service and its TypeScript runtime dependency present.
- **Node runtime resolution** — resident interpreter is `node`, ≥ 18.
- **Service lifecycle** — packaged service starts, answers `/health` with real
  provider/index state (not a stub), reports AURA identity (34 capabilities).
- **Connected Environment, real detection** — 28 of 62 probed on this machine, with
  genuine versions (`node 22.23.2`, `git 2.56.0`, `claude-code 2.1.152`, …);
  absent tools reported absent (34) with no contradictory version claims.
- **Governed stack** — see §4.4.
- **Port 4319** — a second service refuses the occupied port (`EADDRINUSE`) instead of displacing the first.
- **Shutdown** — `SIGTERM` delivered, port released, process genuinely gone, no orphan.
- **Relaunch** — service returns healthy with correct identity.
- **User state** — state written under `AURA_HOME`, nothing written into the repository.
- **Packaged shell launch** — the release binary starts, brings up **its own child**
  service, closes cleanly, and leaves no orphan.

This is a **RUNTIME VERIFIED** result for Linux x64 — the packaged shell and service,
not merely a compile.

### 4.4 Governed stack, after the correction

```
PASS 4a.  a high-risk capability without an exemption never auto-executes
          — outcome=awaiting-approval attempts=0 rule=irreversible-floor
PASS 4a2. autonomous delegation auto-executes under the autonomous-delegation contract
          — outcome=failed attempts=1 rule=autonomous-delegation
PASS 4a3. with autonomy off, delegation returns to the normal approval path
          — outcome=awaiting-approval attempts=0 rule=irreversible-floor
PASS 4b.  an install attempt through terminal.execute never runs
          — outcome=awaiting-approval attempts=0 rule=risk-default:medium
```

`4a2` records the contract working exactly as specified: the policy does **not**
park the delegation behind an approval gate, so it executes (`attempts=1`) and then
fails **inside the executor** because no model provider is configured on this host.
That is the executor failing, not the policy refusing — the distinction is the whole
point of the check.

### 4.5 Cross-platform inspection results

| Area | Finding |
|---|---|
| Tauri bundle config | Base `tauri.conf.json` targets `appimage`, `deb`, `nsis`; per-OS overlays add `app`+`dmg` (macOS) and `nsis` (Windows). macOS DMG **is** configured, via overlay. |
| CI/CD | Native 4-runner matrix — `ubuntu-latest`, `windows-latest`, `macos-latest` (arm64), `macos-15-intel` (x64) — each builds **and runs** its own artifact; a separate `release` job runs only on `v*` tags and `needs: desktop-build`. `workflow_dispatch` exists, so the Windows/macOS legs can be run on demand. |
| Platform abstraction | `backend/aura/environment/hostplatform.py` is the single `Platform` abstraction (`current()`, `simulate()`, `is_*`), with a context-var `simulate()` that makes cross-OS branching deterministically testable. |
| Shell boundary | `backend/aura/exec_/__init__.py` parses an allow-list + argv, rejects shell operators, and never introduces a shell — inherently cross-platform. |
| TS production code | Platform branching confined to `process.platform` in `ai-service` (`exec/install.ts`, `exec/which.ts`, `mission/execution/nodes.ts`); no hard-coded POSIX paths. The renderer uses `@tauri-apps/plugin-os`. |
| Packaged path resolution | `src-tauri/src/lib.rs`/`service.rs` resolve packaged vs dev service/backend, strip Windows verbatim paths, and augment `PATH`. |

---

## 5. What is NOT verified

### 5.1 No bundled installer was produced on this host — ENVIRONMENT LIMITATION

No AppImage, `.deb`, `.app`, `.dmg`, or NSIS installer was generated here.

`tauri.conf.json` sets `bundle.createUpdaterArtifacts: true` with
`plugins.updater.pubkey` configured. In that state the Tauri CLI **refuses to build
without `TAURI_SIGNING_PRIVATE_KEY`** and verifies that the key matches the
configured public key. That key is a repository secret supplied to CI, and it is
absent on this host (`env` contains no `TAURI_*` variables).

Producing an artifact here would therefore require either no signature — an
artifact no installed copy could verify — or a mismatched throwaway key. Both would
be misleading as a release artifact, so neither was done. This is consistent with
the repository's own position: `release-verify.mjs` section 6 reports
*"This machine builds one platform; all four exist only on CI."*

### 5.2 Windows and macOS runtime — NOT VERIFIED (ENVIRONMENT LIMITATION)

**No Windows or macOS artifact was executed while preparing this release.** Their
runtime status is **pipeline ready**, not **runtime verified**. The only honest
source is the native runners:

```
gh workflow run ci.yml --ref feature/workspace-v2-aura-execution-ui
```

or a tagged build, which produces and runs all four legs. Their actual result is
**unknown from this host** and must not be reported as passing.

The macOS Intel leg (`macos-15-intel`) additionally has a finite life: the
workflow's own comment records that it is planned to be the last Intel image, after
which Intel coverage ends rather than silently pretending.

### 5.3 Signed installers — NOT VERIFIED (PRODUCT LIMITATION)

No signed installer is published. Existing v0.1.19 artifacts are unsigned, and
README says so. Whether this repository currently has `TAURI_SIGNING_PRIVATE_KEY`
configured as a CI secret cannot be determined from here; the pipeline is written
to require it and to fail rather than produce an unsigned updater bundle.

### 5.4 v0.1.20 artifacts do not exist yet — PRODUCT LIMITATION

The README's download and "Release Artifacts" sections still name the **v0.1.19**
AppImage and `.deb`. That is accurate: they are the newest published artifacts. The
new `Release Notes (v0.1.20)` section states this explicitly so the two are not
confused.

### 5.5 Autonomous delegation auto-executes by default — PRODUCT LIMITATION (by design)

Per the product contract, `agent.delegate` — `risk: high`, `irreversible: true` — is
the **one** capability exempt from the high-risk/irreversible floors:
`allowAutonomous: true` (the default) yields `rule: autonomous-delegation` and
auto-execution. This is a deliberate architectural decision, not an oversight
(§6.3). Every other high-risk capability is still floor-gated, as `4a` and `4b`
prove on this host.

---

## 6. Defects found and resolved

### 6.1 Pre-existing version drift blocked the release step — RESOLVED

`package-lock.json` sat at **0.1.18** while the other five version sources said
**0.1.19**. The repository's own tooling treats this as a defect:

```
$ node scripts/bump-version.mjs --check
  0.1.19     package.json
  0.1.19     apps/desktop/package.json
  0.1.19     apps/desktop/src-tauri/tauri.conf.json
  0.1.19     apps/desktop/src-tauri/Cargo.toml
  0.1.19     apps/desktop/src-tauri/Cargo.lock
  0.1.18     package-lock.json
bump-version: these sources disagree (0.1.19, 0.1.18).
  That drift is a bug in its own right, and bumping would erase the evidence of it.
```

`git log` shows the lockfile was last touched at the v0.1.18 release, so the v0.1.19
release moved the other five by hand and missed it. **Reconciled to 0.1.19**, then
bumped to 0.1.20 with the canonical tool.

### 6.2 `bump-version.mjs` moved only one of two lockfile entries — RESOLVED

npm writes the root project into a lockfile **twice** — at the top level and again as
`packages[""]` — and reads the nested copy as authoritative. The script's
`package-lock.json` writer used a non-global `String.replace`, so only the first copy
moved.

Demonstrated deterministically against the **pre-fix** script (`git show HEAD:...`)
on a realistic two-entry lockfile:

```
{ "name": "aura-hub", "version": "0.1.2",      ← moved
  "packages": { "": { "name": "aura-hub",
                      "version": "0.1.1" } } } ← left behind
```

Fixed to write **every** occurrence, and to report two disagreeing copies as drift
rather than half-correcting them. `release-verify.mjs`'s fixture previously modelled
only `packages[""]`, which is exactly why the bug survived; the fixture now models the
real shape and a new check `7a2` asserts both entries move together.

### 6.3 A committed policy change broke the release gate on all four platforms — RESOLVED per the product contract

**This is the most consequential finding of the release.**

`scripts/desktop-runtime-verify.mjs` check `4a` — *"a high-risk capability never
auto-executes"* — was added **2026-08-12** and runs on **all four** CI legs of the
`desktop-build` job, which the `release` job depends on.

Commit **`d75ce25`** — *"feat(policy): autonomous delegation for agent.delegate"* —
added an **early return** at `backend/aura/policy/engine.py:196`, placed *after* the
permission check and *before* the high-risk floors:

```python
if cap.id == "agent.delegate" and cfg.get("allowAutonomous", True):
    return {"decision": "auto-execute", "rule": "autonomous-delegation", ...}
```

Because `allowAutonomous` defaults to `True`, `agent.delegate` — `risk: high`,
`irreversible: true` — auto-executed **out of the box**, bypassing the
`irreversible-floor`. The runtime verifier caught it:

```
FAIL 4a. a high-risk capability never auto-executes
     — outcome=failed attempts=1 rule=autonomous-delegation
```

Had this shipped, **every** platform leg would have failed at runtime verification
and no `v0.1.20` tag could have published.

**Resolution.** The product owner confirmed that `allowAutonomous → AUTO-EXECUTE` is
an **intentional core AURA product contract**, and directed that it must be
preserved: no approval step may be introduced merely because a capability is
high-risk, the autonomous-delegation rule must take precedence over the normal
risk-default behaviour while still respecting the permission/authority boundary, and
the Python and TypeScript policy engines must stay identical.

Accordingly:

- **No policy change was made.** `backend/aura/policy/engine.py` and
  `packages/capability-fabric/src/policy.ts` are untouched; permission checks, audit,
  verification, and the `allowAutonomous=false` path are intact.
- The **gate** was restated to assert the contract instead of the rule the contract
  deliberately replaced. The old check asserted a now-false blanket property on the
  one capability that is exempt; the new checks assert the property where it still
  holds **and** assert the contract in both directions (`4a`, `4a2`, `4a3` in §4.4).
  Coverage went from 29 checks to **31** — this is a restatement with added coverage,
  not an assertion deleted to make a run go green.

Parity is intact: `tests/differential/test_differential_policy.py` passes, and the
focused autonomy/parity set is **77 passed**.

---

## 7. Open items and follow-ups

1. **Native-runner verification is still required.** Run
   `gh workflow run ci.yml` (or tag `v0.1.20`) to produce and execute the Windows
   and macOS artifacts. Until then, those platforms remain NOT VERIFIED.
2. **Stale developer-only verifiers still encode the pre-contract expectation.**
   `scripts/agent-delegate-verify.mjs`, `scripts/packaging-verify.mjs`,
   `scripts/install-ux-verify.mjs`, and `scripts/node-policy-verify.mjs` each assert
   `agent.delegate` → `awaiting-approval` / `irreversible-floor`. None is wired into
   CI or into any test, and `agent-delegate-verify.mjs` additionally hard-codes paths
   from another machine (`/tmp/claude-1000/...`, `/home/Groot/aura-hub`), so it cannot
   run here at all. They were **not** modified — rewriting scripts that cannot be
   executed would be unverifiable — but they will misreport if run.
3. **`dist-release/` holds stale unsigned v0.1.0 artifacts** (dated 2026-08-12,
   gitignored). `release-verify.mjs` section 6 finds them, and `6a` fails because
   they are unsigned. Run against an empty directory it is 67/67 PASS. This is local
   build residue, not a code defect; clearing it is safe but was not done
   unprompted.
4. **The frontend test run collects a duplicate set** from the nested
   `.claude/worktrees/pr63-pr64` git worktree (`39` files / `550` tests, roughly half
   of them duplicates). Harmless, but the worktree should be removed or excluded so
   the count means what it says.
5. **README's v0.1.19 checklist** remains a v0.1.19 record and is left as such; a
   fresh checklist should be written when the v0.1.20 artifacts actually exist.

---

## 8. Reproduction

```bash
# Static gates
npm run typecheck
npm run test:front && npm run test:service
npm run build --workspace @aura/desktop

# Backend (2 network-dependent failures are transient; the count needs -o addopts=)
cd backend && python -m pytest tests/ -o addopts= --tb=line -rf

# Rust
cd apps/desktop/src-tauri && cargo check --all-targets && cargo build --release --bin aura-hub

# Runtime verification (Linux) — the strongest local evidence
npm run service:bundle
xvfb-run -a node scripts/desktop-runtime-verify.mjs      # 31/31 PASS

# Release pipeline invariants (point --dir at an empty dir on a clean checkout)
node scripts/release-verify.mjs --dir /tmp/empty

# Version consistency
node scripts/bump-version.mjs --check                    # all six agree on 0.1.20

# Cross-platform runtime verification — NOT possible on this host
gh workflow run ci.yml
```

---

## 9. Verification matrix

| Platform | Artifact | Build | Runtime | Source of truth |
|---|---|---|---|---|
| Linux x64 | binary + staged service | **BUILD VERIFIED** (cargo release, 3m55s) | **RUNTIME VERIFIED** (31/31, xvfb) | this host |
| Linux x64 | AppImage / `.deb` | NOT VERIFIED — ENVIRONMENT LIMITATION (no signing key) | NOT VERIFIED — ENVIRONMENT LIMITATION | CI `ubuntu-latest` |
| Windows x64 | NSIS | NOT VERIFIED — ENVIRONMENT LIMITATION | NOT VERIFIED — ENVIRONMENT LIMITATION | CI `windows-latest` |
| macOS arm64 | `.app` / `.dmg` | NOT VERIFIED — ENVIRONMENT LIMITATION | NOT VERIFIED — ENVIRONMENT LIMITATION | CI `macos-latest` |
| macOS x64 | `.app` / `.dmg` | NOT VERIFIED — ENVIRONMENT LIMITATION | NOT VERIFIED — ENVIRONMENT LIMITATION | CI `macos-15-intel` |

**Bottom line.** On this host the shared core is **runtime verified on Linux**, the
full static gate set passes with no genuine regressions, and two release-blocking
defects (version drift and a policy change that broke the runtime gate on every
platform) are resolved. Windows and macOS remain **unverified by design of this
host** — their status is *pipeline ready*, and only a native CI run can change that.
