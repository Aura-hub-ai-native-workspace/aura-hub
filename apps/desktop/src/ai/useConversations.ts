/**
 * useConversations — per-project conversation state + streaming.
 * ==================================================================
 * There is NO global chat. This store is always scoped to ONE project:
 * loading a project loads that project's conversation list and history
 * from the backend, and every message is persisted under that project.
 * Switching projects reloads a completely separate set — conversations
 * never mix. Each answer is generated with that conversation's history
 * threaded in, so the assistant remembers the thread (project-scoped).
 */

import { create } from 'zustand';
import { aiClient, type ConversationSummary, type InspectResult, type StreamDone, type StreamError } from './aiClient';
import { useWorkspace } from '../data/useWorkspace';
import { answerLearningQuestion } from '../ops/learningEngine';

export type Phase = 'idle' | 'retrieving' | 'generating';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  meta?: InspectResult;
  done?: StreamDone;
  error?: StreamError;
  status: 'streaming' | 'done' | 'error';
}

interface ConvState {
  projectId: string | null;
  conversations: ConversationSummary[];
  activeId: string | null;
  messages: ChatMessage[];
  phase: Phase;
  loading: boolean;

  loadForProject: (projectId: string | null) => Promise<void>;
  reloadList: () => Promise<void>;
  select: (cid: string) => Promise<void>;
  newConversation: () => Promise<string | null>;
  rename: (cid: string, title: string) => Promise<void>;
  remove: (cid: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  regenerate: () => Promise<void>;
}

let seq = 0;
const nid = () => `m${Date.now().toString(36)}${seq++}`;
let abort: AbortController | null = null;

export const useConversations = create<ConvState>((set, get) => ({
  projectId: null,
  conversations: [],
  activeId: null,
  messages: [],
  phase: 'idle',
  loading: false,

  async loadForProject(projectId) {
    if (get().projectId === projectId) return;
    abort?.abort();
    set({ projectId, conversations: [], activeId: null, messages: [], phase: 'idle', loading: !!projectId });
    if (!projectId) return;
    try {
      const { conversations } = await aiClient.listConversations(projectId);
      set({ conversations, loading: false });
      if (conversations.length) await get().select(conversations[0].id);
    } catch {
      set({ loading: false });
    }
  },

  async reloadList() {
    const { projectId } = get();
    if (!projectId) return;
    try { set({ conversations: (await aiClient.listConversations(projectId)).conversations }); } catch { /* keep */ }
  },

  async select(cid) {
    const { projectId } = get();
    if (!projectId) return;
    abort?.abort();
    set({ activeId: cid, phase: 'idle' });
    try {
      const conv = await aiClient.getConversation(projectId, cid);
      const messages: ChatMessage[] = conv.messages.map((m) => {
        const meta = (m.meta ?? null) as { inspect?: InspectResult; done?: StreamDone } | null;
        return { id: m.id, role: m.role, content: m.content, meta: meta?.inspect, done: meta?.done, status: m.error ? 'error' : 'done' };
      });
      set({ messages });
    } catch {
      set({ messages: [] });
    }
  },

  async newConversation() {
    const { projectId } = get();
    if (!projectId) return null;
    abort?.abort();
    const conv = await aiClient.createConversation(projectId);
    set({ activeId: conv.id, messages: [], phase: 'idle' });
    await get().reloadList();
    return conv.id;
  },

  async rename(cid, title) {
    const { projectId } = get();
    if (!projectId) return;
    await aiClient.renameConversation(projectId, cid, title);
    await get().reloadList();
  },

  async remove(cid) {
    const { projectId } = get();
    if (!projectId) return;
    await aiClient.removeConversation(projectId, cid);
    if (get().activeId === cid) set({ activeId: null, messages: [] });
    await get().reloadList();
    const first = get().conversations[0];
    if (first && !get().activeId) await get().select(first.id);
  },

  async send(text) {
    const trimmed = text.trim();
    const { projectId, phase } = get();
    if (!trimmed || !projectId || phase !== 'idle') return;

    // Engineering Learning answers: deterministic replies grounded in real
    // engineering memory, delivered locally without a backend stream.
    const project = useWorkspace.getState().projects.find((p) => p.id === projectId);
    const scopeLabel = project?.name ?? projectId;
    const learningAnswer = answerLearningQuestion(trimmed, projectId, scopeLabel);
    if (learningAnswer) {
      let cid = get().activeId;
      if (!cid) cid = await get().newConversation();
      if (!cid) return;
      const userId = nid();
      const assistantId = nid();
      set({
        messages: [
          ...get().messages,
          { id: userId, role: 'user', content: trimmed, status: 'done' },
          { id: assistantId, role: 'assistant', content: learningAnswer, status: 'done' },
        ],
      });
      void aiClient.appendMessage(projectId, cid, { role: 'user', content: trimmed }).catch(() => {});
      void aiClient.appendMessage(projectId, cid, { role: 'assistant', content: learningAnswer, meta: { learning: true } }).catch(() => {});
      void get().reloadList();
      return;
    }

    let cid = get().activeId;
    if (!cid) cid = await get().newConversation();
    if (!cid) return;

    const userId = nid();
    const assistantId = nid();
    set({
      messages: [
        ...get().messages,
        { id: userId, role: 'user', content: trimmed, status: 'done' },
        { id: assistantId, role: 'assistant', content: '', status: 'streaming' },
      ],
    });

    aiClient.appendMessage(projectId, cid, { role: 'user', content: trimmed }).then(() => get().reloadList()).catch(() => {});
    await runStream(trimmed, assistantId, cid);
  },

  stop() {
    abort?.abort();
  },

  async regenerate() {
    const { phase, messages, projectId, activeId } = get();
    if (phase !== 'idle' || !projectId || !activeId) return;
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = i; break; }
    if (lastUser < 0) return;
    const text = messages[lastUser].content;
    const assistantId = nid();
    set({ messages: [...messages.slice(0, lastUser + 1), { id: assistantId, role: 'assistant', content: '', status: 'streaming' }] });
    // Discard the persisted answer being replaced — otherwise it stays
    // saved underneath the new one and reopening the conversation would
    // show both, back-to-back, forever.
    await aiClient.removeLastAssistantMessage(projectId, activeId).catch(() => {});
    await runStream(text, assistantId, activeId);
  },
}));

/** Drive one streamed answer for the active conversation, then persist it. */
async function runStream(text: string, assistantId: string, cid: string): Promise<void> {
  const { setState, getState } = useConversations;
  const projectId = getState().projectId!;
  const patch = (fn: (m: ChatMessage) => ChatMessage) =>
    setState({ messages: getState().messages.map((m) => (m.id === assistantId ? fn(m) : m)) });

  setState({ phase: 'retrieving' });
  const ac = new AbortController();
  abort = ac;
  let firstToken = true;
  let capturedMeta: InspectResult | undefined;
  let capturedDone: StreamDone | undefined;
  let capturedError: StreamError | undefined;

  await aiClient.stream(
    text,
    {
      onMeta: (meta) => {
        capturedMeta = meta; patch((m) => ({ ...m, meta }));
      },
      onToken: (t) => {
        if (firstToken) { firstToken = false; setState({ phase: 'generating' }); }
        patch((m) => ({
          ...m,
          content: t.startsWith(m.content) ? t : m.content + t,
        }));
      },
      onDone: (done) => {
        capturedDone = done; patch((m) => ({ ...m, done, status: 'done' }));
      },
      onError: (error) => {
        capturedError = error; patch((m) => ({ ...m, error, status: 'error' }));
      },
    },
    ac.signal,
    { projectId, conversationId: cid },
  );

  patch((m) => (m.status === 'streaming' ? { ...m, status: 'done' } : m));
  setState({ phase: 'idle' });
  abort = null;

  const finalContent = getState().messages.find((m) => m.id === assistantId)?.content ?? '';
  if (finalContent && !capturedError) {
    aiClient
      .appendMessage(projectId, cid, { role: 'assistant', content: finalContent, meta: { inspect: capturedMeta, done: capturedDone } })
      .then(() => getState().reloadList())
      .catch(() => {});
  }
}
