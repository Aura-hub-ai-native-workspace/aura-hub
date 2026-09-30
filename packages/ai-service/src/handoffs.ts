/**
 * Handoffs — the controlled bridge from Project Ask AURA to the workspace.
 * ==================================================================
 * "Send to Workspace" is the ONLY sanctioned way a project discussion
 * becomes workspace execution. A handoff records exactly what crossed:
 * which conversation, which messages (by id — never a copy of the text
 * that could drift), a one-line task statement, and where it went.
 *
 * Handoffs live in their own file family (`handoffs/<projectId>.json`),
 * keyed by the SOURCE project, because a handoff is created from a
 * project's Ask AURA thread and its lifecycle is that project's record.
 * The workspace reads them through the same id space — there is no
 * second store and no sync step.
 *
 * Status is a small, honest machine:
 *
 *   created ──▶ accepted ──▶ completed
 *      │            │
 *      └────────────┴────────▶ cancelled
 *
 * `created` means offered, nothing more. The workspace only ever SEES a
 * handoff while it is `created` — once accepted, cancelled or completed
 * it has left its inbox. Transitions that the machine does not allow
 * throw; nothing silently rewrites history.
 */

import { homePath, readJsonFile, writeJsonFile } from './persist';

export type HandoffStatus = 'created' | 'accepted' | 'cancelled' | 'completed';

export interface Handoff {
  id: string;
  /** The project whose Ask AURA thread this came from (and whose file holds the record). */
  projectId: string;
  /** Source: the Ask AURA conversation and the exact messages sent, by id. */
  sourceConversationId: string;
  sourceMessageIds: string[];
  /** A one-line task statement, shown in the workspace. */
  title: string;
  /** Optional acceptance criteria / notes composed at send time. */
  notes?: string;
  /** Where it is going: `workspace:<projectId>`. */
  targetWorkspaceId: string;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  /** The workspace execution conversation the task landed in, once accepted. */
  acceptedIntoConversationId?: string;
}

export interface HandoffInput {
  projectId: string;
  sourceConversationId: string;
  sourceMessageIds: string[];
  title: string;
  notes?: string;
  targetWorkspaceId: string;
}

/**
 * What a HandoffStore may consult to prove a source is real. Injected
 * rather than imported so this module stays a pure record-keeper: the
 * caller (the workspace manager) already owns the conversation stores.
 */
export type HandoffSourceReader = (projectId: string, conversationId: string) => { messages: { id: string }[] } | undefined;

const FILE = (projectId: string) => homePath('handoffs', `${projectId}.json`);
const genId = () => `hnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Which transitions the status machine allows. Terminal states allow none. */
const ALLOWED: Record<HandoffStatus, HandoffStatus[]> = {
  created: ['accepted', 'cancelled'],
  accepted: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function isUsable(h: unknown): h is Handoff {
  const x = h as Handoff | undefined;
  return !!x
    && typeof x.id === 'string'
    && typeof x.projectId === 'string'
    && typeof x.sourceConversationId === 'string'
    && Array.isArray(x.sourceMessageIds)
    && typeof x.status === 'string';
}

export class HandoffStore {
  private items: Handoff[];

  constructor(
    private readonly projectId: string,
    private readonly sourceReader?: HandoffSourceReader,
  ) {
    this.items = readJsonFile<Handoff[]>(FILE(projectId), []).filter(isUsable);
  }

  private save(): void {
    writeJsonFile(FILE(this.projectId), this.items);
  }

  private find(id: string): Handoff | undefined {
    return this.items.find((h) => h.id === id && h.projectId === this.projectId);
  }

  get(id: string): Handoff | undefined {
    const h = this.find(id);
    return h ? { ...h } : undefined;
  }

  /**
   * Creates a handoff. When a source reader is wired, the source must be
   * real: the conversation must exist in this project and EVERY named
   * message must be present in it. A handoff that cannot prove what it
   * points at is refused — the workspace would otherwise accept a task
   * whose source can no longer be shown.
   */
  create(input: HandoffInput): Handoff {
    const title = input.title.trim();
    if (!title) throw new Error('a handoff needs a task statement');
    if (!input.sourceMessageIds.length) throw new Error('a handoff needs at least one source message');
    if (!input.targetWorkspaceId.startsWith('workspace:')) {
      throw new Error(`target "${input.targetWorkspaceId}" is not a workspace id`);
    }
    if (this.sourceReader) {
      const conv = this.sourceReader(input.projectId, input.sourceConversationId);
      if (!conv) throw new Error(`source conversation "${input.sourceConversationId}" not found in project "${input.projectId}"`);
      const present = new Set(conv.messages.map((m) => m.id));
      for (const mid of input.sourceMessageIds) {
        if (!present.has(mid)) throw new Error(`source message "${mid}" not found in conversation "${input.sourceConversationId}"`);
      }
    }
    const now = new Date().toISOString();
    const h: Handoff = {
      id: genId(),
      projectId: this.projectId,
      sourceConversationId: input.sourceConversationId,
      sourceMessageIds: [...input.sourceMessageIds],
      title: title.slice(0, 200),
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 2000) } : {}),
      targetWorkspaceId: input.targetWorkspaceId,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
    this.items.unshift(h);
    this.save();
    return { ...h };
  }

  /**
   * Moves a handoff along its machine. Unknown ids return undefined;
   * transitions the machine does not allow throw — the caller decides
   * whether that is a conflict (409) or a bug.
   */
  setStatus(id: string, status: HandoffStatus, patch: Partial<Pick<Handoff, 'acceptedIntoConversationId'>> = {}): Handoff | undefined {
    const h = this.find(id);
    if (!h) return undefined;
    if (!ALLOWED[h.status].includes(status)) {
      throw new Error(`handoff "${id}" cannot move from "${h.status}" to "${status}"`);
    }
    h.status = status;
    h.updatedAt = new Date().toISOString();
    if (status === 'accepted') {
      h.acceptedAt = h.updatedAt;
      if (patch.acceptedIntoConversationId) h.acceptedIntoConversationId = patch.acceptedIntoConversationId;
    }
    if (status === 'completed') h.completedAt = h.updatedAt;
    if (status === 'cancelled') h.cancelledAt = h.updatedAt;
    this.save();
    return { ...h };
  }

  /** Handoffs for this project, newest first, optionally narrowed. */
  list(filter: { targetWorkspaceId?: string; status?: HandoffStatus } = {}): Handoff[] {
    return this.items
      .filter((h) => (filter.targetWorkspaceId ? h.targetWorkspaceId === filter.targetWorkspaceId : true))
      .filter((h) => (filter.status ? h.status === filter.status : true))
      .map((h) => ({ ...h }));
  }
}
