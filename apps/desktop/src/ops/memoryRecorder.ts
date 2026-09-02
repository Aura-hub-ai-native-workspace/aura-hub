/**
 * memoryRecorder — the Engineering Memory ingestion layer.
 * ==================================================================
 * Memories are ONLY ever created from real engineering events. This
 * module wires up the event sources:
 *
 *   • editor saves (useEditorStore subscription)      → code memories
 *   • AI code actions accepted/rejected (explicit)    → code / review
 *   • diagnosis accept/reject (explicit)              → diagnosis
 *   • mission summaries + execution timelines (poll)  → mission / review / code
 *   • backend memory items (Knowledge Fabric) (poll)  → learning / decision
 *   • conversations (poll)                            → learning
 *   • provider switches (poll diff)                   → decision
 *
 * Every memory carries a stable `dedupe` key derived from the real
 * event (e.g. `mission:<id>:completed`), so polling engine state can
 * never record the same event twice, across restarts included. The
 * 30s reconcile loop only ever *fills gaps* — it never fabricates.
 */
import { aiClient, type MemoryItem } from '../ai/aiClient';
import { diagnosisClient } from '../ai/diagnosisClient';
import { missionClient, type MissionSummary, type TimelineEntry } from '../ai/missionClient';
import { useWorkspace } from '../data/useWorkspace';
import { useEditorStore } from '../editor/editorStore';
import {
  importanceOf,
  useMemoryStore,
  type EngineeringMemory,
  type MemoryCategory,
  type MemoryImportance,
  type MemoryInput,
} from './memoryStore';

const RECONCILE_MS = 30000;

let lastProvider: { id: string | null; model: string | null } | null = null;

function record(input: MemoryInput): EngineeringMemory | null {
  return useMemoryStore.getState().record(input);
}

/* ── editor saves (real-time) ───────────────────────────────────────── */

function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i += 1;
  let jo = oldLines.length;
  let jn = newLines.length;
  while (jo > i && jn > i && oldLines[jo - 1] === newLines[jn - 1]) {
    jo -= 1;
    jn -= 1;
  }
  return { added: jn - i, removed: jo - i };
}

function reconcileEditor(s: ReturnType<typeof useEditorStore.getState>, p: typeof s): void {
  if (!s.projectId) return;
  for (const path of s.openOrder) {
    const next = s.openFiles[path];
    const prev = p.openFiles[path];
    if (!next || !prev) continue;
    // A save flips the file from dirty → clean with its content persisted.
    if (prev.dirty && !next.dirty) {
      const stats = diffStats(prev.content, next.content);
      if (stats.added === 0 && stats.removed === 0) continue;
      const name = path.split('/').pop() ?? path;
      const hour = new Date().toISOString().slice(0, 13);
      record({
        projectId: s.projectId,
        category: 'code',
        importance: 'low',
        title: `Saved changes: ${name}`,
        summary: `${name}: +${stats.added}/−${stats.removed} lines`,
        reason: 'Code saved to disk from the editor',
        user: 'human',
        files: [path],
        source: 'editor',
        dedupe: `editor:${s.projectId}:${path}:${hour}`,
      });
    }
  }
}

/* ── mission summaries + execution timelines (poll) ─────────────────── */

function recordTimelineEntry(projectId: string, missionId: string, t: TimelineEntry): void {
  const title = t.title ?? '';
  const short = title.length > 90 ? `${title.slice(0, 90)}…` : title;
  const task = t.taskId;
  switch (t.type) {
    case 'task-accepted':
      record({
        projectId,
        category: 'code',
        importance: 'high',
        title: `AI change accepted: ${short}`,
        summary: t.detail ?? '',
        reason: 'Task proposal accepted by the user',
        user: 'ai',
        missionId,
        source: 'mission',
        at: t.at,
        dedupe: `mission:${missionId}:task:${task ?? '?'}:accepted`,
      });
      break;
    case 'task-rejected':
      record({
        projectId,
        category: 'review',
        importance: 'high',
        title: `Proposal rejected: ${short}`,
        summary: t.detail ?? '',
        reason: 'Task proposal declined by the user',
        user: 'human',
        missionId,
        source: 'mission',
        at: t.at,
        dedupe: `mission:${missionId}:task:${task ?? '?'}:rejected`,
      });
      break;
    case 'task-completed':
      record({
        projectId,
        category: 'code',
        importance: 'medium',
        title: `Task completed: ${short}`,
        summary: t.detail ?? '',
        reason: 'Task finished during mission execution',
        user: 'ai',
        missionId,
        source: 'mission',
        at: t.at,
        dedupe: `mission:${missionId}:task:${task ?? '?'}:completed`,
      });
      break;
    case 'task-failed':
      record({
        projectId,
        category: 'learning',
        importance: 'high',
        title: `Task failed: ${short}`,
        summary: t.detail ?? '',
        reason: 'Task errored during mission execution',
        user: 'ai',
        missionId,
        source: 'mission',
        at: t.at,
        dedupe: `mission:${missionId}:task:${task ?? '?'}:failed`,
      });
      break;
    case 'review-passed':
      record({
        projectId,
        category: 'review',
        importance: 'high',
        title: `Review passed: ${short}`,
        summary: t.detail ?? '',
        reason: 'Mission review checkpoint passed',
        user: 'system',
        missionId,
        source: 'mission',
        at: t.at,
        dedupe: `mission:${missionId}:review-passed`,
      });
      break;
    default:
      break;
  }
}

function recordMissionSummary(m: MissionSummary): void {
  const { id, projectId, text, createdAt, approval, execution } = m;
  const short = text.length > 90 ? `${text.slice(0, 90)}…` : text;

  record({
    projectId,
    category: 'mission',
    importance: importanceOf('mission', { event: 'created' }),
    title: `Mission created: ${short}`,
    summary: short,
    reason: 'Mission logged in Mission Control',
    user: 'human',
    missionId: id,
    source: 'mission',
    at: createdAt,
    dedupe: `mission:${id}:created`,
  });

  if (approval?.status === 'approved') {
    record({
      projectId,
      category: 'decision',
      importance: 'high',
      title: `Mission approved: ${short}`,
      summary: 'Plan approved for execution',
      reason: 'Approved before any task runs',
      user: 'human',
      missionId: id,
      source: 'mission',
      at: approval.at ?? createdAt,
      dedupe: `mission:${id}:approved`,
    });
  } else if (approval?.status === 'rejected') {
    record({
      projectId,
      category: 'decision',
      importance: 'high',
      title: `Mission plan rejected: ${short}`,
      summary: 'Plan rejected before execution',
      reason: 'Plan declined before any task ran',
      user: 'human',
      missionId: id,
      source: 'mission',
      at: approval.at ?? createdAt,
      dedupe: `mission:${id}:rejected-plan`,
    });
  }

  if (execution) {
    if (execution.status === 'completed') {
      record({
        projectId,
        category: 'mission',
        importance: 'high',
        title: `Mission completed: ${short}`,
        summary: 'Execution finished successfully',
        reason: 'Mission execution completed',
        user: 'ai',
        missionId: id,
        source: 'mission',
        at: execution.completedAt ?? execution.lastUpdatedAt,
        dedupe: `mission:${id}:completed`,
      });
    } else if (execution.status === 'failed') {
      record({
        projectId,
        category: 'mission',
        importance: 'critical',
        title: `Mission failed: ${short}`,
        summary: 'Execution did not complete successfully',
        reason: 'Mission execution failed',
        user: 'ai',
        missionId: id,
        source: 'mission',
        at: execution.lastUpdatedAt,
        dedupe: `mission:${id}:failed`,
      });
    } else if (execution.status === 'cancelled') {
      record({
        projectId,
        category: 'mission',
        importance: 'medium',
        title: `Mission cancelled: ${short}`,
        summary: 'Execution cancelled by the user',
        reason: 'Mission execution cancelled',
        user: 'human',
        missionId: id,
        source: 'mission',
        at: execution.lastUpdatedAt,
        dedupe: `mission:${id}:cancelled`,
      });
    }
    for (const t of execution.timeline ?? []) recordTimelineEntry(projectId, id, t);
  }
}

async function reconcileMissions(): Promise<void> {
  const ws = useWorkspace.getState();
  try {
    const dash = await missionClient.dashboard();
    for (const m of dash.recent) recordMissionSummary(m);
  } catch {
    /* backend down — next tick retries */
  }
  if (ws.openId) {
    try {
      const { missions } = await missionClient.list(ws.openId);
      for (const m of missions) recordMissionSummary(m);
    } catch {
      /* skip */
    }
  }
}

/* ── diagnoses (poll) ───────────────────────────────────────────────── */

async function reconcileDiagnoses(projectId: string): Promise<void> {
  try {
    const { diagnoses } = await diagnosisClient.list(projectId);
    for (const d of diagnoses) {
      const name = d.filePath.split('/').pop() ?? d.filePath;
      record({
        projectId,
        category: 'diagnosis',
        importance: 'medium',
        title: `Diagnosis run: ${name}`,
        summary: `Category: ${d.category}`,
        reason: 'Engineering diagnosis completed',
        user: 'ai',
        files: [d.filePath],
        diagnosisId: d.id,
        source: 'diagnosis',
        at: d.createdAt,
        dedupe: `diagnosis:${d.id}:created`,
      });
      if (d.decision.status === 'accepted') {
        record({
          projectId,
          category: 'diagnosis',
          importance: 'high',
          title: `Diagnosis accepted: ${name}`,
          summary: d.decision.candidateId ? `Candidate ${d.decision.candidateId} applied` : 'Fix accepted',
          reason: d.decision.reason ?? 'Recommended fix accepted by the user',
          user: 'human',
          files: [d.filePath],
          diagnosisId: d.id,
          source: 'diagnosis',
          at: d.decision.at ?? d.createdAt,
          dedupe: `diagnosis:${d.id}:accepted`,
        });
      } else if (d.decision.status === 'rejected') {
        record({
          projectId,
          category: 'diagnosis',
          importance: 'high',
          title: `Diagnosis rejected: ${name}`,
          summary: 'Fix proposal declined',
          reason: d.decision.reason ?? 'Fix rejected by the user',
          user: 'human',
          files: [d.filePath],
          diagnosisId: d.id,
          source: 'diagnosis',
          at: d.decision.at ?? d.createdAt,
          dedupe: `diagnosis:${d.id}:rejected`,
        });
      }
    }
  } catch {
    /* skip */
  }
}

/* ── backend memory items (Knowledge Fabric) ────────────────────────── */

const MEMORY_KIND_CATEGORY: Record<string, MemoryCategory> = {
  decision: 'decision',
  correction: 'learning',
  learning: 'learning',
  code: 'code',
  accepted: 'code',
  rejected: 'decision',
  conversation: 'learning',
  diagnosis: 'diagnosis',
  pinned: 'decision',
};

function reconcileBackendMemory(items: MemoryItem[], projectId: string | null): void {
  if (!projectId) return;
  for (const item of items) {
    const category: MemoryCategory = MEMORY_KIND_CATEGORY[item.kind] ?? 'learning';
    record({
      projectId,
      category,
      importance: importanceOf(category),
      title: item.title,
      summary: item.body.slice(0, 300),
      reason: 'Recorded in the Knowledge Fabric memory store',
      user: 'system',
      source: 'memory-item',
      at: item.at,
      dedupe: `memory-item:${projectId}:${item.id}`,
    });
  }
}

/* ── conversations (poll) ───────────────────────────────────────────── */

async function reconcileConversations(projectId: string): Promise<void> {
  if (!projectId) return;
  try {
    const { conversations } = await aiClient.listConversations(projectId);
    for (const c of conversations) {
      const preview = (c.preview ?? '').replace(/\s+/g, ' ').trim();
      record({
        projectId,
        category: 'learning',
        importance: 'low',
        title: `Discussion: ${c.title}`,
        summary: `${c.messageCount} message${c.messageCount === 1 ? '' : 's'}${preview ? ` — ${preview.slice(0, 160)}` : ''}`,
        reason: 'Engineering discussion in the AI workspace',
        user: 'human',
        source: 'conversation',
        at: c.updatedAt,
        dedupe: `conversation:${projectId}:${c.id}`,
      });
    }
  } catch {
    /* skip */
  }
}

/* ── provider switches (poll diff) ──────────────────────────────────── */

async function reconcileProvider(): Promise<void> {
  try {
    const res = await aiClient.getProviders();
    const pid = res.active;
    const model = res.activeModel;
    if (lastProvider && (lastProvider.id !== pid || lastProvider.model !== model)) {
      const name =
        res.connected.find((c) => c.id === pid)?.name ??
        res.providers.find((p) => p.id === pid)?.name ??
        res.status.label ??
        pid ??
        'default';
      record({
        projectId: null,
        category: 'decision',
        importance: 'medium',
        title: `Provider: ${name}`,
        summary: `Active model: ${model || 'default'}`,
        reason: 'AI provider configuration changed',
        user: 'human',
        source: 'provider',
        dedupe: `provider:${pid ?? 'none'}:${model ?? 'default'}:${Date.now()}`,
      });
    }
    lastProvider = { id: pid ?? null, model: model ?? null };
  } catch {
    /* backend down — keep the last known baseline */
  }
}

/* ── reconcile loop ─────────────────────────────────────────────────── */

async function reconcileAll(): Promise<void> {
  await reconcileMissions();
  const openId = useWorkspace.getState().openId;
  if (openId) {
    await Promise.all([reconcileDiagnoses(openId), reconcileConversations(openId)]);
  }
  await reconcileProvider();
  reconcileBackendMemory(useWorkspace.getState().memory, useWorkspace.getState().openId);
}

/**
 * Start recording engineering memories. Idempotent wiring of every real
 * event source; returns a stop function for teardown.
 */
export function startMemoryRecorder(): () => void {
  const editorUnsub = useEditorStore.subscribe(reconcileEditor);
  const wsUnsub = useWorkspace.subscribe((s, p) => {
    if (s.memory !== p.memory) reconcileBackendMemory(s.memory, s.openId);
    if (s.openId !== p.openId) {
      lastProvider = null; // re-baseline provider for the new context
      void reconcileAll();
    }
  });

  void reconcileAll();
  const timer = window.setInterval(() => void reconcileAll(), RECONCILE_MS);

  return () => {
    editorUnsub();
    wsUnsub();
    window.clearInterval(timer);
  };
}

/* ── explicit event hooks (called at the real action sites) ─────────── */

export interface AiActionMemoryInput {
  accepted: boolean;
  action: string;
  filePath: string;
  symbolLabel: string | null;
  explanation: string;
  riskLevel: string | null;
}

/** Record an accepted or rejected AI code action (AIActionDialog). */
export function recordAiActionMemory(input: AiActionMemoryInput): void {
  const projectId = useEditorStore.getState().projectId ?? useWorkspace.getState().openId;
  if (!projectId) return;
  const file = input.filePath.split('/').pop() ?? input.filePath;
  const symbols = input.symbolLabel ? [input.symbolLabel] : [];
  if (input.accepted) {
    record({
      projectId,
      category: 'code',
      importance: 'high',
      title: `AI ${input.action} accepted: ${file}`,
      summary: input.explanation || `Applied ${input.action} to ${input.filePath}`,
      reason: 'AI code change accepted by the user',
      user: 'ai',
      files: [input.filePath],
      symbols,
      source: 'ai-action',
      dedupe: `ai-action:${projectId}:${input.filePath}:${input.action}:${Date.now()}`,
    });
  } else {
    record({
      projectId,
      category: 'review',
      importance: 'medium',
      title: `AI ${input.action} proposal declined: ${file}`,
      summary: input.explanation || `Declined ${input.action} proposal for ${input.filePath}`,
      reason: 'AI proposal not applied by the user',
      user: 'human',
      files: [input.filePath],
      symbols,
      source: 'ai-action',
      dedupe: `ai-action:${projectId}:${input.filePath}:${input.action}:${Date.now()}`,
    });
  }
}

export interface DiagnosisMemoryInput {
  id: string;
  filePath: string;
  event: 'accepted' | 'rejected';
  candidateId?: 'A' | 'B' | 'C';
  reason?: string;
  category: string;
}

/** Record a diagnosis accept/reject decision (useDiagnosis). */
export function recordDiagnosisMemory(projectId: string, input: DiagnosisMemoryInput): void {
  const file = input.filePath.split('/').pop() ?? input.filePath;
  const accepted = input.event === 'accepted';
  const importance: MemoryImportance = 'high';
  record({
    projectId,
    category: 'diagnosis',
    importance,
    title: `${accepted ? 'Diagnosis accepted' : 'Diagnosis rejected'}: ${file}`,
    summary: input.candidateId ? `Candidate ${input.candidateId} (${input.category})` : input.category,
    reason: input.reason ?? (accepted ? 'Recommended fix applied' : 'Fix declined'),
    user: 'human',
    files: [input.filePath],
    diagnosisId: input.id,
    source: 'diagnosis',
    dedupe: `diagnosis:${input.id}:${input.event}`,
  });
}

export interface BugBotMemoryInput {
  filePath: string;
  event: 'fix-approved' | 'fix-rejected' | 'fix-reverted' | 'fix-failed';
  title: string;
  summary: string;
  severity: string;
}

/**
 * Record a Bug Bot decision — a governed, user-approved fix being applied
 * to (or explicitly rejected for / reverted from) a real file. Same layer
 * as the other explicit event hooks: never fabricated, keyed to the real
 * file path, deduped against the actual event.
 */
export function recordBugBotMemory(input: BugBotMemoryInput): void {
  const projectId = useEditorStore.getState().projectId ?? useWorkspace.getState().openId;
  if (!projectId) return;
  const importance: MemoryImportance = input.event === 'fix-rejected' ? 'medium' : 'high';
  record({
    projectId,
    category: 'diagnosis',
    importance,
    title: input.title,
    summary: input.summary,
    reason:
      input.event === 'fix-approved'
        ? 'Bug Bot fix approved and applied by the user'
        : input.event === 'fix-reverted'
          ? 'Bug Bot fix reverted by the user after failed verification'
          : input.event === 'fix-failed'
            ? 'Bug Bot fix could not be written to disk'
            : 'Bug Bot fix proposal declined by the user',
    user: 'human',
    files: [input.filePath],
    source: 'bug-bot',
    dedupe: `bug-bot:${projectId}:${input.filePath}:${input.event}:${Date.now()}`,
  });
}
