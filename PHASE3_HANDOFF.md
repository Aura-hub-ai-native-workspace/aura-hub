# PHASE 3 HANDOFF — Stage C: Live Execution and Delegation

**Date:** 2026-09-29 · **Branch:** `post-release/workspace-ux` · **Stage C commit:** see `git log` (this file was written in the same commit)
**Chain:** `4c6b814` (v0.1.17 release, tag untouched) → `1e96fba` (post-release UX fixes) → `35f977b` (Stage A) → `9bf9e2a` (Stage B) → **Stage C (this commit)**

## Architecture (as verified, unchanged in authority)

```
User composer (ConversationPane, left panel — the ONLY input surface)
  └─► useWorkspaceConversations.send()            ai/useAgentConversations.ts
        ├─ centralAgentClient.submit(/agent/sessions) → Central Agent (:4320)
        │    intent → plan (task contracts: scopePaths, roles, deps)
        │    → approval ledger (irreversible actions park the run)
        │    → governed dispatch → worker runtime (Claude Code)
        │    → invocation.observed / worker.action frames
        │    → verification (exit-code + scope check) → evidence → AgentResult
        ├─ SSE /agent/sessions/{sid}/events → store frames (single subscription,
        │    shared by fresh runs, approval resumes, and dead-session recovery)
        └─ frames fold → runViews.ts (pure) → timelineModel.buildV2Timeline
             → V2TimelinePanel (right panel, no input) + OrchestrationStage grid
```

One pipeline: the transcript and the execution timeline fold the **same frames**; nothing submits a second run. Governance is server-side and fail-closed (hard-boundary denials park the run and are displayed, never hidden).

## Stage C changes

| File | Change |
|---|---|
| `apps/desktop/src/ai/useAgentConversations.ts` | **Run-record persistence**: assistant meta now carries the run's own frames (capped 400, `MAX_PERSISTED_FRAMES`) so a reopened thread folds the same timeline it drew live; `restoreMessages` restores them verbatim. **Approval resume streams**: `decide()` now subscribes the resumed leg via the shared `runFrameHandler` (previously everything after "Approved" was invisible and unpersisted), seeding the store's frames with the pre-park record. **Dead-session recovery**: a follow-up whose remembered session no longer exists (service restart / AURA_HOME change) falls back ONCE to a fresh session on the backend's own "no such session" verdict — new plan, new approvals, so no authority carries over; the SSE subscription re-binds to the fresh session. |
| `apps/desktop/src/screens/WorkspaceScreen.tsx` | Timeline folds from the persisted frames when no leg is live (live frames win while `phase==='working'`); worker-activity map joins run-reported worker ids/names to roster ids so the stage grid lights the actually-assigned worker. |
| `apps/desktop/src/screens/agentWorkspaceV2/TimelineCard.tsx` | Progressive disclosure for long worker output: `>480` chars clamp to 6 lines with a Show full output toggle (logs/diffs/stack traces cannot push the run out of the panel). |
| `backend/aura/central_agent/intent.py` | **Smallest necessary backend defect fix**: `_delegate_scope` strips trailing sentence punctuation from extracted scope paths. The trailing period of "…in `src/slugify.test.js`. Delegate…" minted the contract entry `src/slugify.test.js.`, which no real file matches — governance then hard-denied every write to the intended file (fail-closed worked; the *contract* was wrong) and the correction loop inherited the same broken scope until budget exhaustion. Interior dots (versions, extensions) are preserved. |
| `apps/desktop/src/ai/agentRunPersistence.test.ts` | NEW regression: frames persist alongside the answer; 400-frame cap; verbatim restoration through the real `select()` path; `derivePlan` rebuilds the worker/task record from restored frames; pre-Stage-C threads (no frames) restore to an honest idle; dead-session follow-up recovers on a FRESH session (`messageCalls`/`submitCalls` prove the ids differ). |
| `backend/tests/unit/test_intent_compiler.py` | NEW `TestDelegateScope`: trailing punctuation is not scope; version dots survive; unmentioned files stay out of scope. |

## Verification — what passed through REAL backend execution

One genuine end-to-end handoff in a disposable project (`/tmp/aura-handoff-lab`, registered as `handoff-lab`), Claude Code connected and governed in real time:

1. Request typed into the real Workspace composer (project anchored in the hero).
2. Central Agent compiled intent → 1-task plan (`implement`, role code, contract scopePaths `['src/slugify.js','src/slugify.test.js']`).
3. Delegation parked on the approval ledger; the gate rendered in the conversation; **Approve** was clicked through the UI; the resumed leg streamed live (Stage C fix).
4. Claude Code performed the real operation: `src/slugify.js` rewritten (valid implementation, different from any prior attempt) and `src/slugify.test.js` written with two tests — **file changes observed on disk during the run**.
5. The Workspace showed the real events: plan card → worker card (Claude Code) → waiting-for-approval → completed, with verification and artifacts sections.
6. Verification ran and reported its actual outcome: "The worker exits 0 and every file it changed lies inside the declared scope", audit invocation `invmumuem8i2`.
7. Final result in the conversation: "1 task(s) executed; all verifications passed." with the granted approval record ("Used Claude Code").
8. Reloading the Workspace rebuilt the identical timeline (worker identity, verifications) from the persisted frames.
9. The delivered tests genuinely pass: `node --test src/slugify.test.js` → 3/3.

The negative path was also exercised end-to-end (before the intent fix): a malformed scope contract produced real hard-boundary denials, a real failed correction loop, and an honestly rendered failed timeline in both themes — governance, parking, denial evidence and failure display all work exactly as specified.

## Tested with mocks (unit level)

- Frame → timeline folding (`timelineModel.test.ts` et al., existing suites).
- Persistence round-trip and dead-session recovery: real store, real restoration path; only `centralAgentClient` and the `aiClient` persistence seam mocked (`agentRunPersistence.test.ts`).
- Scope extraction (`TestDelegateScope`): pure functions, no I/O.

## What could NOT be verified

- **Multi-worker delegation** (review/remediate chains, `distinctWorkerFrom`): the verified task planned a single `implement` task; per scope restrictions no multi-worker run was forced.
- **Approval Decline path**: only the Approve path was driven through the UI in the final run (Decline renders and routes through the same `decide()` code path, covered by existing unit tests).
- **Tauri desktop shell** (window title, native menus): verification ran in Chromium against the vite dev server, as in Stages A/B.
- **Automatic recovery after backend restart mid-run**: the dead-session fallback is covered by unit test and was exercised manually via the stale-thread failure, but no automated mid-run kill test exists.

## Screenshots (`screenshots-ux/`, untracked)

Stage C: `stageC2-planning / -delegation / -executing / -approval-1 / -completion / -reopened / -light-1280`, plus the failed-run set (`stageC2-completion` from run 1 is the honest-failure state) and `stageC-idle-1600`. Stage B set: `stageB-*`.

## Checks

- `npx tsc -b` (apps/desktop): clean
- `npm run test:front`: **320/320** (23 files; +5 new regression tests)
- `npm run build` (apps/desktop): clean (chunk-size warning only, pre-existing)
- Backend: `pytest tests/unit -k "intent or planner or supervision or governance or central or agent_run or fabric or execution or correction"` → **238 passed** (full suite exceeds the shell timeout; unrelated suites untouched)

## Remaining limitations / exact next milestone

Per Stage C scope restrictions, NOT implemented (they are the next Phase 3 backend milestones):

1. **Multi-worker parallel execution** — planner already supports review/remediate shapes with `distinctWorkerFrom`; execution is serial. Milestone: parallel dispatch with per-worker contracts and merged evidence.
2. **Worktree isolation** — workers run in the project cwd under scope contracts; no per-task worktrees. Milestone: worktree-per-task with merge-on-verify.
3. **Automatic conflict resolution / autonomous retries** — corrections are bounded, human-gated (1 + budget), and never widen scope; nothing retries without a decision. Milestone: policy-driven retry budgets with autonomy per project (the autonomy flag already exists in the project registry).
4. **Old threads have no frames** — threads persisted before Stage C restore to an honest idle timeline; they never fabricate one. Acceptable permanently.

**Stop point:** Stage C complete. Next session should start Phase 3 milestone 1 (multi-worker parallel execution) only on explicit request.
