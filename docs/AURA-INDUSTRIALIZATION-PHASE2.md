# AURA Industrialization — Phase 2 Report

**Baseline:** `feature/enhancement-of-extended-environment` @ `a87cc7b` (repo advanced two commits since Phase 1: network allowlist, agent-workspace UI refine — both preserved untouched).
**Scope:** live event spine + real-time UI + GUI smoke. No new agent, authority, provider, context, ledger, or tracing system.

## Baseline

Existing path before Phase 2: `CentralAgent → EventBus (no seq) → tail snapshot → SSE replay-then-close → client reconnect-poll + type@at dedupe`. Proven by code read + the old closure test (waited for terminal `[DONE]`).

## Existing Event Architecture

`AgentEvent{type, at, sessionId, payload}` (Literal types), in-process `EventBus` (500-tail, session filter incl. `"-"` channel), Starlette snapshot route, legacy stdlib host route, `centralAgentClient.events()` with backoff reconnect. All retained; extended, not replaced.

## Live-Follow Architecture

- `EventBus.emit` assigns bus-wide monotonic `seq` (`model_copy`, best-effort on foreign shapes).
- `tail_after(filter, after, limit=200)`: bounded cursor replay.
- `subscribe_live(filter)`: queue pump (200 cap) + `close()`; lag raises `_StreamLagged` → route emits ephemeral `stream.resync` (transport-only, never persisted/audited).
- Route `GET /agent/sessions/{sid}/events[?after=N]` (+ `Last-Event-ID`): 404 unknown, 400 malformed/negative cursor, scope filter on replay AND live, `id:`-prefixed frames, ~20s heartbeat comments, `finally: close()`.
- Delivery: at-least-once + cursor dedupe = effectively-once; audit/bodies stay authoritative.
- Legacy stdlib host keeps snapshot `tail_stream` (documented).

## Event Contract / Cursor / Reconnect Semantics

`id: <seq>` + `data: <AgentEvent JSON>`; cursor = last seen seq; reconnect replays only newer frames; dedupe by seq (legacy `type@at` fallback); backoff 250ms→8s; `stream.reconnecting` honesty frames. Cursor cannot cross scope (filter always applies). Full text: `docs/architecture/LIVE-EVENT-CONTRACT.md`.

## Approval Streaming

`approval.required` (+id) arrives live; gate fetches the full request by exact id; P1-B exact binding unchanged and re-verified live (approval id matched session evidence + project in the GUI run).

## Cancellation

Unchanged semantics, re-proven: stop → server-recorded cancel → `run.cancelled` over the still-open stream; stream close alone never cancels a run; `answer.cancelled` never mislabeled (Phase 1 fix intact). GUI T6 proves no late answers after cancel.

## Frontend Integration

`centralAgentClient.events()` rewritten on `agentEventStream.ts` primitives (`splitBlocks`, `parseBlock`, `FrameDeduper` with 2000-seq memory cap + monotonic cursor). `useAgentConversations`, `useAiAction`, `AiWorkspace`, `AgentPhaseStrip` (answer.* → result) consume the same callback interface — no redesign. No polling exists on these paths (Hero's approve-reconcile is durable-state reconciliation, kept).

## GUI Harness

`scripts/ui-agent-events.mjs` (repo playwright-core + system-chromium convention) + `npm run test:ui-events`: 20 checks across TEST 1–10 on the real three-service stack with disposable homes. Notable fixes during validation: Playwright `*` doesn't cross `/` (regex matchers), two-step Decline gate, delayed-leg cancel target, request-observed send retry.

## Test Results

- New backend `test_event_spine.py` (8): seq, cursor replay/bounds, isolation, live order/filter, lag→resync, disconnect cleanup, HTTP replay/cursor/400/404, live delivery + reconnect — all over REAL uvicorn (TestClient cannot hold infinite SSE; documented in-test).
- New frontend `agentEventStream.test.ts` (12, vitest 3 — smallest setup that resolves with the repo's vite 5): blocks, parsing, dedupe, cursor monotonicity, legacy fallback, memory bound.
- Updated `test_api_closure.py` events test to live-server bounded read.
- Full `tests/unit` + `tests/api` green; `npm run typecheck` green; Vite build green (prior phase; unaffected).
- GUI smoke: **20/20** on isolated stack (0 pre-existing approvals, no provider key).
- Known-flaky live-worker tests (`test_opencode_to_claude_no_paste`, `test_full_loop_deviate_then_correct`) failed once in a large parallel run, pass in isolation and rerun — worker nondeterminism, unrelated (fingerprints provably exclude leg ids: `canonical.py:106-121`).
- Pre-existing ENV failure unchanged: automation node-driver fixture (`stub-agentrunner` vs expected name).

## Autonomous Benchmark Results

Rebuilt fixture (same recipe), rerun through the new spine: submit→park (0.3s, requestId) → 12 sequenced correlated lifecycle frames observed live → approve → worker completed (69.9s) → identical minimal fix (`normalize_email`) → 7/7 suite green → regression test proven genuine both directions → hostile README ignored → evidence/audit match. Benchmark still passes, now fully observable.

## Security Validation

Scope filter identical on replay/live; unknown→404; malformed cursor→400; resync is transport-only; client skips malformed frames; no credentials in payloads (unchanged); queue/lag caps prevent memory abuse; disconnect always unsubscribes (finally + test).

## Performance

Replay capped at 200; heartbeat 20s; live frames unbuffered; dedupe O(1); client memory capped. No measurable overhead vs snapshot polling (fewer requests overall). Token cadence unchanged.

## Backward Compatibility

Ctrl+I, Ask AURA (project+home), AuraBug, missions, workflows, provider config, sessions, audit: suites + smoke green. `AgentEvent.seq` optional (old payloads validate). Legacy host untouched. No wire break except the intentional one: `/events` no longer terminates with `[DONE]` (closure test updated; no other consumer relied on it — verified by grep).

## Remaining Gaps

- TestClient can't exercise infinite SSE (harness limitation, documented; live-server tests cover it).
- T7 abort-simulation is coarse (survival, not frame-level no-dup — covered at unit level).
- Worker stdout streaming still out of scope (declared).
- Neon parallel UI untouched.

## P0/P1/P2/P3/P4 Findings

- None new at P0–P2. Test-only issues fixed during validation (literal types, socket timeouts, glob semantics).
- P3: automation ENV fixture name mismatch (pre-existing).
- P4: none.

## Recommended Phase 3

Operator provider onboarding (enables model-backed GUI runs) + Playwright coverage of Ctrl+I dialog + parity-harness consolidation, per roadmap NEXT items.
