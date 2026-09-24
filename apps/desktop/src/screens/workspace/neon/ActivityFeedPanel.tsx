import { Icon } from '@aura/ui';
import type { AgentEventFrame } from '../../../ai/centralAgentClient';

/**
 * ActivityFeedPanel — bounded live event feed from the Central Agent.
 *
 * Shows the most recent FEED_CAP events. Every row is a real
 * AgentEventFrame from the existing SSE bus — nothing is invented,
 * inferred or polled. When there are no events, the panel does not
 * render at all rather than showing a placeholder.
 *
 * Performance: capped list + key-by-seq means React diffs a fixed-size
 * array, not an unbounded one. The parent already caps events at 400.
 */

const FEED_CAP = 20;

const EVENT_LABEL: Record<string, string> = {
  'session.started':            'Session started',
  'intent.compiled':            'Intent compiled',
  'intent.clarification-needed':'Clarification needed',
  'plan.created':               'Plan created',
  'capability.discovery':       'Capability discovery',
  'authority.checked':          'Authority checked',
  'workflow.compiled':          'Workflow compiled',
  'workflow.validated':         'Workflow validated',
  'execution.started':          'Execution started',
  'invocation.observed':        'Invocation',
  'approval.required':          'Approval required',
  'approval.invalidated':       'Approval invalidated',
  'verification.completed':     'Verification',
  'result.ready':               'Result ready',
  'agent.failed':               'Agent failed',
  'agent.cancelled':            'Agent cancelled',
  'worker.action':              'Worker action',
  'worker.lifecycle':           'Worker',
  'worker.terminated':          'Worker terminated',
  'answer.started':             'Answer started',
  'answer.completed':           'Answer done',
  'answer.failed':              'Answer failed',
  'run.cancellation-requested': 'Stop requested',
  'run.stopping':               'Stopping',
  'run.cancelled':              'Stopped',
};

function relTime(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  if (ms < 2000) return 'now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

function eventDetail(frame: AgentEventFrame): string {
  const p = frame.payload;
  if (!p) return '';
  switch (frame.type) {
    case 'plan.created': {
      const n = Array.isArray(p.plan) ? p.plan.length : null;
      return n != null ? `${n} task${n === 1 ? '' : 's'}` : '';
    }
    case 'invocation.observed':
      return [p.taskId, p.state].filter(Boolean).join(' → ') as string;
    case 'worker.lifecycle':
      return [p.worker ?? p.nodeId, p.lifecycle].filter(Boolean).join(' ') as string;
    case 'worker.action':
      return [p.tool ?? p.actionType, p.decision].filter(Boolean).join(' ') as string;
    case 'verification.completed':
      return typeof p.passed === 'boolean' ? (p.passed ? 'passed' : 'failed') : '';
    case 'approval.required':
      return typeof p.approvalId === 'string' ? p.approvalId.slice(0, 18) : '';
    case 'agent.failed':
      return typeof p.reason === 'string' ? p.reason.slice(0, 40) : '';
    default:
      return '';
  }
}

export function ActivityFeedPanel({ events }: { events: AgentEventFrame[] }) {
  const visible = events.slice(-FEED_CAP).reverse();
  if (visible.length === 0) return null;

  return (
    <section
      data-testid="activity-feed-panel"
      aria-label="Live activity feed"
      className="rounded-xl border border-[rgba(125,146,255,0.18)] bg-[rgba(13,19,38,0.55)]"
    >
      <div className="flex items-center gap-2 border-b border-[rgba(125,146,255,0.12)] px-4 py-2">
        <Icon name="activity" size={11} className="shrink-0 text-text-subtle" />
        <span className="text-[10.5px] font-semibold uppercase tracking-widest text-text-subtle">
          Activity
        </span>
        <span className="ml-auto text-[9.5px] tabular-nums text-text-subtle">
          {events.length}
        </span>
      </div>
      <ol className="max-h-44 space-y-px overflow-y-auto px-3 py-2">
        {visible.map((frame, i) => {
          const label = EVENT_LABEL[frame.type] ?? frame.type;
          const detail = eventDetail(frame);
          const time = relTime(frame.at);
          return (
            <li
              key={frame.seq != null ? frame.seq : `${i}-${frame.type}`}
              data-testid="activity-feed-row"
              data-event-type={frame.type}
              className="flex items-baseline gap-2 py-0.5"
            >
              <span className="w-32 shrink-0 truncate text-[10px] font-medium text-text-muted">
                {label}
              </span>
              {detail ? (
                <span className="min-w-0 flex-1 truncate text-[10px] text-text-subtle">
                  {detail}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {time && (
                <span className="shrink-0 text-[9px] tabular-nums text-text-subtle">
                  {time}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
