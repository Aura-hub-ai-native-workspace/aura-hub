# AURA — Execution Progress Log

Tracks progress against the **AURA Master Execution Roadmap** (5 phases,
set by the owner 2026-11-25). The roadmap itself is not edited here; any
proposed change is listed under *Recommended changes* and only moves to
*Approved changes* after explicit owner approval.

Status legend: **DONE** (evidence attached) · **IN PROGRESS** · **BLOCKED** · **NOT STARTED**

---

## Current phase: Phase 1 — Stabilize AURA Hub

Phases 2–5: **NOT STARTED** (no evidence of work toward them yet; see audit below).

---

## Audit — 2026-11-25 (baseline)

### Repository and release baseline

| Item | Finding | Evidence |
|---|---|---|
| Branch / HEAD | `main` @ `7607725`, in sync with `origin/main` | `git rev-list HEAD..origin/main` = 0 |
| Latest release | v0.1.27 (2026-11-12) | `gh release view v0.1.27` |
| Release platforms | Linux x64 (AppImage, deb, tar.gz), macOS arm64 + x64 (dmg), Windows x64 (exe), all with updater `.sig` | release assets |
| CI on `main` | Green on last push (2026-11-21): typecheck + unit tests, backend pytest on linux/windows/macos, desktop packaging on 4 targets | `gh run list` run 44920655329 |
| Uncommitted work | **54 modified source files, +2,560 / −200** (central agent execution/service/MCP context, worker specialists, run observer, provider adapters) — not on any branch, not reviewed | `git diff --stat` |
| Untracked clutter | ~35 `VERIFIED_RELAY_*.md` design docs, ~60 scratch `.txt` outputs, report .docx/.pdf in repo root; `graphify-out/` has ~870k lines of regenerated churn | `git status` |
| Stashes | 8 stashes, oldest from 2026-08 | `git stash list` |
| Open PRs | #104 Demon Route provider (fork, CI green, awaiting review); #67 v0.1.21 fixes (stale since 2026-10-11); #62 website sizes (stale since 2026-09-22) | `gh pr list` |
| Open issues | None | `gh issue list` |

### Local verification of the working tree (2026-11-25)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run test:front` | PASS — 65 files, 559 tests |
| `npm run test:service` | PASS — 37 files, 436 tests |
| `npm run test:agents` | PASS — 19 tests |
| Backend `pytest backend/tests` | PASS — 3,945 passed, 95 skipped, 0 failed (12m 37s, Linux) |

### Evidence relevant to later phases

| Phase | Finding |
|---|---|
| 2 | No funding or GPU-allocation evidence in the repository. `partnership/alibaba-cloud/` holds drafted API-credit request materials only. Funding status is tracked privately by the owner. |
| 3 | No vLLM / llama.cpp / inference-gateway code or deployment config in the repo. Docker compose exists for backend + AI service only. |
| 4 | Website early-access form (`website/index.html:723`, handler `:843`) only opens a `mailto:` link — **no emails are collected**. Confirms the roadmap task. |
| 5 | Common Context MCP is in active use by agents; no integration work planned yet. |

---

## 2026-11-25 — Change set preserved, committed, PR opened

**Preservation (before any Git operation; nothing discarded, reset, cleaned or stashed):**
- Snapshot commit `daafbf4` at local ref `refs/snapshots/2026-11-25-pre-branch` (all tracked + 659 untracked files; not pushed).
- On disk, in a local snapshot directory outside the repository: `tracked.diff`, `worktree-changes.tar.gz` (719 files, count verified), `snapshot.bundle` (`git bundle verify` okay), file lists, `SHA256SUMS`.

**Branch `feat/phase1-agent-session-stabilization` → draft PR #106**, 7 commits:

| Commit | Group |
|---|---|
| `cddf29a` | uv.lock records declared `cryptography` dependency |
| `5f26220` | Provider: streamed token usage; keep model on reconnect |
| `d58152a` | Central agent: MCP context servers + shared run context |
| `bef8125` | OpenCode/Kilo Common Context readiness gate (**security review open, #107**) |
| `4715fed` | Agent status: MCP configured vs verified |
| `a216988` | Central agent: per-task denials, alternative recovery, specialists, billing class |
| `89892d1` | Workspace UI: specialists roster + recovery actions |

Evidence: every commit passes backend import + `npm run typecheck`; branch tip is byte-identical to the snapshot for `apps/ backend/ packages/ scripts/`, which passed all local suites. CI on PR #106: _running_.

**Deliberately not committed:** regenerated `graphify-out/`, `VERIFIED_RELAY_*.md`, scratch outputs, DPR report scripts, promo assets, this log and the alpha checklist (proposed for a separate docs PR).

**Issues filed:** #107 — Verified Relay Round 3.1 items C1–C8 (blocks #106 and alpha item E1).

**Alpha checklist:** drafted at `docs/ALPHA_ACCEPTANCE_CHECKLIST.md`, awaiting owner approval.

## 2026-11-25 — Owner decisions; cross-OS CI found a Windows regression; merge gate enforced

**Owner decisions (approved):** (1) alpha checklist accepted — six sections, evidence-based statuses, untested stays untested, security failures block alpha; (2) Linux/Windows/macOS backend tests and installer builds required on `main`, plus Typecheck & Build; (3) separate docs-only PR for this log and the checklist. PR #106 stays draft and unmerged; `bef8125` is not security-approved; #107 blocks.

**Cross-OS CI caught a real regression in PR #106.** Run `45637055087`, job "Desktop packaging (windows-x64)", step Unit tests: `agentsSetup.test.ts` 2 failed — `aura-agents setup` exited 1 on Windows only.
- Cause: the new context-server probe `verifyMcp()` spawned the npm `.cmd` shim without a shell; Node throws synchronously for that on Windows, and the throw escaped `setup()`. Real Windows installs would have crashed the same way.
- Fix: commit `fe72298` (shell for `.cmd`/`.bat` like the rest of the file; a probe that cannot start is reported unverified, not thrown). Regression test fails before the fix (`ERR_INVALID_ARG_VALUE`) and passes after; agents 20/20, service 436/436, typecheck OK on Linux. Windows confirmation: CI run `45638369911`.

**Merge gate on `main` (verified, not assumed):** required checks changed from 1 to 8 — Typecheck & Build; Backend tests linux-x64 / windows-x64 / macos-arm64; Desktop packaging linux-x64 / windows-x64 / macos-arm64 / macos-x64 — pinned to GitHub Actions (app 15368), strict (branch must be up to date). Evidence: protection API read-back lists 8; `gh pr checks 106 --required` lists all 8; PR #106 merge state `BLOCKED`.

Limitations reported, not changed: `enforce_admins` is off (admins can bypass); required names are tied to the matrix labels in `ci.yml` (renaming one blocks every PR until protection is updated); Docker compose smoke is not required.

**Docs-only PR:** #108 (this log + approved checklist). Funding details kept out of the public repository at the owner's choice.

## 2026-11-25 — Linux Workspace acceptance run (checklist §C)

**Setup:** PR #106 at `fe72298`. The Python API the Workspace calls, on a private port with a throwaway home, project and instance token, driven over HTTP. No model configured (deterministic mode). `PATH` stripped so the real OpenCode/Kilo binaries and the owner's credentials were unreachable. Delegation used a **fake** `claude` worker that passed AURA's readiness proof (reported as "connected for basic work"). Afterwards: no test API, containers or processes left (`ss`, `docker ps`, `ps`).

| Item | Result |
|---|---|
| C1 read-only | **PASS** — 5 requests, real output, verified, ~1 s each |
| C2 edit | **PARTIAL** — file creation PASS; code change without an agent refused, worded as "Policy denied" |
| C3 delegation | **PARTIAL** — PASS with a fake worker; real OpenCode/Kilo not run (#107); `contextMcp` not surfaced in report/audit |
| C4 per-task denial | **NOT VERIFIED** — deterministic planner never produced a mixed plan |
| C5 recovery | **PASS** for "no alternative" (auth failure, honest failure); alternative case NOT RUN |
| C6 STOP | **PASS** — cancelled in 669 ms; container and grandchild gone |
| C7 crash audit | **FAIL** — **#109**: in-flight invocation leaves no audit record after `kill -9` |
| C8 restart state | **FAIL** — **#110**: auto-resumed run shown as "interrupted" while its worker runs |

**Issues filed (freshly reproduced, with evidence):** #109, #110.

**Observed, not filed** (not critical, or not independently reproduced): "no agent connected" worded as policy denial; deterministic planner silently drops or merges parts of multi-part requests (the objective check still reports failure honestly); `contextMcp` not surfaced; "git diff" says "no uncommitted changes" when only untracked files exist; a cancelled invocation is audited as `failed`; `lastResult.tasks` empty on a failed delegation; after a crash, the sandbox container keeps running until the next sandboxed task (cleanup is lazy).

## 2026-11-25 — PR #106 CI, second Windows failure

Run `45638369911` on `fe72298`: the Windows service suite now passes (390 passed, 32 skipped), confirming the `.cmd` fix. The next step, `test:agents`, failed on one test whose fake MCP servers were shebang scripts that Windows cannot execute (`spawn … ENOENT`) — a test portability bug, not a product bug. Fixed in `e6c6cd4` (fixtures launched via `node`); 20/20 locally. CI re-run `45640855107`: _running_.

**macOS backend tests (first run `45637055087`): 11 failed / 3858 passed**, all in the Verified Relay gate tests. Cause: the test helper defaults to the Linux `/proc` identity method, and 11 adversarial scenarios lack the Linux-only marker. The product uses `lsof` on macOS, and its 3 `lsof` scenarios passed (91 of 109 gate tests passed on macOS). Not changed in #106: making them Linux-only would hide that the macOS security path has only 3 adversarial scenarios. Recorded on #107 as part of C8 (parametrise over both methods). **Consequence:** the macOS backend check on #106 stays red until the #107 remediation, consistent with "do not merge".

---

## Phase 1 task status

| Task | Status | Notes |
|---|---|---|
| Establish repository and release baseline | **IN PROGRESS** | Change set preserved and in PR #106. Cross-OS merge gate enforced on `main` (8 required checks). Remaining: stale PRs #67/#62, root clutter, old stashes, `enforce_admins` decision. |
| Close critical Workspace execution bugs | **IN PROGRESS** | Linux acceptance run done. Open critical bugs: #107 (security), #109 (crash audit gap), #110 (resumed run state). None fixed yet. |
| Complete priority agent-session and coordination gaps | **IN PROGRESS** | PR #106 (draft) — 2 Windows CI failures fixed (`fe72298`, `e6c6cd4`); awaiting green cross-OS CI, independent review, #107. |
| Validate Windows, Linux and macOS | **PARTIAL** | CI builds and backend tests pass on all three. Process containment NOT VERIFIED on Windows/macOS. No hands-on install run recorded. |
| Define verified alpha acceptance checklist | **DONE** | `docs/ALPHA_ACCEPTANCE_CHECKLIST.md` approved by the owner 2026-11-25. |

## Phase 2 funding status

Tracked privately by the owner (not in this public repository). No GPU allocation or 24/7 server is secured; budget ₹0; Phase 2 implementation not started.

## In progress
- PR #106 cross-OS CI run `45640855107` (`e6c6cd4`).
- Docs PR #108 CI.

## Blockers and dependencies
- PR #106 merge: cross-OS CI + independent review + #107.
- Windows/macOS hands-on validation needs real machines or a human tester.
- Phase 2 credit checks need the owner's account access.

## Next concrete action
Owner decides the fix order for #109 and #110 (and whether #107 remediation starts now); confirm PR #106 cross-OS CI is green.

## Recommended changes to the roadmap (awaiting approval)
- None.

## Approved changes to the roadmap
- None. (The 2026-11-25 decisions are execution decisions within Phase 1, not roadmap changes.)
