/**
 * Event Spine — the typed vocabulary of "something happened".
 * ==================================================================
 * Before this file, AURA had three isolated in-process listener sets
 * (`capability-fabric/src/fabric.ts`, `ai-service/src/automation.ts`,
 * `mission/execution/engine.ts`) and exactly one cross-subsystem
 * subscription between them. Nothing the backend learned could reach the
 * person sitting in front of the window except by that window asking
 * again, on a timer.
 *
 * The spine is one durable, ordered, replayable stream. Every subsystem
 * publishes into it; one SSE channel carries it to the renderer.
 *
 * What it is NOT
 * --------------
 * It is **not** the governance journal. The Fabric's `AuditRecord` is the
 * record of *decisions* — what was permitted, on whose authority, and
 * whether it worked; it is the answer to a compliance question and it is
 * written by the Fabric alone. The spine records *events* — the fact that
 * a thing happened, in order, so a late or reconnecting reader can catch
 * up. A spine record derived from a Fabric event carries the invocation
 * id, never a second copy of the decision. See HANDOFF.md.
 *
 * No Node, no HTTP, no React in this file: it is the contract both sides
 * of the wire agree on.
 */

/**
 * Topics are coarse on purpose. A subscriber filters by topic (cheap,
 * stable) and then by `type` if it cares (specific, may grow). Adding a
 * new `type` is a routine change; adding a topic is a design decision.
 */
export type EventTopic =
  /** Governed execution: an invocation was requested, ran, or failed. */
  | 'fabric'
  /** A human must answer something. The reason the spine exists. */
  | 'approval'
  /** Mission Control: plan, wave and task lifecycle. */
  | 'mission'
  /** Automation rules firing and their runs. */
  | 'automation'
  /** Project/index lifecycle — what `useWorkspace` used to poll for. */
  | 'workspace'
  /** The autonomous engineering agent's campaign lifecycle. */
  | 'agent'
  /** Model provider health and routing decisions. */
  | 'provider';

export const EVENT_TOPICS: readonly EventTopic[] = [
  'fabric', 'approval', 'mission', 'automation', 'workspace', 'agent', 'provider',
] as const;

export function isEventTopic(value: string): value is EventTopic {
  return (EVENT_TOPICS as readonly string[]).includes(value);
}

/**
 * One record on the spine.
 *
 * `seq` is assigned by the log, is strictly increasing, starts at 1, and
 * survives a restart. It is the offset a reader replays from, and the id
 * an SSE client sends back as `Last-Event-ID`. Nothing else in AURA is
 * allowed to mint it.
 */
export interface AuraEvent<P = unknown> {
  seq: number;
  /** Stable identity independent of position. Useful for de-duplication. */
  id: string;
  at: string;
  topic: EventTopic;
  /** Dotted and namespaced by topic: `approval.required`, `workspace.index`. */
  type: string;
  /** Null for machine-wide events (provider health, environment scans). */
  projectId: string | null;
  payload: P;
}

/** What a publisher supplies. Everything else the log fills in. */
export interface EventInput<P = unknown> {
  topic: EventTopic;
  type: string;
  projectId?: string | null;
  payload: P;
  /** Override the timestamp. Only replay/migration should ever pass this. */
  at?: string;
}

/**
 * The answer to "give me everything after N".
 *
 * `truncated` is the honest part: retention is finite, so a reader that
 * has been away longer than the log keeps records must be told that its
 * offset fell off the back rather than being handed a silently-incomplete
 * stream. `earliest` says where the log actually starts now.
 */
export interface ReplayResult {
  events: AuraEvent[];
  truncated: boolean;
  earliest: number;
  head: number;
}

export type EventListener = (event: AuraEvent) => void;

/** `'*'` means every topic, including topics added after the subscription. */
export type TopicFilter = readonly EventTopic[] | '*';

export function matchesFilter(filter: TopicFilter, topic: EventTopic): boolean {
  return filter === '*' || filter.includes(topic);
}
