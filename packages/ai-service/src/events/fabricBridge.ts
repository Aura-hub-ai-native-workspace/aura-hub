/**
 * fabricBridge — the spine becomes the Fabric's first real subscriber.
 * ==================================================================
 * `CapabilityFabric.on()` has existed since the Fabric was written and
 * had **zero** subscribers: every `FabricEvent` was emitted into an empty
 * set. No new emitter is added here — this is the consumer that emitter
 * was always waiting for.
 *
 * Two rules govern the translation:
 *
 *   1. **No invocation input crosses onto the spine.** A `FabricEvent`
 *      of type `invocation.requested` carries the whole `Invocation`,
 *      arguments included. The spine is a stream anything on the loopback
 *      port can read, so it carries identity and outcome — ids, capability,
 *      actor, risk, decision — and never arguments. The Fabric's own
 *      `AuditRecord` remains the place a bounded, redacted argument
 *      summary lives.
 *
 *      The one exception is an `ApprovalRequest`, which is forwarded whole
 *      because its `items[].detail` is *already* the Fabric's bounded,
 *      redacted `summarizeInput()` output, and it is already served
 *      verbatim on `GET /fabric/approvals`. Forwarding it adds no
 *      exposure and is the entire point of the channel: a person cannot
 *      answer a question they have not been shown.
 *
 *   2. **Approvals get their own topic.** Everything else is `fabric`.
 *      A renderer that only wants to know when it must interrupt the user
 *      subscribes to `approval` and receives nothing else.
 */

import type { FabricEvent } from '@aura/capability-fabric';
import type { EventInput } from './types';
import type { EventSpine } from './spine';

export function fabricEventToInput(event: FabricEvent): EventInput {
  switch (event.type) {
    case 'invocation.requested':
      return {
        topic: 'fabric',
        type: 'fabric.invocation.requested',
        projectId: event.invocation.context.projectId,
        at: event.at,
        payload: {
          invocationId: event.invocation.id,
          capabilityId: event.invocation.capabilityId,
          actor: event.invocation.context.actor,
          missionId: event.invocation.context.missionId ?? null,
          taskId: event.invocation.context.taskId ?? null,
          nodeId: event.invocation.node?.id ?? null,
        },
      };

    case 'invocation.denied':
      return {
        topic: 'fabric',
        type: 'fabric.invocation.denied',
        at: event.at,
        payload: { invocationId: event.invocationId, reason: event.reason },
      };

    case 'invocation.started':
      return {
        topic: 'fabric',
        type: 'fabric.invocation.started',
        at: event.at,
        payload: { invocationId: event.invocationId, capabilityId: event.capabilityId },
      };

    case 'invocation.retrying':
      return {
        topic: 'fabric',
        type: 'fabric.invocation.retrying',
        at: event.at,
        payload: { invocationId: event.invocationId, attempt: event.attempt, reason: event.reason },
      };

    case 'invocation.completed':
      return {
        topic: 'fabric',
        type: 'fabric.invocation.completed',
        at: event.at,
        payload: {
          invocationId: event.result.invocationId,
          capabilityId: event.result.capabilityId,
          outcome: event.result.outcome,
          detail: event.result.detail,
          durationMs: event.result.durationMs,
          attempts: event.result.attempts,
          verified: event.result.verification.passed,
          decision: event.result.policy.decision,
          rule: event.result.policy.rule,
          approvalId: event.result.approvalId ?? null,
        },
      };

    case 'verification.passed':
    case 'verification.failed':
      return {
        topic: 'fabric',
        type: `fabric.${event.type}`,
        at: event.at,
        payload: { invocationId: event.invocationId, detail: event.detail },
      };

    case 'approval.required':
      return {
        topic: 'approval',
        type: 'approval.required',
        projectId: event.request.projectId ?? null,
        at: event.at,
        payload: { request: event.request },
      };

    case 'approval.granted':
    case 'approval.denied':
      return {
        topic: 'approval',
        type: `approval.${event.type === 'approval.granted' ? 'granted' : 'denied'}`,
        at: event.at,
        payload: { requestId: event.requestId },
      };
  }
}

/**
 * Attach the spine to a Fabric. Returns the unsubscribe function the
 * Fabric's `on()` already hands back, so a host can detach cleanly.
 */
export function bridgeFabricEvent(fabric: { on(listener: (e: FabricEvent) => void): () => void }, spine: EventSpine): () => void {
  return fabric.on((event) => {
    try {
      spine.publish(fabricEventToInput(event));
    } catch {
      // A failed append must not take down an execution already in flight.
      // The Fabric's own audit log is unaffected — it is a separate
      // authority and this is not its write path.
    }
  });
}
