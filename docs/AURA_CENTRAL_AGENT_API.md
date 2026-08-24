# AURA Central Agent — HTTP API

> Backend surface for the React frontend. All routes are served by
> `backend/aura/api.py` (default `127.0.0.1:4320`, see `build_default_api`).
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
→ `{ "result": AgentResult, "sessionId": "agt-…" }`

`AgentResult.outcome` is honest and closed:
`completed | failed | blocked | awaiting-approval | cancelled | denied | timeout`.

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
