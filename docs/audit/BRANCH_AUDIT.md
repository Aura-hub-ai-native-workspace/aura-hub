# AURA Hub — Branch Audit

**Baseline:** `feat/laya-shadow-planner` @ `0d6c43f` (= `origin/feat/laya-shadow-planner`). Captured 2026-10-26 after `git fetch --all --no-prune`; the remote had not changed since the verified push.
**Scope:** 87 local branches, 60 remote-tracking branches, 22 tags (`v0.1.0` … `v0.1.20`, `archive/central-agent-a4f86c8`). Nothing was checked out, merged, deleted or pushed.
**Method:** for each ref, commits not in the baseline (`git rev-list HEAD..ref`), commits not in `origin/main`, and **patch-level uniqueness** (`git cherry HEAD ref`: a commit counts as missing only if no commit with the same patch exists in the baseline). Then the files and tests each unique branch changes since its merge base. "Patch-new" still does not prove the content is absent: later work may have re-implemented it differently. That is why the recommendation for most unique branches is *investigate*, not *integrate*.
**Supersedes:** `docs/audit/branches.json` (2026-09-23).

## 1. Baseline relationships
- The baseline contains all of `origin/main` (`10b2ce5`, v0.1.20 line) and is **15 commits ahead** of it. `main` has nothing the baseline lacks.
- **119 refs are fully contained** in the baseline (no commit missing): every release, website-release, bundle, packaging, onboarding, inventory-safety and integration branch up to v0.1.20, plus `main` itself. Listed in §4. They hold nothing the baseline needs. Archive candidates later, after the owners agree.
- **32 refs have commits not in the baseline.** After removing local/remote duplicates and merge-only refs, they reduce to the groups below.

## 2. Branches with unique work

### 2.1 High value — investigate first
| Branch (latest) | Unique / patch-new | Changes | Tests | Notes | Recommendation |
|---|---|---|---|---|---|
| `fix/v0.1.21-cross-platform-reliability` (= origin) `aa5915d` 2026-10-11 | 1 / 1 | 12 files: `central_agent/intent.py` (+73), `service.py` (+86), `governance/actions.py`, `governance/opencode.py`, `useAgentConversations.ts`, `AuraAgentWorkspace.tsx`, tests | `test_informational_questions.py`, `test_governance_windows_paths.py` (+ 4 updated UI tests) | Made after v0.1.20. Adds informational-question routing, a readable fallback, Windows path scope for governance, worker names. Neither test file nor informational routing exists in the baseline. **Overlaps the two most-changed files of the last stabilization** (`intent.py`, `service.py`). | **Investigate → port by hand** with its tests, re-running acceptance A. Do not merge blindly. |

### 2.2 Single-commit feature branches (remote only)
| Branch | Changes | Tests | Recommendation |
|---|---|---|---|
| `origin/feature/coding-agent` `1e10d51` 2026-09-23 | new `packages/coding-agent` (9 files): offline opencode vendor, Ollama default | none | Investigate: overlaps the existing `workers/` worker CLI integration; vendoring decision needed. |
| `origin/feature/kilo-agent` `3b15c7b` 2026-09-23 | new `packages/kilo-agent` (9) | none | Same as above. |
| `origin/feature/local-inference-l40s` `d0818bc` 2026-09-13 | `packages/ai-service` (7), desktop (2): local llama provider | none | Investigate against the current provider registry; needs tests and hardware to verify (BLOCKED here: no L40S). |

### 2.3 Workspace / UI redesign lines (Sept)
| Branch | Unique / patch-new | Main areas | Tests |
|---|---|---|---|
| `post-release/workspace-ux` 2026-09-29 | 14 / 14 | desktop (57), backend/aura (19) | 21 |
| `phase3/multi-agent-orchestration` 2026-09-29 | 12 / 11 | desktop (57), backend/aura (16) | 19 |
| `integrate/agent-workspace-v2` (= origin) 2026-09-28 | 8 / 7 | desktop (54), backend/aura (16) | 17 |
| `feat/autonomous-workspace` (= origin) 2026-09-22 | 5 / 5 | backend/tests (8), ai-service (7) | 12 |
| `integration/pr63-pr64` 2026-09-30 | 3 / 2 | desktop (37), backend/aura (13) | 16 |
| `context-fix` 2026-09-27 | 1 / 1 | desktop (30), backend/aura (13); "light-theme workspace, project autonomy, approval UX" | 10 |
| `feat/agent-workspace-v2` 2026-09-27 | 1 / 1 | desktop (13) | 2 |

These are parallel takes on the agent workspace that the baseline's workspace (the neon `AuraAgentWorkspace`, mission verdict, per-worker status) has since moved past. Some, such as `context-fix`'s "approval UX", conflict with the decision to remove approvals. **Recommendation: investigate selectively** for specific fixes worth porting (for example scheduling events or live execution in `post-release/workspace-ux`). Do not integrate wholesale.

### 2.4 Older divergent lines (August) — architecture since replaced
| Branch | Unique / patch-new | Evidence of supersession | Tests |
|---|---|---|---|
| `recon/6308a1f` 2026-08-29 | 41 / 33 | Python-backend reconstruction before the current `backend/aura` layout | 50 |
| `migration/python-backend` 2026-08-27 | 38 / 31 | Same migration, now mainline in a different form | 47 |
| `central-agent-integrated` 2026-08-24 | 23 / 19 | Central agent foundation; mainline has a 16.9k-line `central_agent/` | 30 |
| `feature/workflow-automation-unification` 2026-08-25 | 17 / 17 | Changes `backend/src/` (98 files): **that layout no longer exists** | 30 |
| `feature/backend-python-migration` 2026-08-23 | 8 / 8 | Changes `backend/src/` (69 files): **layout gone** | 20 |
| `phase2/nervous-system`, `phase3/governed-agency`, `phase4/reach`, `phase5/platform` 2026-08-20 | 8, 4, 8, 10 | Node-era "phases" with HANDOFF/QUESTIONS docs; no tests | 0 |

**Recommendation: archive later** (after the owners confirm). Before archiving, skim `phase2..5` HANDOFF/QUESTIONS docs for unanswered design questions. Nothing here should be merged into the current architecture.

### 2.5 Small and housekeeping
| Branch | Notes | Recommendation |
|---|---|---|
| `fix/windows-safe-probe` 2026-09-19 (1, 4 files, 1 test) | POSIX probe of unlisted CLIs; may duplicate later environment work | Investigate (small) |
| `pr-59` 2026-09-22 (1, 4 files, 2 tests) | Windows-simulation tests green on Linux | Investigate (small) |
| `feat/docling-document-engine` 2026-09-25 | Patch already in baseline (patch-new 0) | Archive later |
| `chore/website-0.1.15` (= origin), `feature/website-deployment` | Website download pages | Retain (website), unrelated to the app |
| `integration/pr64-rehearsal`, `pr15-sync`, `origin/fix/python-interpreter-discovery` | Merge commits only; no new patches | Archive later |

## 3. Risks found by the branch audit
1. **Valuable fixes stranded off the baseline.** `fix/v0.1.21-cross-platform-reliability` is post-release, tested, and absent. It conflicts textually with the latest stabilization.
2. **Branch sprawl.** 147 refs, 119 of them fully merged. This slows every audit and invites accidental work on stale bases. Already noted as G-07 in `gaps.json`.
3. **Duplicate implementations across lines** (several workspace v2/v3 redesigns; Node vs Python backends). This is how divergent behavior reappears.
4. **Remote and local drift.** Several local branches track a different remote branch than their name: `chore/release-0.1.15`, `feat/autonomous-workspace`, `integration/pr63-rehearsal` and others track `origin/main` or `origin/context-fix`. Harmless now, but confusing.

## 4. Fully contained refs (no unique commits)
backup/pre-merge-20260830-200622-integration-v0.1.5, bugfix/qa-runtime-pass, chore/release-0.1.{7,8,9,10,11,13}-version-bump, chore/release-0.1.15, chore/website-0.1.{7,9}, chore/website-v0.1.10-release, ci/apt-official-mirror, debug/windows_debug, feat/appimage-desktop-integration, feat/bundle-node-runtime, feat/bundle-python-runtime, feat/linux-first-run-distribution, feat/local-first-ollama, feature/agent-context-phase3, feature/aura-agentic-workspace, feature/aura-central-agent, feature/autonomous-connected-environment, feature/bug-bot-in-code-editor, feature/chat-scope-separation, feature/connected-environment-v2, feature/enhancement-of-extended-environment, feature/physical-engineering-foundation, feature/update-experience-v1, feature/workflow-engine-v1, feature/workspace-2.0-context-fabric, feature/workspace-2.0-merge, feature/workspace-execution-environment, feature/workspace-v2-aura-execution-ui, fix/appimage-pythonhome-leak, fix/bundle-python-backend, fix/bundle-python-dependencies, fix/context-contract-types, fix/environment-api-runtime-connectivity, fix/install-direct-user-action, fix/mission-capabilities-quote, fix/onboarding-gate-stuck, fix/opencode-approval-and-ask-aura, fix/packaging-security-invariants, fix/packaging-verify-1g, fix/pr56-inventory-safety(-2), fix/probe-timeout-not-absence, fix/python-interpreter-discovery, fix/release-0.1.7-lockfile, fix/secret-scan-false-positive, fix/wire-uninstall, fix/workflow-engine-integrity, integration/mainline-v0.1.3, integration/pr63-rehearsal, integration/pr64-final, integration/v0.1.5, main, phase1/redaction-and-journal, pr/21, pr/24, pr/27, pr31-workspace-ui, presentation-v0.1, release/update-engine-phase1, release/v0.1.1-candidate, tmp/context-fix-commit — plus their `origin/*` counterparts and the remote-only `origin/bugfix/repository-stabilization(-20260902)`, `origin/enhance/workspace-ui`, `origin/feature/amoun-backend`, `origin/feature/local-server-build`, `origin/feature/workspace-execution-environmentV2`.

Raw data (outside the repository): `scratchpad/phase0/branch-relationships.txt`, `branch-patch-uniqueness.txt`, `branch-tests.txt`.
