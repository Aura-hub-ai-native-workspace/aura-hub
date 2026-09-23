# AURA Live Event Contract (Phase 2)

Companion to `OBSERVABILITY-CONTRACT.md` (correlation model) — this
document owns the transport: how events travel from `EventBus` to the
desktop UI in real time. One event model (`AgentEvent`), one bus, one
SSE route, one client. No parallel schemas.

## Connection lifecycle

```
GET /agent/sessions/{sid}/events[?after=N]  (+ Last-Event-ID header)
  → 404 unknown session · 400 malformed cursor
  → 200 text/event-stream:
       bounded replay (tail after cursor, newest REPLAY_MAX)
       then live frames until the client disconnects
       heartbeats (`: heartbeat`) every ~20s of silence
```

The server never closes a healthy stream; there is no `[DONE]`
sentinel on this route (its absence is what makes it live-follow).
Disconnect (client close, network loss) ends the read; the server
unsubscribes in `finally`.

## Event schema (wire)

```
id: <seq>                              # bus sequence; omitted when unknown
data: {"type","at","sessionId","payload"[, "seq"]}
```

`seq` is bus-wide monotonic (hence per-session monotonic). Payloads
carry `requestId` (Phase 1 correlation) and only safe summaries —
never credentials, prompts, or chain-of-thought.

## Cursor semantics

- Cursor = last seen `seq` (SSE `id:` line, standard `Last-Event-ID`
  request header, or `?after=` query — header wins when both arrive).
- Replay = tail events for this session (+ global `-` channel) with
  `seq > after`, capped at `REPLAY_MAX` (200) newest.
- Cursors cannot cross scope: replay and live frames are always
  filtered to the URL's session. A cursor from session A replayed
  against session B yields B's newer events only.
- Malformed cursor (non-integer, negative) → 400; the client
  resubscribes without a cursor.

## Ordering

Bus emission order == `seq` order == replay order == live order.
Reconnect overlap is resolved client-side by sequence dedupe, so the
rendered order is the bus order.

## Replay

Bounded (`REPLAY_MAX`), session-filtered, cursor-relative. A client
that is more than the tail behind still converges: it receives the
newest window plus live frames, and durable state (submit/approve
response bodies, session GET) fills any gap older than the window.

## Reconnect

Client keeps one persistent connection per subscription. On drop it
reconnects with the last seen `seq` after capped backoff
(250ms → 8s), emitting an honest `stream.reconnecting` frame so the
UI can say "live updates paused". A lagged consumer (past
`LIVE_QUEUE_MAX` = 200 buffered frames) receives `stream.resync`
and reconnects the same way.

## Delivery semantics

At-least-once transport with cursor dedupe = **effectively-once**
rendering. Audit and response bodies stay authoritative: a lost
stream can delay the UI but never fabricate or erase a result.

## Cancellation

`centralAgentClient.cancel()` records the stop server-side; the run
settles to `cancelled` and the `run.cancelled` frame arrives over
the still-open stream. Closing the stream (unmount, new request)
aborts the HTTP read and unsubscribes; it does not cancel the run —
only an explicit stop does. `answer.cancelled` is emitted for a
stream stopped mid-synthesis, never `answer.failed`.

## Approval

`approval.required` (with `approvalId`) arrives live; the gate fetches
the full request by exact id from `/fabric/approvals`. No polling is
used or needed on this path. Approval decisions still travel the
single-use ledger (`decide` + `resume`), unchanged.

## Bounds

| Bound | Value | Where |
|---|---|---|
| Bus tail | 500 events | `EventBus(tail_limit=)` |
| Replay window | 200 events | `REPLAY_MAX` |
| Live buffer | 200 frames | `LIVE_QUEUE_MAX`, then resync |
| Heartbeat | ~20s silence | route pump timeout |
| Client dedupe memory | 2000 seq cap | `FrameDeduper` |
| SSE payload | bounded upstream | prompts/outputs capped at synthesis |

## Security

- Unknown session → 404 before any subscription exists.
- Scope filter applies to replay AND live frames identically.
- `stream.resync` is a transport directive, not an `AgentEventType`
  member: it is never persisted, never audited, never rendered as
  agent activity.
- Malformed frames are skipped client-side; they cannot crash the UI.
- Slow consumers are dropped with direction (resync), never left to
  grow memory.

## Correlation IDs

Unchanged from `OBSERVABILITY-CONTRACT.md`: `requestId` rides every
frame payload; `sessionId` scopes the stream; approval/worker/
evidence ids travel the frames their lifecycle step emits.
