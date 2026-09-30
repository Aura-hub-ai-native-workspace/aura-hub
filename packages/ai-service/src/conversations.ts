/**
 * Scoped conversations — project Ask AURA vs Workspace Execution chat.
 * ==================================================================
 * There are exactly two conversation families, and they never mix:
 *
 *   project   · kind=ask_aura   · plans, decisions and understanding
 *                               · one file family: `conversations/<projectId>.json`
 *                               · these are the threads the project surface
 *                                 has always shown — the legacy path is kept
 *                                 byte-identical so nothing is re-homed.
 *
 *   workspace · kind=execution  · "do the work" threads with real governed
 *                                 execution behind them
 *                               · a SEPARATE file family:
 *                                 `conversations-workspace/<workspaceId>.json`
 *                               · never readable through the project routes,
 *                                 and the project routes are never readable
 *                                 through the workspace routes.
 *
 * Records written before scopes existed carry neither field. Migration is
 * read-time and idempotent: the FILE a record was found in is the authority
 * for what it is — a record in the project file is a project conversation,
 * a record in the workspace file is a workspace conversation. A record that
 * names a foreign owner (a project id that is not this file's project) is
 * re-homed to the file's owner, because the file, not the record, decides
 * where a conversation lives. Re-running it changes nothing: every field it
 * stamps is either absent or already equal.
 */

import type { ConversationTurn } from '@aura/intelligence';
import { homePath, readJsonFile, writeJsonFile } from './persist';

export type ConversationScope = 'project' | 'workspace';
export type ConversationKind = 'ask_aura' | 'execution';

export interface ConvMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** Optional generation metadata (engines, usage, latency, citations). */
  meta?: unknown;
  error?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConvMessage[];
  /** Which surface owns the thread. Stamped by read-time migration. */
  scope?: ConversationScope;
  /** What the thread is for. Stamped by read-time migration. */
  kind?: ConversationKind;
  /** Owning project. Project threads always; workspace threads name the project they work in. */
  projectId?: string;
  /** Owning workspace (`workspace:<projectId>`). Workspace threads only. */
  workspaceId?: string;
  /** True when the thread was archived rather than deleted. */
  archived?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  scope?: ConversationScope;
  kind?: ConversationKind;
}

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * Read-time, idempotent migration. `owner` describes the file the record
 * was read from — the authority for what the record is. Fields already
 * correct are left untouched, so re-migrating a migrated record is a no-op
 * and re-writing the file changes nothing the second time.
 */
export function migrateConversation(
  raw: Conversation,
  owner: { scope: ConversationScope; kind: ConversationKind; projectId: string; workspaceId?: string },
): Conversation {
  const c: Conversation = { ...raw, scope: owner.scope, kind: owner.kind, projectId: owner.projectId };
  if (owner.workspaceId) c.workspaceId = owner.workspaceId;
  else delete c.workspaceId;
  return c;
}

/**
 * Drop records that are not usable conversations. A corrupt entry (no id,
 * no messages array) is discarded at read time rather than crashing every
 * later op — the file's usable records survive; the broken one is gone.
 */
function isUsable(c: Conversation | undefined): c is Conversation {
  return !!c && typeof c.id === 'string' && Array.isArray(c.messages);
}

/**
 * One file = one owner = one scope. Every operation first proves the record
 * it is about to touch is INSIDE this store's scope (`owns`), so a workspace
 * id handed to a project store (or the reverse) can never read, rename,
 * append to or delete anything. The guard is the whole isolation story:
 * the routes cannot bypass it because they only see these classes.
 */
abstract class ConversationFileStore {
  protected items: Conversation[];
  protected dirty = false;

  protected constructor(
    protected readonly owner: { scope: ConversationScope; kind: ConversationKind; projectId: string; workspaceId?: string },
    file: string,
  ) {
    const raw = readJsonFile<Conversation[]>(file, []);
    this.items = raw
      .map((c) => (isUsable(c) ? migrateConversation(c, owner) : null))
      .filter((c): c is Conversation => c !== null);
    // Migration is read-time: stamping now and writing back once is how the
    // on-disk records catch up. Only write when something actually changed,
    // so opening a fully-migrated file never touches the disk.
    this.dirty = raw.length !== this.items.length
      || raw.some((c, i) => !isUsable(c) || JSON.stringify(c) !== JSON.stringify(this.items[i]));
  }

  /** Persist migrated state once, after the constructor's read completed. */
  protected flushMigration(): void {
    if (this.dirty) {
      this.dirty = false;
      this.save();
    }
  }

  protected abstract file(): string;

  protected save(): void {
    writeJsonFile(this.file(), this.items);
  }

  /** Does this conversation belong to THIS store's scope and owner? */
  protected owns(c: Conversation | undefined): c is Conversation {
    if (!c) return false;
    if (c.scope !== this.owner.scope) return false;
    if (c.projectId !== this.owner.projectId) return false;
    if (this.owner.workspaceId !== undefined && c.workspaceId !== this.owner.workspaceId) return false;
    return true;
  }

  private find(id: string): Conversation | undefined {
    const c = this.items.find((x) => x.id === id);
    // Not "not found" — found-but-foreign IS a miss. The caller cannot tell
    // the difference, which is the point: a foreign id behaves exactly like
    // a nonexistent one.
    return this.owns(c) ? c : undefined;
  }

  private summary(c: Conversation): ConversationSummary {
    const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
    return {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      preview: (lastUser?.content ?? '').slice(0, 80),
      scope: c.scope,
      kind: c.kind,
    };
  }

  /** Conversation summaries, most-recently-updated first. */
  list(): ConversationSummary[] {
    this.flushMigration();
    return [...this.items]
      .filter((c) => !c.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => this.summary(c));
  }

  get(id: string): Conversation | undefined {
    this.flushMigration();
    const c = this.find(id);
    return c ? { ...c, messages: [...c.messages] } : undefined;
  }

  create(title?: string): Conversation {
    this.flushMigration();
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: genId(this.owner.kind === 'execution' ? 'wconv' : 'conv'),
      title: (title?.trim() || 'New conversation').slice(0, 120),
      createdAt: now, updatedAt: now, messages: [],
      scope: this.owner.scope, kind: this.owner.kind,
      projectId: this.owner.projectId,
      ...(this.owner.workspaceId ? { workspaceId: this.owner.workspaceId } : {}),
    };
    this.items.unshift(conv);
    this.save();
    return conv;
  }

  rename(id: string, title: string): Conversation | undefined {
    this.flushMigration();
    const c = this.find(id);
    if (!c) return undefined;
    c.title = title.trim().slice(0, 120) || c.title;
    c.updatedAt = new Date().toISOString();
    this.save();
    return { ...c, messages: [...c.messages] };
  }

  remove(id: string): boolean {
    this.flushMigration();
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length !== before) { this.save(); return true; }
    return false;
  }

  /** Append a message; first user message auto-titles the conversation. */
  append(id: string, msg: { role: 'user' | 'assistant'; content: string; meta?: unknown; error?: boolean }): ConvMessage | undefined {
    this.flushMigration();
    const c = this.find(id);
    if (!c) return undefined;
    const m: ConvMessage = { id: genId('msg'), role: msg.role, content: msg.content, at: new Date().toISOString(), meta: msg.meta, error: msg.error };
    c.messages.push(m);
    c.updatedAt = m.at;
    if (msg.role === 'user' && c.title === 'New conversation') {
      c.title = msg.content.slice(0, 60) + (msg.content.length > 60 ? '…' : '');
    }
    this.save();
    return m;
  }

  /**
   * Removes the conversation's trailing assistant message — used by
   * "Regenerate" to replace a discarded answer instead of leaving it
   * persisted underneath the new one. No-op if the conversation has no
   * messages or its last message isn't from the assistant, so it can
   * never remove a user turn.
   */
  removeLastAssistant(id: string): boolean {
    this.flushMigration();
    const c = this.find(id);
    if (!c) return false;
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== 'assistant') return false;
    c.messages.pop();
    c.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** Recent turns as kernel history (last `n` messages of a conversation). */
  history(id: string, n = 8): ConversationTurn[] {
    const c = this.find(id);
    if (!c) return [];
    return c.messages.slice(-n).map((m) => ({ role: m.role, content: m.content, at: new Date(m.at).getTime() }));
  }

  count(): number {
    this.flushMigration();
    return this.items.filter((c) => !c.archived).length;
  }
}

/* ── Project conversations (scope=project, kind=ask_aura) ──────────── */

const PROJECT_FILE = (projectId: string) => homePath('conversations', `${projectId}.json`);

export class ProjectConversations extends ConversationFileStore {
  constructor(projectId: string) {
    super({ scope: 'project', kind: 'ask_aura', projectId }, PROJECT_FILE(projectId));
  }
  protected file(): string {
    return PROJECT_FILE(this.owner.projectId);
  }
}

/* ── Workspace conversations (scope=workspace, kind=execution) ─────── */

const WORKSPACE_FILE = (workspaceId: string) => homePath('conversations-workspace', `${workspaceId}.json`);

/**
 * The workspace's own execution threads. Stored in a DIFFERENT directory
 * from project conversations, so the two families cannot collide even at
 * the file level. `workspaceId` is `workspace:<projectId>`; the owning
 * project is derived from it and every record is stamped with both.
 */
export class WorkspaceConversations extends ConversationFileStore {
  readonly workspaceId: string;

  constructor(workspaceId: string, projectId?: string) {
    // The id is the authority for what it names: `workspace:<projectId>`.
    const fromId = workspaceId.startsWith('workspace:') ? workspaceId.slice('workspace:'.length) : workspaceId;
    if (!fromId) throw new Error(`workspace id "${workspaceId}" does not name a project`);
    // A caller claiming the workspace belongs to a DIFFERENT project is a
    // bug, not a re-pointing: silently accepting it would file one
    // project's execution threads under another project's workspace.
    if (projectId !== undefined && projectId !== fromId) {
      throw new Error(`workspace "${workspaceId}" belongs to project "${fromId}"`);
    }
    const pid = projectId ?? fromId;
    super({ scope: 'workspace', kind: 'execution', projectId: pid, workspaceId }, WORKSPACE_FILE(workspaceId));
    this.workspaceId = workspaceId;
  }

  protected file(): string {
    return WORKSPACE_FILE(this.workspaceId);
  }
}
