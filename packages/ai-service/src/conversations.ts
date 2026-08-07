/**
 * Project conversations — per-project, persistent AI history.
 * ==================================================================
 * There is NO global chat. Every project owns its own set of
 * conversations, stored on disk at `<home>/conversations/<projectId>.json`
 * and loaded only when that project is open. Opening another project
 * loads that project's conversations; they never mix.
 *
 * Recent turns of the active conversation are fed back into answers as
 * `ConversationTurn[]` history, so the assistant remembers the thread —
 * scoped strictly to the project it belongs to.
 */

import type { ConversationTurn } from '@aura/intelligence';
import { homePath, readJsonFile, writeJsonFile } from './persist';

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
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

const FILE = (projectId: string) => homePath('conversations', `${projectId}.json`);
const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export class ProjectConversations {
  private items: Conversation[];

  constructor(private readonly projectId: string) {
    this.items = readJsonFile<Conversation[]>(FILE(projectId), []);
  }

  private save(): void {
    writeJsonFile(FILE(this.projectId), this.items);
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
    };
  }

  /** Conversation summaries, most-recently-updated first. */
  list(): ConversationSummary[] {
    return [...this.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => this.summary(c));
  }

  get(id: string): Conversation | undefined {
    return this.items.find((c) => c.id === id);
  }

  create(title?: string): Conversation {
    const now = new Date().toISOString();
    const conv: Conversation = { id: genId('conv'), title: (title?.trim() || 'New conversation').slice(0, 120), createdAt: now, updatedAt: now, messages: [] };
    this.items.unshift(conv);
    this.save();
    return conv;
  }

  rename(id: string, title: string): Conversation | undefined {
    const c = this.get(id);
    if (!c) return undefined;
    c.title = title.trim().slice(0, 120) || c.title;
    c.updatedAt = new Date().toISOString();
    this.save();
    return c;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length !== before) { this.save(); return true; }
    return false;
  }

  /** Append a message; first user message auto-titles the conversation. */
  append(id: string, msg: { role: 'user' | 'assistant'; content: string; meta?: unknown; error?: boolean }): ConvMessage | undefined {
    const c = this.get(id);
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
   * persisted underneath the new one (re-opening the conversation would
   * otherwise show both, back-to-back, forever). No-op (returns false)
   * if the conversation has no messages or its last message isn't from
   * the assistant, so it can never remove a user turn.
   */
  removeLastAssistant(id: string): boolean {
    const c = this.get(id);
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
    const c = this.get(id);
    if (!c) return [];
    return c.messages.slice(-n).map((m) => ({ role: m.role, content: m.content, at: new Date(m.at).getTime() }));
  }

  count(): number {
    return this.items.length;
  }
}
