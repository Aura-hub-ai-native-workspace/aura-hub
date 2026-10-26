/**
 * chatEvents — fold the chat pipeline's real events into what the person sees.
 * ------------------------------------------------------------------
 * Every row a person watches while an answer is made is the trace of an event
 * the backend actually emitted: the intent it recognised, the saved context it
 * read, the web search it ran and what that returned, the model it asked, the
 * tokens as they arrive. Nothing here is timed, guessed or replayed from a
 * finished answer. Unknown events are ignored rather than narrated.
 */
import type { AgentEventFrame, ChatResearch, ChatSource } from './centralAgentClient';

export interface ChatStep { key: string; label: string; detail?: string; tone?: 'ok' | 'warn' | 'info' }

export interface LiveTurn {
  steps: ChatStep[];
  answer: string;
  sources: ChatSource[];
  cited: number[];
  research: Pick<ChatResearch, 'status' | 'detail' | 'kind'> | null;
  failed: string | null;
}

export const EMPTY_TURN: LiveTurn = { steps: [], answer: '', sources: [], cited: [], research: null, failed: null };

const INTENT_LABEL: Record<string, string> = {
  'general-question': 'a question', 'research-question': 'a question that needs research',
  'idea-exploration': 'an idea to develop', 'new-project-creation': 'starting a project',
  'plan-generation': 'a request for a plan', 'direct-workspace-execution': 'a request to change files',
  'task-status': 'a question about progress', 'environment-query': 'a question about this machine',
  'project-improvement': 'improving the project', 'error-recovery': 'continuing earlier work',
  'plan-editing': 'editing a plan', 'planner-handoff': 'running a plan', 'workflow-worthy-task': 'multi-stage work',
  'needs-clarification': 'unclear',
};

const REASON: Record<string, string> = {
  'not-configured': 'no search gateway is configured',
  timeout: 'the search gateway did not answer in time',
  refused: 'the search gateway refused the request',
  failed: 'the search could not run',
};

function put(steps: ChatStep[], step: ChatStep): ChatStep[] {
  const i = steps.findIndex((s) => s.key === step.key);
  return i < 0 ? [...steps, step] : steps.map((s, n) => (n === i ? step : s));
}

export function foldChatEvent(turn: LiveTurn, frame: AgentEventFrame): LiveTurn {
  const p = frame.payload as Record<string, unknown>;
  switch (frame.type) {
    case 'intent.classified': {
      const intent = String(p.intent ?? '');
      return { ...turn, steps: put(turn.steps, { key: 'intent', label: `Understood as ${INTENT_LABEL[intent] ?? intent}`, tone: 'info' }) };
    }
    case 'context.retrieved': {
      const n = Number(p.records ?? 0);
      return { ...turn, steps: put(turn.steps, {
        key: 'context',
        label: n > 0 ? `Read ${n} saved note${n === 1 ? '' : 's'} on this ${p.scope === 'general' ? 'conversation' : 'project'}` : 'No saved context yet',
        tone: 'info',
      }) };
    }
    case 'research.started':
      return { ...turn, steps: put(turn.steps, { key: 'research', label: 'Searching the web', detail: String(p.reason ?? ''), tone: 'info' }) };
    case 'research.sources': {
      const rows = Array.isArray(p.sources) ? (p.sources as ChatSource[]) : [];
      return { ...turn, sources: rows.filter((s) => typeof s.url === 'string') };
    }
    case 'research.completed': {
      const status = String(p.status ?? 'failed') as ChatResearch['status'];
      const kind = p.kind as ChatResearch['kind'];
      const n = Number(p.count ?? 0);
      const label = status === 'ok' ? `Found ${n} source${n === 1 ? '' : 's'}`
        : status === 'empty' ? 'The search found nothing'
          : status === 'cancelled' ? 'Search stopped'
            : `Web research unavailable${kind && REASON[kind] ? ` — ${REASON[kind]}` : ''}`;
      return {
        ...turn,
        research: { status, detail: String(p.detail ?? ''), kind },
        steps: put(turn.steps, { key: 'research', label, tone: status === 'ok' ? 'ok' : 'warn' }),
      };
    }
    case 'model.invoked': {
      const providers = Array.isArray(p.providers) ? (p.providers as { id?: string; model?: string }[]) : [];
      const first = providers[0];
      return { ...turn, steps: put(turn.steps, {
        key: 'model',
        label: first ? `Asking ${first.model || first.id}` : 'No reasoning model is configured',
        tone: first ? 'info' : 'warn',
      }) };
    }
    case 'answer.token':
      return { ...turn, answer: turn.answer + String(p.text ?? '') };
    case 'answer.citations':
      return { ...turn, cited: Array.isArray(p.cited) ? (p.cited as number[]) : [] };
    case 'answer.failed':
    case 'agent.failed':
      return { ...turn, failed: String(p.reason ?? 'The answer could not be completed.') };
    default:
      return turn;
  }
}

/**
 * Turn `[n]` in an answer into links to the real sources. A marker with no
 * matching source is left as plain text — never given a URL it does not have.
 */
export function linkCitations(text: string, sources: { id: number; url: string }[]): string {
  const byId = new Map(sources.map((s) => [s.id, s.url] as const));
  return text.replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => {
    const url = byId.get(Number(n));
    return url ? `[${n}](${url})` : m;
  });
}
