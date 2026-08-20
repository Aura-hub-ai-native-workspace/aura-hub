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

/**
 * The rolling summary of everything before `throughIndex`.
 *
 * `producer` is the load-bearing field. A summary is not something the
 * user said; it is something a model (or, in the deterministic fallback,
 * this module) wrote ABOUT what the user said. Folding it back into the
 * history without that label is how a paraphrase becomes a quotation.
 */
export interface ConversationDigest {
  text: string;
  /** Messages [0, throughIndex) are folded into `text`. */
  throughIndex: number;
  /** How many messages that was. */
  messageCount: number;
  at: string;
  /**
   * 'model' when an abstractive summariser produced it; 'system' when
   * the deterministic extractive fallback did. Never 'user'.
   */
  producer: 'model' | 'system';
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConvMessage[];
  /** Present once the conversation has been compacted at least once. */
  digest?: ConversationDigest;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

/**
 * How many trailing messages stay verbatim.
 *
 * Eight, matching the tail `history()` already returned - so compaction
 * changes what happens to the OLDER turns and nothing about the recent
 * ones. Recent turns must be exact.
 */
export const DEFAULT_KEEP_VERBATIM = 8;

/**
 * The deterministic digest.
 *
 * Extractive: every sentence it emits was in the transcript. That is a
 * weaker summary than a model would write and a much stronger guarantee -
 * a digest that invents a decision the user never made is worse than no
 * digest, because it is indistinguishable from one that did not.
 *
 * It records, per turn, who spoke and the first substantive sentence, and
 * lifts anything that reads as a decision or a correction to the top,
 * because those are what a later turn most often depends on.
 */
export function extractiveDigest(prior: string, messages: readonly ConvMessage[]): string {
  const DECISION = /\b(decided|chose|choose|instead|actually|correction|no,|not that|use |don't|do not|must|should|never|always)\b/i;
  const firstSentence = (text: string): string => {
    const flat = text.replace(/```[\s\S]*?```/g, '[code block]').replace(/\s+/g, ' ').trim();
    const m = flat.match(/^(.{0,220}?[.!?])(\s|$)/);
    return (m ? m[1] : flat.slice(0, 220)).trim();
  };

  const decisions: string[] = [];
  const flow: string[] = [];
  for (const m of messages) {
    const line = firstSentence(m.content);
    if (!line) continue;
    flow.push(`${m.role}: ${line}`);
    if (m.role === 'user' && DECISION.test(m.content)) decisions.push(`- ${line}`);
  }

  const parts: string[] = [];
  if (prior) parts.push(prior.trim());
  if (decisions.length) parts.push(`Decisions and corrections stated by the user:\n${[...new Set(decisions)].slice(0, 10).join('\n')}`);
  if (flow.length) parts.push(`Earlier exchange (${messages.length} turns, first line of each):\n${flow.join('\n')}`);
  const joined = parts.join('\n\n');

  /* Bounded. A rolling digest that grows with the conversation is the
     same unbounded-context problem one level down. */
  const MAX_CHARS = 4000;
  return joined.length <= MAX_CHARS ? joined : joined.slice(joined.length - MAX_CHARS).replace(/^[^\n]*\n/, '');
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

  /**
   * Recent turns as kernel history.
   *
   * Before compaction existed this was the whole story, and it was a
   * `slice(-n)`: turn 9 of a 9-turn conversation silently took turn 1
   * out of the model's world, with nothing anywhere recording that it
   * had happened. The model then answered as though the first exchange
   * never occurred, which reads to a user as the assistant forgetting -
   * because it is.
   *
   * The verbatim tail is still a `slice(-n)`, and deliberately so: recent
   * turns must be exact, not paraphrased. What changed is that everything
   * BEFORE the tail is no longer discarded - `compact()` folds it into a
   * digest, and `historyWithDigest()` returns both.
   */
  history(id: string, n = 8): ConversationTurn[] {
    const c = this.get(id);
    if (!c) return [];
    return c.messages.slice(-n).map((m) => ({ role: m.role, content: m.content, at: new Date(m.at).getTime() }));
  }

  /** The digest plus the verbatim tail. Nothing between them is lost. */
  historyWithDigest(id: string, n = 8): { digest: ConversationDigest | null; turns: ConversationTurn[] } {
    const c = this.get(id);
    if (!c) return { digest: null, turns: [] };
    return { digest: c.digest ?? null, turns: this.history(id, n) };
  }

  /** True when there are messages the tail will not carry and the digest does not cover. */
  needsCompaction(id: string, keepVerbatim = DEFAULT_KEEP_VERBATIM): boolean {
    const c = this.get(id);
    if (!c) return false;
    const covered = c.digest?.throughIndex ?? 0;
    return c.messages.length - keepVerbatim > covered;
  }

  /**
   * Fold everything older than the verbatim tail into a rolling digest.
   *
   * Rolling, not cumulative-from-scratch: the previous digest is an input
   * to the next one, so an old conversation costs a bounded amount of
   * work and a bounded number of tokens rather than growing without end.
   *
   * `summarize` is optional. Given one, the digest is abstractive and
   * carries `producer: 'model'`. Without one, `extractiveDigest` below
   * produces a real, deterministic digest from the turns themselves and
   * carries `producer: 'system'`. There is no third case where a digest
   * is claimed and not produced.
   */
  async compact(
    id: string,
    opts: {
      keepVerbatim?: number;
      /** An abstractive summariser. Receives the transcript, returns prose. */
      summarize?: (transcript: string) => Promise<string>;
      /** Called with the digest so a caller can write it to episodic memory. */
      onDigest?: (digest: ConversationDigest, conversation: Conversation) => void;
    } = {},
  ): Promise<ConversationDigest | null> {
    const c = this.get(id);
    if (!c) return null;
    const keep = opts.keepVerbatim ?? DEFAULT_KEEP_VERBATIM;
    const cutoff = c.messages.length - keep;
    const covered = c.digest?.throughIndex ?? 0;
    if (cutoff <= covered) return c.digest ?? null;

    const fresh = c.messages.slice(covered, cutoff);
    const transcript = fresh.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    const priorText = c.digest?.text ?? '';

    let text: string;
    let producer: ConversationDigest['producer'];
    if (opts.summarize) {
      const input = priorText
        ? `Summary so far:\n${priorText}\n\nNew turns:\n${transcript}`
        : transcript;
      try {
        const written = (await opts.summarize(input)).trim();
        if (written) {
          text = written;
          producer = 'model';
        } else {
          text = extractiveDigest(priorText, fresh);
          producer = 'system';
        }
      } catch {
        /* A summariser that failed is not a reason to lose the turns.
           Fall back to the deterministic digest and label it honestly. */
        text = extractiveDigest(priorText, fresh);
        producer = 'system';
      }
    } else {
      text = extractiveDigest(priorText, fresh);
      producer = 'system';
    }

    const digest: ConversationDigest = {
      text,
      throughIndex: cutoff,
      messageCount: cutoff,
      at: new Date().toISOString(),
      producer,
    };
    c.digest = digest;
    this.save();
    opts.onDigest?.(digest, c);
    return digest;
  }

  count(): number {
    return this.items.length;
  }
}
