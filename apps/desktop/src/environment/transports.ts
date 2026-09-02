/**
 * transports — the desktop's implementation of the domain's I/O port.
 * ==================================================================
 * `NodeTransport` is the single seam through which the Connected
 * Environment touches the outside world. The desktop satisfies it by
 * delegating to the local service, which owns the actual process and
 * network access (see packages/ai-service/src/environment.ts).
 *
 * `execute` is deliberately absent. Probing a tool is safe and bounded;
 * *driving* one is a much larger surface — argument construction, working
 * directories, output streaming, cancellation, and a permission check per
 * action. Declaring the method and not implementing it is the honest
 * state of the system: the orchestrator can see that no node accepts
 * execution yet, and says so, rather than pretending work was dispatched.
 *
 * Adding a real executor is additive: implement `execute` here (or in a
 * second transport registered for one node kind), and every mission that
 * routes to that node starts running without any change to the planner,
 * orchestrator, registry or UI.
 */

import type { CatalogEntry, NodeTransport, ProbeResult, TransportKind } from '@aura/connected-environment';
import { environmentClient } from './environmentClient';

/**
 * One transport covers every kind because the service already dispatches
 * on `entry.transport` server-side. Splitting it here would duplicate
 * that decision in two places and let them drift.
 */
function serviceTransport(kind: TransportKind): NodeTransport {
  return {
    kind,
    probe: (entry: CatalogEntry) => environmentClient.probe(entry.id, false),
    connect: async (entry: CatalogEntry): Promise<ProbeResult> => {
      if (entry.transport === 'internal') {
        return { present: true, detail: 'Built into AURA Hub — nothing to connect.' };
      }
      // A connect is a probe the user asked for, so it always bypasses the
      // service's short probe cache: someone who just installed a tool
      // must not be told it is still missing.
      return environmentClient.probe(entry.id, true);
    },
  };
}

const TRANSPORTS: Record<TransportKind, NodeTransport> = {
  internal: serviceTransport('internal'),
  'local-process': serviceTransport('local-process'),
  http: serviceTransport('http'),
  'api-key': serviceTransport('api-key'),
  oauth: serviceTransport('oauth'),
};

export function transportFor(entry: CatalogEntry): NodeTransport {
  return TRANSPORTS[entry.transport];
}
