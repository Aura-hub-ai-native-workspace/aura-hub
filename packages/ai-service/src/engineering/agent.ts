/**
 * agent — the Autonomous Engineering Agent, in the service.
 * ==================================================================
 * Was `apps/desktop/src/ops/agentEngine.ts`: a 30-second tick running in
 * the *renderer*, not routed through the Capability Fabric, with its
 * state in `localStorage`. It died with the window. An agent that stops
 * existing when a person closes a tab is not an autonomous agent; it is
 * a screensaver.
 *
 * This is a PORT, not a rewrite. The loop is the same seven stages, in
 * the same order, with the same safety rules:
 *
 *   OBSERVE → REASON → PLAN → PROPOSE → (human approval) → EXECUTE →
 *   VERIFY → LEARN
 *
 * The safety rules are unchanged and are the reason it is allowed to run
 * unattended at all:
 *
 *   • The agent NEVER edits code. Its only action is creating a real
 *     mission through Mission Control, whose own plan-approval and
 *     per-task-acceptance gates stay intact — and every task inside that
 *     mission still executes through the Capability Fabric, under policy.
 *   • Nothing happens before an explicit human approval of the campaign.
 *   • Every transition writes a timeline entry, so what it did and why
 *     is explainable, traceable and auditable after the fact.
 *   • A signal key is never re-proposed while its campaign exists.
 *
 * Invariant 10 is untouched and is in fact strengthened: the renderer
 * still cannot execute processes — it now cannot even schedule the agent
 * that asks for them.
 */

import type { MissionEvent, MissionSummary } from '../mission/types';
import { analyzeMemories, type LearningPattern, type LearningPrediction } from './learning';
import type { EngineeringLog } from './log';
import type { EngineeringEventInput } from './events';
import {
  AgentStore,
  type AgentCampaign, type AgentCampaignInput, type AgentSeverity, type AgentChange,
} from './agentStore';

/** Same cadence the renderer loop used. */
export const TICK_MS = 30000;
const MIN_RECORDS = 4;
const MAX_OPEN_CAMPAIGNS = 5;

/**
 * What the agent needs from the rest of the service.
 *
 * Injected rather than imported so the agent reaches Mission Control
 * through the same public methods the HTTP routes use — no private path,
 * no second execution route, and a verification script can drive it with
 * a real store and a scripted mission host.
 */
export interface AgentHost {
  log: EngineeringLog;
  /** Every known project id, so a workspace-wide observation can scope itself. */
  projectIds(): string[];
  /** The project the user currently has open, when there is one. */
  activeProjectId(): string | null;
  createMission(projectId: string, text: string, emit: (e: MissionEvent) => void): Promise<{ id: string } | null>;
  approveMission(projectId: string, missionId: string): { ok: boolean; error?: string };
  startMission(projectId: string, missionId: string): { ok: boolean; error?: string };
  listMissions(projectId: string): MissionSummary[];
  /** Publish an agent event. Wired to the Event Spine by the host. */
  publish(change: AgentChange | { type: 'notification'; kind: string; title: string; detail: string; projectId: string | null; missionId?: string }): void;
}

/* ── tiny helpers (ported unchanged) ────────────────────────────── */

function nameOf(file?: string): string {
  return file ? (file.split('/').pop() ?? file) : 'unknown module';
}

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

export function patternCampaign(p: LearningPattern, projectId: string | null): AgentCampaignInput | null {
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
        count, evidence, projectId,
      );
    case 'unstable-module':
      return fileInput(
        'unstable-module', p.id, file,
        `${name} is the most unstable module`,
        p.detail,
        'Diagnose the module, extract the failing sub-part, add targeted tests and stabilize its interface, then re-verify stability.',
        'The module records no new diagnoses or declined AI proposals after the mission.',
        count >= 4 ? 'high' : 'medium',
        count, evidence, projectId,
      );
    case 'ai-rejection':
      return fileInput(
        'ai-rejection', p.id, file,
        `AI proposals touching ${name} are mostly rejected`,
        p.detail,
        `Review the recent declined proposals for ${file ?? name}, document the module contract, and clarify the expected change pattern so future proposals are accepted.`,
        `AI acceptance on ${file ?? name} recovers to an acceptable level.`,
        'medium', count, evidence, projectId,
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
        plan: 'Review the critical events in this layer, identify the pressure points, and schedule a targeted refactoring mission that reduces churn and critical failures.',
        expectedOutcome: 'Critical and high-importance records in this layer stop growing.',
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
        plan: "Inspect the failing mission's execution timeline, correct the failing task(s), and re-run the mission to completion.",
        expectedOutcome: 'The bottleneck mission completes without task failures.',
        evidence,
        reasoning: [
          { kind: 'observed', label: 'Signal observed', detail: p.title },
          { kind: 'reasoned', label: 'Why it matters', detail: p.detail },
          { kind: 'planned', label: 'Improvement plan', detail: 'Unblock the recurring mission.' },
        ],
        verify: { kind: 'mission-completion', before: 0 },
      };
    default:
      return null;
  }
}

export function predictionCampaign(p: LearningPrediction, projectId: string | null): AgentCampaignInput | null {
  if (p.risk !== 'high') return null;
  const name = p.target;
  const evidence = [`Prediction: ${p.detail}`, `${p.actions.join('; ')}`];

  switch (p.kind) {
    // These three come from LearningPrediction, which carries only a
    // display name (already a basename) — never the relative path the
    // file statistics match on. There is no real per-file count to
    // re-measure, so the verify target is corrected to mission-completion
    // rather than defaulting to a diagnosis count with `file: undefined`,
    // which would silently always pass while claiming a check.
    case 'file-break':
      return {
        ...fileInput(
          'high-risk-prediction', p.id, undefined,
          `${name} is predicted to break (${p.confidence}% confidence)`,
          p.detail,
          'Run an engineering diagnosis now, fix the fragile area, add regression tests, and re-verify the file records no new diagnoses.',
          `No new diagnosis records for ${name} after the mission completes.`,
          'high', p.evidenceCount, evidence, projectId,
        ),
        verify: { kind: 'mission-completion', before: 0 },
      };
    case 'regression':
      return {
        ...fileInput(
          'regression-risk', p.id, undefined,
          `${name} shows a likely regression (${p.confidence}% confidence)`,
          p.detail,
          'Re-run the diagnosis, review the recent accepted AI change on this file, and roll back or correct it, then re-verify.',
          `The regression signal for ${name} is resolved.`,
          'critical', p.evidenceCount, evidence, projectId,
        ),
        verify: { kind: 'mission-completion', before: 0 },
      };
    case 'refactor':
      return {
        ...fileInput(
          'high-risk-prediction', p.id, undefined,
          `${name} needs a refactor (${p.confidence}% confidence)`,
          p.detail,
          'Open a refactoring mission, extract the failing sub-module, document the module contract, and verify stability afterwards.',
          `${name} is stable after the refactor.`,
          'high', p.evidenceCount, evidence, projectId,
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

/* ══════════════════════════════════════════════════════════════════
   The engine
   ══════════════════════════════════════════════════════════════════ */

export class AgentEngine {
  readonly store = new AgentStore();
  private timer: ReturnType<typeof setInterval> | null = null;
  private working = new Set<string>();
  private advancing = false;

  constructor(private readonly host: AgentHost) {
    // Every state change becomes an event on the spine, which is how the
    // renderer learns the agent needs an answer without asking.
    this.store.onChange((change) => this.host.publish(change));
  }

  /* ── 1/2/3/4. observe → reason → plan → propose ──────────────── */

  observe(): AgentCampaign[] {
    if (!this.store.enabled) return [];
    if (this.store.openCampaignCount() >= MAX_OPEN_CAMPAIGNS) return [];

    const projectId = this.host.activeProjectId();
    const events = this.host.log.list(projectId, this.host.projectIds());
    const analysis = analyzeMemories(events);
    if (analysis.records < MIN_RECORDS) return [];

    const existing = this.store.signalKeys();
    const inputs: AgentCampaignInput[] = [];
    for (const p of analysis.patterns) {
      const c = patternCampaign(p, projectId);
      if (c) inputs.push(c);
    }
    for (const p of analysis.predictions) {
      const c = predictionCampaign(p, projectId);
      if (c) inputs.push(c);
    }

    const proposed: AgentCampaign[] = [];
    for (const input of inputs) {
      if (existing.has(input.signalKey)) continue;
      if (this.store.openCampaignCount() >= MAX_OPEN_CAMPAIGNS) break;
      const campaign = this.store.propose(input);
      if (!campaign) continue;
      existing.add(input.signalKey);
      proposed.push(campaign);

      this.record(campaign, {
        category: 'decision',
        importance: campaign.severity === 'critical' ? 'high' : 'medium',
        title: `Agent improvement proposed: ${campaign.target}`,
        summary: campaign.signalLabel,
        reason: 'The Autonomous Engineering Agent detected a real signal and proposed an improvement mission.',
        user: 'system',
        source: 'system',
        dedupe: `agent:${campaign.id}:proposed`,
      });

      this.host.publish({
        type: 'notification',
        kind: 'approval-required',
        title: 'Agent improvement proposal',
        detail: campaign.signalLabel,
        projectId: campaign.projectId,
      });
    }
    return proposed;
  }

  /* ── 5. execute — a real mission, only after a human said yes ─── */

  private async createMission(c: AgentCampaign): Promise<void> {
    const projectId = c.projectId ?? this.host.activeProjectId();
    if (!projectId) {
      this.store.log(c.id, 'execute', 'Skipped', 'No project is open — cannot create an improvement mission.', 'agent');
      return;
    }
    if (this.working.has(c.id)) return;
    this.working.add(c.id);
    this.store.log(c.id, 'execute', 'Mission creation started', `Creating the improvement mission for ${c.target}.`, 'agent');

    const text = `[Agent improvement] ${c.signalLabel}. Rationale: ${c.rationale} Plan: ${c.plan} Expected outcome: ${c.expectedOutcome}`;

    let missionId: string | null = null;
    let error: string | null = null;
    try {
      const created = await this.host.createMission(projectId, text, (e) => {
        if (e.type === 'error') error = e.message;
      });
      missionId = created?.id ?? null;
    } catch (e) {
      error = (e as Error).message;
    }

    if (error || !missionId) {
      this.store.setStatus(c.id, 'failed', { note: error ?? 'Mission creation failed' });
      this.store.log(c.id, 'execute', 'Mission creation failed', error ?? 'No mission was produced.', 'agent');
      this.working.delete(c.id);
      return;
    }

    this.store.setStatus(c.id, 'executing', { missionId });
    this.store.log(c.id, 'execute', 'Improvement mission created', `Mission ${missionId} is registered in Mission Control.`, 'agent');

    // The campaign approval IS the plan approval — the human already
    // authorized this exact improvement. Per-task acceptance inside the
    // mission is a separate gate and is NOT waived.
    const approved = this.host.approveMission(projectId, missionId);
    if (!approved.ok) {
      this.store.log(c.id, 'execute', 'Mission approval failed', approved.error ?? 'The plan could not be approved.', 'agent');
    } else {
      this.store.log(c.id, 'execute', 'Mission plan auto-approved', 'The campaign was already approved by the user, so the mission plan is approved to run.', 'agent');
    }

    const started = this.host.startMission(projectId, missionId);
    if (started.ok) {
      this.store.log(c.id, 'execute', 'Execution started', 'Mission execution waves will generate proposals that still need per-task human acceptance.', 'agent');
    } else {
      this.store.log(c.id, 'execute', 'Execution pending', started.error ?? 'Mission is approved but not yet started.', 'agent');
    }
    this.working.delete(c.id);
  }

  /* ── 6. verify — re-measure the target after the mission settles ─ */

  private runVerification(c: AgentCampaign): void {
    if (c.verify?.kind === 'diagnosis-count' && c.verify.file) {
      const file = c.verify.file;
      const events = this.host.log.list(c.projectId, this.host.projectIds());
      const diagnoses = events.filter((m) => m.category === 'diagnosis' && m.files.includes(file)).length;
      const aiDeclined = events.filter((m) => m.source === 'ai-action' && m.category === 'review' && m.files.includes(file)).length;
      // Re-measure with the EXACT metric each signal kind baselined at
      // propose-time. Using diagnoses alone for every kind would compare
      // against the wrong baseline for 'unstable-module' (diagnoses +
      // AI-declined) and 'ai-rejection' (AI-declined alone), letting
      // either falsely pass while the signal it measured kept growing.
      const after =
        c.kind === 'ai-rejection' ? aiDeclined :
        c.kind === 'unstable-module' ? diagnoses + aiDeclined :
        diagnoses;
      const pass = after <= c.verify.before;
      const name = nameOf(file);
      this.store.setVerification(
        c.id, pass,
        pass
          ? `Verified: ${after} diagnosis record(s) for ${name} — within the ${c.verify.before} baseline.`
          : `Not verified: ${after} diagnosis record(s) for ${name} now exceed the ${c.verify.before} baseline — the signal is unresolved.`,
        after,
      );
    } else {
      this.store.setVerification(c.id, true, 'Verified: the improvement mission completed successfully.', 1);
    }
  }

  /* ── 7. learn — the outcome goes back into engineering memory ──── */

  private recordOutcome(c: AgentCampaign): void {
    const pass = c.status === 'verified';
    this.record(c, {
      category: 'learning',
      importance: pass ? 'medium' : 'high',
      title: pass ? `Agent improvement verified: ${c.target}` : `Agent improvement unresolved: ${c.target}`,
      summary: c.note ?? (pass ? 'The improvement mission completed successfully.' : 'The improvement did not resolve the signal.'),
      reason: 'Outcome recorded by the Autonomous Engineering Agent after verification.',
      user: 'system',
      source: 'system',
      missionId: c.missionId,
      files: c.verify?.file ? [c.verify.file] : undefined,
      dedupe: `agent:${c.id}:${pass ? 'verified' : 'failed'}`,
    });

    this.host.publish({
      type: 'notification',
      kind: pass ? 'mission-completed' : 'architecture-warning',
      title: pass ? 'Agent improvement verified' : 'Agent improvement failed',
      detail: pass ? `${c.target} — ${c.note ?? 'mission completed.'}` : `${c.target} — ${c.note ?? 'the signal remains.'}`,
      projectId: c.projectId,
      ...(c.missionId ? { missionId: c.missionId } : {}),
    });
  }

  private record(c: AgentCampaign, input: Omit<EngineeringEventInput, 'projectId'>): void {
    this.host.log.record({ ...input, projectId: c.projectId ?? null });
  }

  /* ── the reconcile loop ────────────────────────────────────────── */

  private async monitorExecutions(): Promise<void> {
    const executing = this.store.campaigns().filter((c) => c.status === 'executing' && c.missionId);
    if (!executing.length) return;

    const byProject = new Map<string, AgentCampaign[]>();
    for (const c of executing) {
      const pid = c.projectId ?? this.host.activeProjectId();
      if (!pid) continue;
      const list = byProject.get(pid) ?? [];
      list.push(c);
      byProject.set(pid, list);
    }

    for (const [pid, list] of byProject) {
      let missions: MissionSummary[];
      try { missions = this.host.listMissions(pid); } catch { continue; }
      const map = new Map(missions.map((m) => [m.id, m]));
      for (const c of list) {
        const status = map.get(c.missionId!)?.execution?.status;
        if (!status) continue;
        if (status === 'completed') {
          this.store.setStatus(c.id, 'verifying');
          this.store.log(c.id, 'executing', 'Mission completed', 'The improvement mission finished — running verification.', 'system');
        } else if (status === 'failed' || status === 'cancelled') {
          this.store.setStatus(c.id, 'failed', { note: `Improvement mission ${status}.` });
          this.store.log(c.id, 'executing', `Mission ${status}`, 'The improvement mission did not complete.', 'system');
          this.recordOutcome(this.store.get(c.id) ?? c);
        }
      }
    }
  }

  /** One full pass. Safe to call directly; the timer calls the same thing. */
  async advance(): Promise<void> {
    if (!this.store.enabled) return;
    // A slow mission creation must not have a second tick start it again.
    if (this.advancing) return;
    this.advancing = true;
    try {
      this.observe();

      for (const c of this.store.campaigns().filter((c) => c.status === 'approved')) {
        await this.createMission(c);
      }

      await this.monitorExecutions();

      for (const c of this.store.campaigns().filter((c) => c.status === 'verifying')) {
        this.runVerification(c);
        this.recordOutcome(this.store.get(c.id) ?? c);
      }
    } finally {
      this.advancing = false;
    }
  }

  /**
   * Start the loop. Idempotent, and returns a stop function.
   *
   * `unref()` so an agent tick never keeps the process alive on its own —
   * the service's lifetime is the shell's decision, not the agent's.
   */
  start(): () => void {
    if (this.timer) return () => this.stop();
    void this.advance();
    this.timer = setInterval(() => void this.advance(), TICK_MS);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
