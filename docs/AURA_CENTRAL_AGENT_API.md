# AURA Central Agent — HTTP API

> Backend surface for the React frontend. All routes are served by
> the canonical factory `aura.api.server.create_app`
> (default `127.0.0.1:4320`, see `scripts/serve_central_agent_api.py`).
> The legacy `build_default_api` stdlib host is deprecated.
> Errors are always exactly `{"error": string}` with an appropriate status
> (wire-contracts §1). No route duplicates governance: approvals are decided
> through the same ledger the Fabric spends.

## Sessions

### `POST /agent/sessions`
Submit one user intent. Creates a session and drives it synchronously.

```json
{ "message": "create a file called demo.txt containing hello",
  "projectId": "optional", "projectPath": "/abs/path/optional" }
```
→ `{ "result": AgentResult, "sessionId": "agt-…", "requestId": "req-…" }`

**Session ids and continuation (decision).** A caller may propose a
`sessionId` shaped `agt-` + 12 hex. If that id is already taken, the server
does NOT reuse it: `POST /agent/sessions` starts a fresh session under a new
server id. This is deliberate, so a plain submit can never hijack or
overwrite an existing session. To answer a clarification or continue a
conversation, call `POST /agent/sessions/{sid}/message`, which loads the
session and continues it. Pinned by `tests/unit/test_clarification_lifecycle.py`.

Every leg-creating or leg-resuming route (`/agent/sessions`,
`/message`, `/approve`, `/resume`, `/resume-cancelled`, `/cancel`)
generates one server-side `requestId` (`req-` + 12 hex), returns it in
the body and (Starlette host) in the `X-Aura-Request` header. The id
propagates into session events (`payload.requestId`), Fabric audit
records, worker assignments, and `evidence.requestIds` — see
`docs/architecture/OBSERVABILITY-CONTRACT.md`. Malformed ids are
refused with 409 before any state is touched.

### `GET /agent/model`

Secret-free model routing observability: `{configured, providers[],
lastCall}`. Unconfigured → `configured: false`, `lastCall: null`.
Unknown identity is reported as `"unknown"`, never fabricated.

`AgentResult.outcome` is honest and closed:
`completed | failed | blocked | awaiting-approval | cancelled | denied | timeout | needs-clarification | unsupported`.

**Workspace runs the goal immediately.** A submitted goal is planned,
checked against policy and executed in the same call: there is no plan
approval and no per-action approval for routine work. Independent read-only tasks run
in parallel, but at most one task that changes the project runs at a time (and one
worker per project across sessions); the coordinator keeps a shared run board (what every task owns,
what verified tasks found, what failed), schedules by dependency, never runs
two tasks that would write the same files at once, retries a failed task
within a bounded budget (on another worker when one fits), and reports a
truthful terminal outcome. A run parks (`awaiting-approval`) only for the
hard floors — account authorization, machine-level system changes,
irreversible and destructive actions — or for something the person's own
policy explicitly set to ask. Those park on the ledger (`/approve`).

### `POST /agent/chat`
Let's Chat — conversation only. `{ "message": "…", "sessionId": "agt-…"?,
"projectId": "…"?, "projectPath": "…"? }` → `{ result, sessionId, requestId }`.
The reply is words only, on a chat-mode session: no plan, no authority
check, no capability invocation, no worker, no workflow and no file write,
whatever the message asks. A chat session is refused (**409**) by the work
routes (`/message`, `/resume`), and a Workspace session is refused (**409**)
here; **400** when `message` is empty or `sessionId` is not an `agt-` id.
Pinned by `tests/unit/test_workspace_direct_execution.py` and
`tests/unit/test_workspace_and_chat_http.py`.

### `POST /agent/chat` — research, context and the surface
The chat request also takes `"surface": "general" | "project-chat"`. Every
question is routed (`intent.classified`), answered with a bounded Shared Context
package sized to the model's real limit, and researched on the web in
proportion to the question (`research.started/sources/completed`). The answer
streams as `answer.token`, citations are checked against the sources actually
retrieved (`answer.citations`; a dangling `[n]` is reported, not shown as a
source), and the reply carries `sources`, `research` (`status`: ok | empty |
unavailable | cancelled | skipped, with the reason), `recorded` (what this turn
added to Shared Context), `nextActions` (`create-project`, `create-plan`) and
`model`. When research cannot run the answer says so; sources are fenced as
untrusted data. Each turn (question, answer, citations) is stored on the session.

### `GET /agent/chats?projectId=&limit=`
Chat sessions already in the session store, newest first (general chats when no
`projectId`). Read-only; `limit` is clamped to 1–50.

### `GET /agent/models/status`
`{ laya, local, recommendation }`: whether a reasoning model is configured and
usable, which local runtime and models exist, and — only when the machine has
the runtime, RAM (≥ 4 GB) and disk (≥ 3 GB) — an optional recommendation of a
small local model with the command to run. Nothing is ever downloaded or
installed by this route.

### `GET /agent/context/{scope}?q=&chars=`
The Shared Context package for a project (or `general`), bounded by `chars`
(1000–60000). Scopes are validated; a project never sees another's records.
The response includes `goal` as its own field.

### `POST /agent/projects/{pid}/adopt`
`{ "sessionId": "agt-…", "idea"?: "…" }`. Carries what a general chat settled
(goal, requirements, constraints, decisions, rejected options, research) into
the project's Shared Context as its origin, and links the two sessions both
ways. Idempotent. **409** for a non-chat session or an unsafe project id,
**400** for an unknown session.

### `POST /agent/plans/execute`
The Planner → Workspace handoff. A validated plan (`planId`, `revision`,
`projectId`, tasks with dependencies/files/worker/expected output/verification,
acceptance criteria, context and sources) becomes a work session on the same
dispatch as `/agent/sessions`. Idempotent per plan revision; a stale revision is
refused. The run reports `plan.received`, `task.authored`, `task.state`,
`files.changed`, `worker.queued`, `worker.handoff`, `tool.provisioning`,
`error.recorded` and `verification.*`, and ends with a measured
`result.report` (work completed, unfinished, files changed as observed,
tools installed/reused, handoffs, errors). Partial success is never reported as
complete.

### `GET /agent/sessions/{id}`
Full persisted session (state, messages, lastResult).

### `POST /agent/sessions/{id}/message`
Continue the conversation: answer a pending clarification or add a follow-up.
A pending question turns this message into its ANSWER (same session, zero
effects in between). Follow-ups never replay already-completed effects.
`{ "message": "temporary files only", "projectPath": "/optional" }`.

### `POST /agent/sessions/{id}/approve`
Convenience: record THIS human decision through the same single-use ledger,
then resume the session in one call. `{ "approvalId": "apr-…", "granted": true }`.
Second decisions return **409**, exactly like `/fabric/approvals/{id}/decide`.
It is reached only for a hard floor or for something the person's own
policy set to ask; routine work never parks.

### `GET /agent/sessions/{id}/plan`
Human-readable review of the active plan: steps, capabilities, risks,
verification intents. NEVER contains model reasoning.

### `POST /agent/sessions/{id}/resume`
Continue a parked session after a human decision. Validates the grant
BEFORE re-executing; the Fabric spends it single-use. Denied decisions
return `outcome:"denied"` — never a retry, never an error loop.
Errors: 400 when not awaiting approval; 403 when the grant is missing,
unspent-but-stale, or forged.

### `POST /agent/sessions/{id}/cancel`
Best-effort cooperative cancellation of the active run leg.

### `GET /agent/sessions/{id}/evidence`
The EvidenceBundle of the last result (audit record ids + approval ids).

### `GET /agent/sessions/{id}/events`
**SSE.** Replays the session's event tail, then follows live. Frames are
serialized AgentEvent payloads. Live events are observability only —
durable audit remains authoritative for evidence.

## Reasoning model: one source of truth

Settings (the AURA service, port 4319) owns provider configuration, including
encrypted API keys, in `$AURA_HOME/providers.json`. The Central Agent never reads
or decrypts that file. After every change to it (connect, switch model, disconnect,
and at boot) the service publishes a secret-free view,
`$AURA_HOME/agent/providers.settings.json`:

```json
{ "schema": 1, "source": "ai-service-settings", "updatedAt": "…",
  "active": { "providerId": "ollama", "model": "qwen2.5-coder:1.5b",
              "callable": true, "baseUrl": "http://127.0.0.1:11434/v1" } }
```

* A **self-hosted** provider (Ollama) is addressed, not keyed, so it is
  `callable` and carries its address. Nothing in the view is a credential.
* A provider that **needs an API key** is `callable: false` with a reason. Its key
  stays in the AURA service. To let the Central Agent reason with it, list it in
  the operator file with `apiKeyEnv`.
* **Precedence:** entries in `$AURA_HOME/agent/providers.json` (operator file) win
  over the Settings view; the Settings provider is appended only if its id is not
  already listed. An explicit path (tests, tooling) reads only that file.
* **Live:** the agent compares both files' mtime/size on each chat, plan handoff
  and status call and re-resolves the port in place, so Settings changes need no
  restart.
* The Settings provider is given a 120 s idle budget and a 5,500-character cap per
  prompt block (Ollama serves a 4096-token window and its OpenAI-compatible
  endpoint cannot raise it). Chat prompts are built to that budget: the person's
  question and the research status are never cut; older conversation, runtime
  description, settled context and research text are reduced in that order.

`GET /agent/models/status` reports `laya.configured` (a provider is set up) and
`laya.usable` (a bounded, read-only probe of its `/models` list succeeded and the
configured model is in it; keyed providers are not probed). Each provider carries
`check.state`: `ready | unreachable | model-missing | unchecked | disabled`. It also
reports `laya.settings`, what Settings selected and whether the agent can call it.

A reply written by a model is attributed (`result.model`) only from the provider
call that produced it. When a configured model was asked and failed, `result.model`
is empty and `result.modelFailure` is `{category, reason, provider, model}`; the
text then says the model did not answer, separately from web search.

Timeouts: a caller's deadline (`GenerateRequest.timeoutMs`) reaches the transport,
capped at 10 minutes. The Planner reads the model's answer as a stream with an
overall ceiling of 480 s; the adapter's idle timeout (120 s of silence) is the
liveness check, so a slow model that is still writing is not cut off and a hung
one is. While it runs the plan stream carries a `progress` event every 5 s:
`{elapsedMs, deadlineMs, receivedChars}`. A timeout reports the elapsed time and
the limit, or that the model "sent nothing for N s". On the reference CPU-only
machine (qwen2.5-coder:1.5b, about 12–20 tokens/s) 4–5 task plans took 63–175 s;
a fixed 180 s deadline cut the slowest off while the model was still writing.
The plan prompt's settled context is capped at 2,500 characters, head kept.

## Worker billing policy (paid workers are off by default)

AURA cannot know what a worker's runtime bills, and being installed, connected,
readiness-proven or labelled "free-tier" in a catalogue is not evidence that it is
free. **Unknown billing is treated as potentially paid and denied.** Only the owner
can allow a worker, in `<AURA_HOME>/worker-policy.json`:

```json
{ "verifiedFree": ["opencode"], "authorized": ["claude-code"] }
```

`verifiedFree`: the owner states the worker costs nothing in their setup.
`authorized`: the owner accepts its cost. A missing or malformed file allows nothing.
A model, plan, task, approval id or chat message cannot write or widen it.

It is enforced in the one module `aura/workers/billing.py`, asked at three places:
worker **selection and failover** (`agent_delegate_supports_node`: a denied worker is
never "usable", so failover lands only on an allowed one), the **dispatch boundary**
(`agent_delegate_run` returns `output.blocked = "billing-policy"` and spawns nothing),
and the **readiness probe** (`prove_worker` sends a real prompt, so it is gated too).
With no allowed worker a task stops with that reason; AURA-authored file tasks, which
use no worker, are unaffected.

## Project location

`GET /projects/location?name=…` (ai-service) returns the folder a project with that
name would get: `{parent, dirName, target, overridden, renamed}`. It is the same
function creation uses (`planNewProject`), so the dialog preview, the created folder
and what is shown afterwards cannot differ. `AURA_PROJECTS_DIR` moves the parent;
without it the default is `~/AuraProjects`.

## What a chat reply may claim

Let's Chat executes nothing and its prompt carries no capability catalogue. A reply
that names a capability id, or asserts a completed or verified outcome ("ready for
deployment", "tests pass", "has been deployed"), gets a plain appended note and
`result.unsupportedClaims`; its words are not rewritten. Hypotheticals ("could add a
test and check whether the build passes") are left alone.

## Runaway output and readiness stages

* Every model stream is bounded: `max_tokens` is sent to the provider, there is a 300 s wall-clock ceiling
  (the socket timeout only catches silence), and a **repetition guard** (`central_agent/repetition.py`, mirrored
  for the Planner in `ai-service/src/repetition.ts`) stops a stream whose tail is a unit of at least 40 characters
  repeated three times. A loop is `modelFailure.category = "DEGENERATE_OUTPUT"`, never an answer; the text written
  before it is kept and shown labelled "unfinished, not verified". The Planner retries once with a repetition
  penalty, then reports the loop. Cancellation is honoured per streamed piece. A cancel never carries over to
  the next message of a chat.
* `GET /agent/models/status` gives each provider `stages`: `configured`, `credentials`
  (`not-required | available | missing`, never the value), `reachable`, `modelAvailable`, and `lastRequest`
  (`succeeded | failed | null`). A model has answered only when `lastRequest` is `succeeded`.
* A question about something current, answered with no web evidence, starts with an explicit
  "Not verified against the web" line on the answer itself.

## Web research configuration

`GET /agent/research/config` → `{configured, endpoint, source: file|environment|null}`
(no credentials). `POST /agent/research/config {searchEndpoint}` validates the
address (http/https, no embedded credentials, not a metadata host), sends one
bounded test query, and saves it to `$AURA_HOME/web.json` (other keys kept) only if
the answer is a JSON object with a `results` list. `DELETE` removes it. When
`AURA_SEARCH_ENDPOINT` is set it overrides the file and saving is refused with that
reason. AURA ships and suggests no gateway. A gateway answer that is not
search-shaped is reported as a gateway problem, not as "no results".

## Governance (thin surface over the ONE ledger)

### `GET /fabric/approvals`
Pending ApprovalRequests (persisted, durable across restarts).

### `POST /fabric/approvals/{approvalId}/decide`

```json
{ "granted": true, "reason": "human-readable" }
```
→ `{ "approval": ApprovalRequest }`. A second decision returns **409** —
double-click, replay and second-tab are harmless by construction. The
grant itself is spent by the Fabric at invoke time, fingerprint-bound to
the exact arguments presented.

## Artifacts

### `GET /workflows`
Stored workflow definitions (the agent's authoring output).

### `GET /workflow-runs/{runId}`
One engine run record: state, node records with transitions/evidence/
approvals, outputs, log. Resume legs chain via `trigger:{kind:"resume",of}`
and `supersededBy`; `resume_chain` order is old→new.

## Health

### `GET /health` → `{ "ok": true, "service": "aura-central-agent" }`
