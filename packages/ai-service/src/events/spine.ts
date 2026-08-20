/**
 * EventSpine — one stream, many publishers, replayable from an offset.
 * ==================================================================
 * `publish()` does three things in one indivisible order:
 *
 *   1. assign the next `seq` and write the record durably,
 *   2. hand it to every in-process subscriber whose filter matches,
 *   3. return it.
 *
 * Durable-before-delivered is deliberate. A subscriber that reacts to an
 * event the log never received would be acting on something that, after a
 * crash, never happened.
 *
 * The spine has no opinion about what an event *means*. Subsystems keep
 * their own listener sets for their own internal use; the spine is what
 * makes those events leave the process.
 */

import { DurableEventLog, type EventLogOptions } from './log';
import type { AuraEvent, EventInput, EventListener, ReplayResult, TopicFilter } from './types';
import { matchesFilter } from './types';

interface Subscription {
  filter: TopicFilter;
  listener: EventListener;
}

export class EventSpine {
  private readonly log: DurableEventLog;
  private readonly subscriptions = new Set<Subscription>();
  private closed = false;

  constructor(logOrOptions: DurableEventLog | EventLogOptions = {}) {
    this.log = logOrOptions instanceof DurableEventLog ? logOrOptions : new DurableEventLog(logOrOptions);
  }

  publish<P>(input: EventInput<P>): AuraEvent<P> {
    if (this.closed) throw new Error('EventSpine is closed');
    const event = this.log.append(input);
    for (const sub of this.subscriptions) {
      if (!matchesFilter(sub.filter, event.topic)) continue;
      // One bad subscriber must not stop the next one from being told, and
      // must never fail the publisher: the event is already durable, so the
      // only thing a throw here could do is lose a delivery it cannot undo.
      try { sub.listener(event); } catch { /* subscriber errors are its own problem */ }
    }
    return event;
  }

  subscribe(filter: TopicFilter, listener: EventListener): () => void {
    const sub: Subscription = { filter, listener };
    this.subscriptions.add(sub);
    return () => { this.subscriptions.delete(sub); };
  }

  /** Records after `afterSeq`. See `DurableEventLog.replay`. */
  replay(afterSeq: number, filter: TopicFilter = '*', limit?: number): ReplayResult {
    return this.log.replay(afterSeq, filter, limit);
  }

  head(): number { return this.log.head(); }
  earliest(): number { return this.log.earliest(); }
  subscriberCount(): number { return this.subscriptions.size; }

  close(): void {
    this.closed = true;
    this.subscriptions.clear();
    this.log.close();
  }
}
