/**
 * spineClient — the renderer's one connection to the Event Spine.
 * ==================================================================
 * Before this file there was no `EventSource` and no WebSocket anywhere
 * in `apps/desktop/src`. Every screen learned about backend state by
 * asking again on a timer, which meant a backend-initiated event — an
 * approval an autonomous agent needs answered — had no way to reach the
 * person who must answer it until the next tick, if a tick happened to be
 * running at all.
 *
 * Design rules
 * ------------
 * • **One connection for the whole window.** Consumers subscribe to this
 *   module, not to the network. A second `EventSource` would mean a second
 *   offset to keep straight and a second thing to reconnect.
 * • **Resume, never restart.** The browser's own `EventSource` sends
 *   `Last-Event-ID` on reconnect and the service replays from it, so a
 *   dropped connection costs latency and nothing else. `after` is only
 *   used for the very first connect of a session.
 * • **The poll is a fallback, not a partner.** `connected` is exported so
 *   a screen can run its old poll ONLY while the channel is down. A poll
 *   that keeps running next to a live channel is not a fallback, it is
 *   the thing this replaces.
 *
 * There is no Tauri dependency here: `EventSource` is a WebView API and
 * works identically in `npm run dev`.
 */

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
const BASE = ENV.VITE_AI_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4319';

export type EventTopic =
  | 'fabric' | 'approval' | 'mission' | 'automation' | 'workspace' | 'agent' | 'provider';

export interface AuraEvent<P = unknown> {
  seq: number;
  id: string;
  at: string;
  topic: EventTopic;
  type: string;
  projectId: string | null;
  payload: P;
}

export type SpineStatus = 'idle' | 'connecting' | 'open' | 'closed';

type Listener = (event: AuraEvent) => void;
type StatusListener = (status: SpineStatus, lastSeq: number) => void;

interface Subscription {
  topics: readonly EventTopic[] | '*';
  listener: Listener;
}

const subscriptions = new Set<Subscription>();
const statusListeners = new Set<StatusListener>();

let source: EventSource | null = null;
let status: SpineStatus = 'idle';
/**
 * Highest seq this window has seen.
 *
 * Kept so the FIRST connect of a session can ask for everything after it
 * — which matters when the module is torn down and rebuilt (HMR, a route
 * that unmounts every consumer) without the tab reloading.
 */
let lastSeq = 0;

function setStatus(next: SpineStatus): void {
  if (status === next) return;
  status = next;
  for (const fn of statusListeners) {
    try { fn(status, lastSeq); } catch { /* a listener's failure is its own */ }
  }
}

function deliver(event: AuraEvent): void {
  if (event.seq > lastSeq) lastSeq = event.seq;
  for (const sub of subscriptions) {
    if (sub.topics !== '*' && !sub.topics.includes(event.topic)) continue;
    try { sub.listener(event); } catch { /* one bad consumer must not stop the rest */ }
  }
}

function ensureConnected(): void {
  if (source || typeof EventSource === 'undefined') return;
  setStatus('connecting');
  /* Subscribe to every topic on the wire and filter per-consumer here.
     One connection carrying everything is cheaper than one connection per
     interested screen, and the filter is a string compare. */
  const es = new EventSource(`${BASE}/events/stream?after=${lastSeq}`);
  source = es;

  es.onopen = () => setStatus('open');
  es.onerror = () => {
    /* EventSource reconnects on its own, resending Last-Event-ID. Report
       the drop so any fallback poll can take over, and do NOT close the
       source — closing it is what would turn a blip into a dead channel. */
    if (es.readyState === EventSource.CLOSED) {
      source = null;
      setStatus('closed');
      return;
    }
    setStatus('connecting');
  };
  /* Records arrive with `event:` set to their own type, so `onmessage`
     (which only fires for unnamed events) would never see them. */
  es.addEventListener('subscribed', () => setStatus('open'));
  const onAny = (e: MessageEvent) => {
    try {
      const parsed = JSON.parse(e.data) as AuraEvent;
      if (typeof parsed?.seq === 'number' && typeof parsed?.topic === 'string') deliver(parsed);
    } catch { /* a malformed frame is dropped, not fatal */ }
  };
  /* One listener per event name the service can emit. Named rather than
     wildcard because the DOM has no wildcard: the service's `type` values
     are a closed set, listed here so an unhandled one is a visible
     omission rather than silence. */
  for (const name of KNOWN_EVENT_TYPES) es.addEventListener(name, onAny as EventListener);
}

/**
 * Every `type` the service publishes. Kept in sync with
 * `packages/ai-service/src/events/*` and the publish sites in
 * `server.ts`; `spine-verify` asserts the two agree.
 */
export const KNOWN_EVENT_TYPES = [
  'fabric.invocation.requested',
  'fabric.invocation.denied',
  'fabric.invocation.started',
  'fabric.invocation.retrying',
  'fabric.invocation.completed',
  'fabric.verification.passed',
  'fabric.verification.failed',
  'approval.required',
  'approval.granted',
  'approval.denied',
  'workspace.index',
  'workspace.engineering-event',
  'workspace.engineering-purged',
  'mission.execution',
  'mission.error',
  'automation.run',
  'automation.log',
  'automation.done',
  'agent.campaign',
  'agent.timeline',
  'agent.enabled',
  'provider.route',
  'provider.health',
] as const;

/** Subscribe to the spine. Connects on first subscriber; returns unsubscribe. */
export function subscribeToSpine(topics: readonly EventTopic[] | '*', listener: Listener): () => void {
  const sub: Subscription = { topics, listener };
  subscriptions.add(sub);
  ensureConnected();
  return () => {
    subscriptions.delete(sub);
    /* The connection is deliberately NOT closed when the last consumer
       leaves: `lastSeq` would then stop advancing and the next subscriber
       would replay a backlog it does not want. The channel is cheap and
       lives as long as the window does. */
  };
}

export function onSpineStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(status, lastSeq);
  return () => { statusListeners.delete(listener); };
}

export function spineStatus(): SpineStatus { return status; }
export function spineLastSeq(): number { return lastSeq; }

/** Explicit teardown. Only tests and a full window teardown need this. */
export function closeSpine(): void {
  source?.close();
  source = null;
  setStatus('closed');
}

/** One-shot backlog read. Used by callers that need history, not a live feed. */
export async function replaySpine(after = 0, topics?: readonly EventTopic[], limit?: number): Promise<{
  events: AuraEvent[]; truncated: boolean; earliest: number; head: number;
}> {
  const params = new URLSearchParams({ after: String(after) });
  if (topics?.length) params.set('topics', topics.join(','));
  if (limit) params.set('limit', String(limit));
  const res = await fetch(`${BASE}/events/replay?${params.toString()}`);
  if (!res.ok) throw new Error(`replay failed: HTTP ${res.status}`);
  return res.json() as Promise<{ events: AuraEvent[]; truncated: boolean; earliest: number; head: number }>;
}
