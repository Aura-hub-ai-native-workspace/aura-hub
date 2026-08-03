/**
 * agentEngine — the Autonomous Engineering Agent's brain.
 * ==================================================================
 * A deterministic (no ML), always human-gated improvement loop that
 * sits on top of Engineering Memory + the Learning Engine. Every tick:
 *
 *   1. OBSERVE  — re-analyze real memory records and read the Learning
 *                 Engine's derived patterns/predictions/health.
 *   2. REASON   — turn strong real signals into candidate improvements
 *                 (a repeated bug, an unstable module, an AI-rejection
 *                 hotspot, a high-risk prediction, a regression risk).
 *   3. PLAN     — write the rationale, expected outcome and verify
 *                 target for each candidate.
 *   4. PROPOSE  — enqueue a campaign and request human approval
 *                 (notification + approval queue in the UI).
 *   5. EXECUTE  — ONLY after explicit human approval does the agent act,
 *                 and its only action is creating a REAL improvement
 *                 mission through Mission Control, then auto-approving
 *                 the mission's own plan (the campaign approval already
 *                 is that approval) and starting execution. Mission
 *                 task proposals still require per-task human accept.
 *   6. VERIFY   — poll the mission execution; on completion, re-measure
 *                 the verify target (mission completed / no new
 *                 diagnoses for the target file).
 *   7. LEARN    — the outcome is recorded back into Engineering Memory
 *                 (source `system`), so the Learning Engine sees the
 *                 agent's real results as real records.
 *
 * Hard safety rules:
 *   • The agent NEVER edits code directly. It only proposes and creates
 *     missions; the mission engine's plan-approval + per-task-accept
 *     gates remain intact.
 *   • Nothing runs before an explicit human approval.
 *   • Every campaign carries a reasoning trace and a timeline entry for
 *     each transition — fully explainable, traceable, auditable.
 *   • A signal key is never re-proposed while its campaign exists.
 */
import { missionClient, type MissionEvent } from '../ai/missionClient';
import { useWorkspace } from '../data/useWorkspace';
import { analyzeMemories, type LearningPattern, type LearningPrediction } from './learningEngine';
import { useMemoryStore, type MemoryInput } from './memoryStore';
import { useNotificationsStore } from './notificationsStore';
import { useAgentStore, type AgentCampaign, type AgentCampaignInput, type AgentSeverity } from './agentStore';

const TICK_MS = 30000;
const MIN_RECORDS = 4;
const MAX_OPEN_CAMPAIGNS = 5;

let started = false;
let working = new Set<string>();
let timer: number | null = null;

/* ── tiny helpers ──────────────────────────────────────────────────── */

function nameOf(file?: string): string {
  return file ? (file.split('/').pop() ?? file) : 'unknown module';
}

function recordMemory(c: AgentCampaign, input: Omit<MemoryInput, 'projectId'>): void {
  useMemoryStore.getState().record({ ...input, projectId: c.projectId ?? null });
}

function notify(key: string, kind: 'approval-required' | 'mission-completed' | 'architecture-warning', title: string, detail: string, projectId: string | null, missionId?: string): void {
  useNotificationsStore.getState().notify({ key, kind, title, detail, projectId: projectId ?? undefined, missionId });
}

/* ── 1/2/3. observe → reason → plan → propose ─────────────────────── */

function fileInput(
  kind: AgentCampaignInput['kind'],
  signalKey: string,
  file: string | undefined,
  signalLabel: string,
  rationale: string,
  plan: string,
  expectedOutcome: string,
  severity: AgentSeverity,
  verifyBefore: number,
  evidence: string[],
  projectId: string | null,
): AgentCampaignInput {
  return {
    signalKey,
    kind,
    projectId,
    target: nameOf(file),
    signalLabel,
    severity,
    rationale,
    plan,
    expectedOutcome,
    evidence,
    reasoning: [
      { kind: 'observed', label: 'Signal observed', detail: signalLabel },
      { kind: 'reasoned', label: 'Why it matters', detail: rationale },
      { kind: 'planned', label: 'Improvement plan', detail: plan },
    ],
    verify: { kind: 'diagnosis-count', file, before: verifyBefore },
  };
}

function patternCampaign(p: LearningPattern, projectId: string | null): AgentCampaignInput | null {
  const file = p.evidence[0]?.file;
  const name = nameOf(file);
  const evidence = p.evidence.map((e) => e.title);
  const count = p.count;

  switch (p.kind) {
    case 'repeated-bug':
      return fileInput(
        'repeated-bug', p.id, file,
        `${name} has failed diagnosis ${count} times`,
        p.detail,
        `Run an engineering diagnosis on ${file ?? name} to find the root cause, fix the fragile area, add regression coverage, then re-verify.`,
        `No new diagnosis records for ${file ?? name} after the mission completes.`,
        count >= 4 ? 'critical' : 'high',
        count,
        evidence,
        projectId,
      );
    case 'unstable-module':
      return fileInput(
        'unstable-module', p.id, file,
        `${name} is the most unstable module`,
        p.detail,
        `Diagnose the module, extract the failing sub-part, add targeted tests and stabilize its interface, then re-verify stability.`,
        `The module records no new diagnoses or declined AI proposals after the mission.`,
        count >= 4 ? 'high' : 'medium',
        count,
        evidence,
        projectId,
      );
    case 'ai-rejection':
      return fileInput(
        'ai-rejection', p.id, file,
        `AI proposals touching ${name} are mostly rejected`,
        p.detail,
        `Review the recent declined proposals for ${file ?? name}, document the module contract, and clarify the expected change pattern so future proposals are accepted.`,
        `AI acceptance on ${file ?? name} recovers to an acceptable level.`,
        'medium',
        count,
        evidence,
        projectId,
      );
    case 'architecture-hotspot':
      return {
        signalKey: p.id,
        kind: 'architecture-hotspot',
        projectId,
        target: p.title.replace(/ is an architecture hotspot$/, ''),
        signalLabel: p.title,
        severity: p.tone === 'critical' ? 'critical' : 'high',
        rationale: p.detail,
        plan: `Review the critical events in this layer, identify the pressure points, and schedule a targeted refactoring mission that reduces churn and critical failures.`,
        expectedOutcome: `Critical and high-importance records in this layer stop growing.`,
        evidence,
        reasoning: [
          { kind: 'observed', label: 'Signal observed', detail: p.title },
          { kind: 'reasoned', label: 'Why it matters', detail: p.detail },
          { kind: 'planned', label: 'Improvement plan', detail: `De-risk the ${p.title} layer.` },
        ],
        verify: { kind: 'mission-completion', before: 0 },
      };
    case 'mission-bottleneck':
      return {
        signalKey: p.id,
        kind: 'mission-bottleneck',
        projectId,
        target: 'recurring mission',
        signalLabel: p.title,
        severity: count >= 2 ? 'high' : 'medium',
        rationale: p.detail,
        plan: `Inspect the failing mission's execution timeline, correct the failing task(s), and re-run the mission to completion.`,
        expectedOutcome: `The bottleneck mission completes without task failures.`,
        evidence,
        reasoning: [
          { kind: 'observed', label: 'Signal observed', detail: p.title },
          { kind: 'reasoned', label: 'Why it matters', detail: p.detail },
          { kind: 'planned', label: 'Improvement plan', detail: `Unblock the recurring mission.` },
        ],
        verify: { kind: 'mission-completion', before: 0 },
      };
    default:
      return null;
  }
}

function predictionCampaign(p: LearningPrediction, projectId: string | null): AgentCampaignInput | null {
  if (p.risk !== 'high') return null;
  const name = p.target;
  const evidence = [`Prediction: ${p.detail}`, `${p.actions.join('; ')}`];

  switch (p.kind) {
    // These three kinds come from LearningPrediction, which only carries a
    // display name (`target`, already a basename) — never the full relative
    // path `EngineeringMemory.files` entries use for matching. There is no
    // real per-file count to re-measure at verify-time, so route through
    // fileInput() for its text/reasoning/evidence, but correct the verify
    // target it produces (which otherwise defaults to `kind: 'diagnosis-count'`
    // with `file: undefined` — silently always-passing while the UI still
    // labels it "≤ N diagnoses", claiming a check that never happens).
    case 'file-break':
      return {
        ...fileInput(
          'high-risk-prediction', p.id, undefined,
          `${name} is predicted to break (${p.confidence}% confidence)`,
          p.detail,
          `Run an engineering diagnosis now, fix the fragile area, add regression tests, and re-verify the file records no new diagnoses.`,
          `No new diagnosis records for ${name} after the mission completes.`,
          'high',
          p.evidenceCount,
          evidence,
          projectId,
        ),
        verify: { kind: 'mission-completion', before: 0 },
      };
    case 'regression':
      return {
        ...fileInput(
          'regression-risk', p.id, undefined,
          `${name} shows a likely regression (${p.confidence}% confidence)`,
          p.detail,
          `Re-run the diagnosis, review the recent accepted AI change on this file, and roll back or correct it, then re-verify.`,
          `The regression signal for ${name} is resolved.`,
          'critical',
          p.evidenceCount,
          evidence,
          projectId,
        ),
        verify: { kind: 'mission-completion', before: 0 },
      };
    case 'refactor':
      return {
        ...fileInput(
          'high-risk-prediction', p.id, undefined,
          `${name} needs a refactor (${p.confidence}% confidence)`,
          p.detail,
          `Open a refactoring mission, extract the failing sub-module, document the module contract, and verify stability afterwards.`,
          `${name} is stable after the refactor.`,
          'high',
          p.evidenceCount,
          evidence,
          projectId,
        ),
        verify: { kind: 'mission-completion', before: 0 },
      };
    case 'architecture-risk':
      return {
        signalKey: p.id,
        kind: 'architecture-hotspot',
        projectId,
        target: name,
        signalLabel: `${name} carries architectural risk (${p.confidence}% confidence)`,
        severity: 'high',
        rationale: p.detail,
        plan: `Review the critical and high-importance events in the ${name} layer, address the pressure points, and schedule a remediation mission.`,
        expectedOutcome: `Critical events in the ${name} layer stop growing.`,
        evidence,
        reasoning: [
          { kind: 'observed', label: 'Signal observed', detail: `${name} carries architectural risk.` },
          { kind: 'reasoned', label: 'Why it matters', detail: p.detail },
          { kind: 'planned', label: 'Improvement plan', detail: `De-risk the ${name} layer.` },
        ],
        verify: { kind: 'mission-completion', before: 0 },
      };
    default:
      return null;
  }
}

function openCampaignCount(): number {
  const { campaigns } = useAgentStore.getState();
  return campaigns.filter((c) =>
    c.status === 'awaiting-approval' || c.status === 'approved' || c.status === 'executing' || c.status === 'verifying',
  ).length;
}

/** Observe real memory → derive candidate campaigns → enqueue for approval. */
export function runAgentObservation(): void {
  const { enabled } = useAgentStore.getState();
  if (!enabled) return;

  const projectId = useWorkspace.getState().openId;
  const analysis = analyzeMemories(useMemoryStore.getState().memories);
  if (analysis.records < MIN_RECORDS) return;
  if (openCampaignCount() >= MAX_OPEN_CAMPAIGNS) return;

  const existing = new Set(useAgentStore.getState().campaigns.map((c) => c.signalKey));
  const inputs: AgentCampaignInput[] = [];

  for (const p of analysis.patterns) {
    const c = patternCampaign(p, projectId);
    if (c) inputs.push(c);
  }
  for (const p of analysis.predictions) {
    const c = predictionCampaign(p, projectId);
    if (c) inputs.push(c);
  }

  for (const input of inputs) {
    if (existing.has(input.signalKey)) continue;
    const campaign = useAgentStore.getState().propose(input);
    if (!campaign) continue;
    existing.add(input.signalKey);

    recordMemory(campaign, {
      category: 'decision',
      importance: campaign.severity === 'critical' ? 'high' : 'medium',
      title: `Agent improvement proposed: ${campaign.target}`,
      summary: campaign.signalLabel,
      reason: 'The Autonomous Engineering Agent detected a real signal and proposed an improvement mission.',
      user: 'system',
      source: 'system',
      dedupe: `agent:${campaign.id}:proposed`,
    });

    notify(
      `agent:propose:${campaign.signalKey}`,
      'approval-required',
      'Agent improvement proposal',
      campaign.signalLabel,
      campaign.projectId,
    );
  }
}

/* ── 5. execute — create a real improvement mission (approved only) ── */

async function createMission(c: AgentCampaign): Promise<void> {
  const { log, setPipelineBusy, setStatus } = useAgentStore.getState();
  const projectId = c.projectId ?? useWorkspace.getState().openId;
  if (!projectId) {
    log(c.id, 'execute', 'Skipped', 'No project is open — cannot create an improvement mission.', 'agent');
    return;
  }
  if (working.has(c.id)) return;
  working.add(c.id);
  setPipelineBusy(true);
  log(c.id, 'execute', 'Mission creation started', `Creating the improvement mission for ${c.target}.`, 'agent');

  const text = `[Agent improvement] ${c.signalLabel}. Rationale: ${c.rationale} Plan: ${c.plan} Expected outcome: ${c.expectedOutcome}`;

  let missionId: string | null = null;
  let error: string | null = null;

  await missionClient.create(projectId, text, (e: MissionEvent) => {
    if (e.type === 'done') missionId = e.mission.id;
    else if (e.type === 'error') error = e.message;
  });

  if (error || !missionId) {
    setStatus(c.id, 'failed', { note: error ?? 'Mission creation failed' });
    log(c.id, 'execute', 'Mission creation failed', error ?? 'No mission was produced.', 'agent');
    working.delete(c.id);
    setPipelineBusy(false);
    return;
  }

  setStatus(c.id, 'executing', { missionId });
  log(c.id, 'execute', 'Improvement mission created', `Mission ${missionId} is registered in Mission Control.`, 'agent');

  try {
    // approve() resolves (doesn't throw) even on a non-2xx response — the
    // server returns `{error}` as valid JSON on failure (e.g. race losing
    // the mission), so a resolved promise is not itself proof of success.
    const approveResult = await missionClient.approve(projectId, missionId);
    const approveError = (approveResult as { error?: string } | null)?.error;
    if (approveError) {
      log(c.id, 'execute', 'Mission approval failed', approveError, 'agent');
    } else {
      log(c.id, 'execute', 'Mission plan auto-approved', 'The campaign was already approved by the user, so the mission plan is approved to run.', 'agent');
    }
  } catch {
    log(c.id, 'execute', 'Mission approval failed', 'The mission plan could not be auto-approved — approve it manually in Mission Control.', 'agent');
  }

  try {
    const result = await missionClient.start(projectId, missionId);
    if (result.ok) log(c.id, 'execute', 'Execution started', 'Mission execution waves will generate proposals that still need per-task human acceptance.', 'agent');
    else log(c.id, 'execute', 'Execution pending', result.error ?? 'Mission is approved but not yet started.', 'agent');
  } catch {
    log(c.id, 'execute', 'Execution pending', 'Could not start execution — start it from Mission Control.', 'agent');
  }

  working.delete(c.id);
  setPipelineBusy(false);
}

/* ── 6. verify — re-measure the target after the mission settles ───── */

function runVerification(c: AgentCampaign): void {
  const { setVerification } = useAgentStore.getState();

  if (c.verify?.kind === 'diagnosis-count' && c.verify.file) {
    const file = c.verify.file;
    const mems = useMemoryStore.getState().memories;
    const diagnoses = mems.filter((m) => m.category === 'diagnosis' && m.files.includes(file)).length;
    const aiDeclined = mems.filter((m) => m.source === 'ai-action' && m.category === 'review' && m.files.includes(file)).length;
    // Re-measure with the exact metric each signal kind baselined at
    // propose-time (see patternCampaign()'s `count` for each kind) — using
    // diagnoses alone for every kind would compare against the wrong
    // baseline for 'unstable-module' (diagnoses + AI-declined) and
    // 'ai-rejection' (AI-declined alone), letting either falsely "pass"
    // verification while the actual signal it was measuring kept growing.
    const after =
      c.kind === 'ai-rejection' ? aiDeclined :
      c.kind === 'unstable-module' ? diagnoses + aiDeclined :
      diagnoses;
    const pass = after <= c.verify.before;
    const name = nameOf(c.verify.file);
    setVerification(
      c.id,
      pass,
      pass
        ? `Verified: ${after} diagnosis record(s) for ${name} — within the ${c.verify.before} baseline.`
        : `Not verified: ${after} diagnosis record(s) for ${name} now exceed the ${c.verify.before} baseline — the signal is unresolved.`,
      after,
    );
  } else {
    setVerification(c.id, true, 'Verified: the improvement mission completed successfully.', 1);
  }
}

function recordOutcome(c: AgentCampaign): void {
  const pass = c.status === 'verified';
  recordMemory(c, {
    category: 'learning',
    importance: pass ? 'medium' : 'high',
    title: pass ? `Agent improvement verified: ${c.target}` : `Agent improvement unresolved: ${c.target}`,
    summary: pass ? c.note ?? 'The improvement mission completed successfully.' : c.note ?? 'The improvement did not resolve the signal.',
    reason: 'Outcome recorded by the Autonomous Engineering Agent after verification.',
    user: 'system',
    source: 'system',
    missionId: c.missionId,
    files: c.verify?.file ? [c.verify.file] : undefined,
    dedupe: `agent:${c.id}:${pass ? 'verified' : 'failed'}`,
  });

  notify(
    `agent:${c.id}:${pass ? 'verified' : 'failed'}`,
    pass ? 'mission-completed' : 'architecture-warning',
    pass ? 'Agent improvement verified' : 'Agent improvement failed',
    pass ? `${c.target} — ${c.note ?? 'mission completed.'}` : `${c.target} — ${c.note ?? 'the signal remains.'}`,
    c.projectId,
    c.missionId ?? undefined,
  );
}

/* ── the reconcile loop ────────────────────────────────────────────── */

async function advance(): Promise<void> {
  const { enabled } = useAgentStore.getState();
  if (!enabled) return;

  runAgentObservation();

  const { campaigns } = useAgentStore.getState();
  const approved = campaigns.filter((c) => c.status === 'approved');
  for (const c of approved) await createMission(c);

  await monitorExecutions();

  const verifying = useAgentStore.getState().campaigns.filter((c) => c.status === 'verifying');
  for (const c of verifying) {
    runVerification(c);
    recordOutcome(useAgentStore.getState().campaigns.find((x) => x.id === c.id) ?? c);
  }
}

async function monitorExecutions(): Promise<void> {
  const executing = useAgentStore.getState().campaigns.filter((c) => c.status === 'executing' && c.missionId);
  if (!executing.length) return;

  const byProject = new Map<string, AgentCampaign[]>();
  for (const c of executing) {
    const pid = c.projectId ?? useWorkspace.getState().openId;
    if (!pid) continue;
    const list = byProject.get(pid) ?? [];
    list.push(c);
    byProject.set(pid, list);
  }

  for (const [pid, list] of byProject) {
    let missions: { id: string; execution?: { status?: string; failedCount?: number } }[] = [];
    try {
      const res = await missionClient.list(pid);
      missions = res.missions as { id: string; execution?: { status?: string } }[];
    } catch {
      continue;
    }
    const map = new Map(missions.map((m) => [m.id, m]));
    const { setStatus, log } = useAgentStore.getState();

    for (const c of list) {
      const s = map.get(c.missionId!);
      const status = s?.execution?.status;
      if (!status) continue;
      if (status === 'completed') {
        setStatus(c.id, 'verifying');
        log(c.id, 'executing', 'Mission completed', 'The improvement mission finished — running verification.', 'system');
      } else if (status === 'failed' || status === 'cancelled') {
        setStatus(c.id, 'failed', { note: `Improvement mission ${status}.` });
        log(c.id, 'executing', `Mission ${status}`, 'The improvement mission did not complete.', 'system');
        recordOutcome(useAgentStore.getState().campaigns.find((x) => x.id === c.id) ?? c);
      }
    }
  }
}

/* ── boot ──────────────────────────────────────────────────────────── */

/**
 * Start the agent loop. Idempotent — mirrors `startMemoryRecorder()`'s
 * wiring pattern and returns a stop function for teardown. Observes on
 * memory changes too (throttled by the tick), so proposals appear
 * quickly after real events.
 */
export function startAgentEngine(): () => void {
  if (started) return () => undefined;
  started = true;

  const onMemories = (s: { memories: unknown[] }, p: { memories: unknown[] }): void => {
    if (s.memories !== p.memories) runAgentObservation();
  };
  const memoryUnsub = useMemoryStore.subscribe(onMemories);

  void advance();
  timer = window.setInterval(() => void advance(), TICK_MS);

  return () => {
    memoryUnsub();
    if (timer !== null) window.clearInterval(timer);
    started = false;
  };
}
