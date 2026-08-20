import {
  KeywordIntentClassifier,
  TemplatePromptEnhancer,
  createRequest,
  type ConversationTurn,
} from '@aura/intelligence';
import { CodingKnowledgeEngine } from '@aura/knowledge-coding';
import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
import type { GenerateRequest, Runtime, RuntimeMessage } from '@aura/runtime';
import { DEFAULT_SETTINGS, type AiSettings } from './settings';
import { ProjectMemory, type MemoryItem } from './memory';
import { loadProfile, type ProjectProfile } from './profile';
import { homePath } from './persist';
import { RuntimeManager } from './provider';
import type { RouteCandidate, RouteDecision, RouteRequest } from './provider/router';
import { countTokensSync } from './tokenizer';
import { isModelValidForProvider } from './provider/modelValidation';
import { ProviderHttpError, translateProviderError } from './provider/errorTranslator';
import { runGraphify } from './graphify';
import {
  runIntelligencePipeline,
  type IntelligenceEngineResult,
  type ProjectIdentity,
  type RepositorySummary,
  type RepositoryProfile,
  type ProjectGlossary,
  type RepositoryHealth,
  type RepositoryIntentType,
  type AssembledContext,
  type IndexResult,
} from './intelligence';

export interface MountTarget {
  id: string;
  path: string;
  name?: string;
}

export interface IndexStatus {
  projectId: string | null;
  phase: 'empty' | 'indexing' | 'ready' | 'error';
  coding: { processed: number; total: number; chunks: number };
  fullstack: { processed: number; total: number; entities: number; relations: number };
  message: string;
  error?: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Mount {
  id: string;
  path: string;
  coding: CodingKnowledgeEngine;
  fullstack: FullStackKnowledgeEngine;
  memory: ProjectMemory;
  profile: ProjectProfile | null;
}

export interface NormalizedError { type: string; message: string; retryable: boolean }

/**
 * A tree diff plus the observation it came from, taken once per request.
 * Threaded rather than recomputed so one Ask AURA request walks the
 * repository once. See `scanAndDiff` in intelligence/performance.ts.
 */
export type TreeScan = { result: IndexResult; snapshot: Record<string, number> };

/**
 * Classifies thrown errors into a stable, user-facing shape. Provider
 * adapters throw `ProviderHttpError` on non-2xx HTTP responses (see
 * provider/adapters/base.ts and friends), which carries the real status +
 * response body — errorTranslator.ts turns that into a friendly, correctly
 * categorized message (e.g. a 403 body of "NOT_ENOUGH_BALANCE" becomes a
 * billing error, not "Authentication failed"), never a raw provider
 * payload. `AbortError`/`TimeoutError` and generic network failures are
 * handled here directly since they never reach a provider response at all.
 */
function normalize(e: unknown, providerLabel?: string): NormalizedError {
  const err = e as Error;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return { type: 'timeout', message: providerLabel ? `The request to ${providerLabel} timed out.` : 'The request timed out.', retryable: true };
  }
  if (e instanceof ProviderHttpError) {
    return translateProviderError(e.providerName, e.status, e.body);
  }
  const message = err?.message ?? String(e);
  // Defensive fallback for any error that reaches here as a plain Error
  // instead of a ProviderHttpError (e.g. a future adapter that forgets to
  // throw the structured form) — parses the same "<Provider> error
  // <status>: <body>" shape adapters format their messages as, so nothing
  // regresses to a raw, uncategorized provider string.
  const statusMatch = /\berror (\d{3}):\s*([\s\S]*)$/i.exec(message);
  if (statusMatch) {
    return translateProviderError(providerLabel ?? 'The AI provider', Number(statusMatch[1]), statusMatch[2]);
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message)) {
    const label = providerLabel ?? 'the AI provider';
    return { type: 'network', message: `Could not reach ${label}.\n\nCheck your network connection and try again.`, retryable: true };
  }
  return { type: 'unknown', message, retryable: false };
}

/** Races `fn` against `timeoutMs`, cancelling the in-flight runtime call on timeout. */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      const e = new Error('Request timed out');
      e.name = 'TimeoutError';
      reject(e);
    }, timeoutMs);
  });
  return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
}

/** Retries only classifications marked `retryable`, with capped exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; signal?: AbortSignal; providerLabel?: string },
): Promise<{ ok: true; value: T } | { ok: false; error: NormalizedError }> {
  let lastError: NormalizedError = { type: 'unknown', message: 'Unknown error', retryable: false };
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) return { ok: false, error: { type: 'aborted', message: 'Cancelled', retryable: false } };
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      lastError = normalize(e, opts.providerLabel);
      if (!lastError.retryable || attempt === opts.maxRetries) break;
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Minimum gap between two PROGRESS announcements on the status channel.
 * Phase transitions ignore it — see `announceStatus`.
 */
const PROGRESS_ANNOUNCE_MS = 400;

/**
 * Failure kinds that justify trying a DIFFERENT provider.
 *
 * Deliberately narrow. These are the failures that say "this provider
 * cannot serve you right now" — the machine is offline, the account is
 * rate-limited or out of credit, the key is bad, the gateway is down.
 *
 * Everything else stays on the provider the user chose. A malformed
 * request or a refusal is not a reason to shop the same request around:
 * it will fail identically everywhere, and quietly re-sending a user's
 * prompt to a second company because the first said no is a privacy
 * decision disguised as resilience.
 */
const FAILOVER_ERRORS = new Set(['network', 'timeout', 'rate_limit', 'billing', 'server_error', 'auth', 'authorization', 'no_provider']);

const NO_PROVIDER: NormalizedError = {
  type: 'no_provider',
  message: 'No AI provider connected. Add your API key in Settings to use AURA\'s AI.',
  retryable: false,
};

// Sent instead of ever making a request for a provider/model pair that
// isn't real — this is what stands between the user and a raw provider
// 404. See provider/modelValidation.ts for what "valid" means. Type
// 'configuration' matches errorTranslator's category scheme (this is the
// "invalid provider/model combination" case caught before a request is
// ever sent, rather than one translated from a provider's response).
const INVALID_MODEL: NormalizedError = {
  type: 'configuration',
  message: 'The selected model is not available for the active provider.',
  retryable: false,
};

export interface InspectResult {
  intent: RepositoryIntentType;
  intentConfidence: number;
  enhancedPrompt: string;
  systemHints: string[];
  engines: string[];
  coding: { files: string[]; chunks: number; tokens: number };
  fullstack: { hits: string[]; paths: string[] };
  memory: { items: { id: string; kind: string; title: string }[]; tokens: number };
  contextTokens: number;
  projectId: string | null;
  identity: ProjectIdentity | null;
  summary: RepositorySummary | null;
  repoProfile: RepositoryProfile | null;
  glossary: ProjectGlossary | null;
  health: RepositoryHealth | null;
  assembledContext: AssembledContext;
}

export type StreamEmit =
  | { type: 'meta'; meta: InspectResult }
  | { type: 'token'; text: string }
  | {
      type: 'done'; usage: unknown; finishReason: string; citations: unknown; latencyMs: number;
      trace: unknown; provider: string; engineId: string;
      /** Which model answered, what else was considered, and why not. */
      routing?: RoutingReport;
    }
  | { type: 'error'; error: NormalizedError };

export interface PipelineOptions {
  baseUrl?: string;
  keyFile?: string;
}

export interface ProviderStatus {
  type: 'byoak' | 'none';
  providerId: string | null;
  label: string;
  model: string;
}

/**
 * What the router decided, in a shape that can travel to the UI.
 *
 * Carried on every answer AND every refusal: "which model answered, and
 * what else was considered and why not" is not diagnostics, it is the
 * thing that makes an automatic failover legible instead of spooky.
 */
export interface RoutingReport {
  rule: string;
  detail: string;
  chosen: { providerId: string; modelId: string; local: boolean } | null;
  /** Candidates actually contacted, in order. Length > 1 means a failover happened. */
  attempted: { providerId: string; modelId: string; local: boolean }[];
  rejected: { providerId: string; modelId: string; rule: string; reason: string }[];
}

function routingReport(decision: RouteDecision, attempted: RouteCandidate[], chosen?: RouteCandidate): RoutingReport {
  const brief = (c: RouteCandidate) => ({ providerId: c.providerId, modelId: c.modelId, local: c.local });
  return {
    rule: decision.rule,
    detail: decision.detail,
    chosen: chosen ? brief(chosen) : null,
    attempted: attempted.map(brief),
    rejected: decision.rejected,
  };
}

export class PipelineManager {
  private mounted: Mount | null = null;
  readonly runtimeManager: RuntimeManager;
  private settings: AiSettings = { ...DEFAULT_SETTINGS };
  private readonly classifier = new KeywordIntentClassifier();
  private readonly enhancer = new TemplatePromptEnhancer();
  private status: IndexStatus = emptyStatus();
  private indexing: Promise<void> | null = null;
  /**
   * Who wants to be told when index status moves.
   *
   * The pipeline stays the ONE authority on index status — this adds no
   * second status model, it only stops the answer being reachable solely
   * by asking again on a timer. The host (server.ts) forwards these onto
   * the Event Spine, which is what retires the renderer's 600 ms poll.
   */
  private statusListeners = new Set<(s: IndexStatus) => void>();
  /** Last phase actually announced, so progress noise is not announced as a transition. */
  private announcedPhase: IndexStatus['phase'] | null = null;
  private lastProgressAnnounceAt = 0;

  constructor(_opts: PipelineOptions = {}) {
    this.runtimeManager = new RuntimeManager();
  }

  get providerStatus(): ProviderStatus {
    const mgr = this.runtimeManager;
    return {
      type: mgr.providerType,
      providerId: mgr.getProviderId(),
      label: mgr.providerLabel,
      model: mgr.getModel(),
    };
  }

  /* ── project mount + indexing ───────────────────────────────────── */

  get currentProjectId(): string | null {
    return this.mounted?.id ?? null;
  }
  get coding(): CodingKnowledgeEngine | null {
    return this.mounted?.coding ?? null;
  }
  get fullstack(): FullStackKnowledgeEngine | null {
    return this.mounted?.fullstack ?? null;
  }
  get memory(): ProjectMemory | null {
    return this.mounted?.memory ?? null;
  }
  get profile(): ProjectProfile | null {
    return this.mounted?.profile ?? null;
  }
  indexStatus(): IndexStatus {
    return { ...this.status };
  }

  /**
   * Subscribe to index-status movement. Returns an unsubscribe function.
   *
   * Fires on every PHASE transition immediately, and on indexing progress
   * at most once every `PROGRESS_ANNOUNCE_MS` — a push channel that
   * repeated every file would be a busier poll, not a replacement for one.
   */
  onStatusChange(listener: (status: IndexStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /**
   * Announce the current status.
   *
   * `force` is used by phase transitions, which are never throttled: the
   * whole reason a caller waits is to learn that `indexing` became `ready`.
   */
  private announceStatus(force: boolean): void {
    if (!this.statusListeners.size) return;
    const phaseChanged = this.status.phase !== this.announcedPhase;
    if (!force && !phaseChanged) {
      const now = Date.now();
      if (now - this.lastProgressAnnounceAt < PROGRESS_ANNOUNCE_MS) return;
      this.lastProgressAnnounceAt = now;
    } else {
      this.lastProgressAnnounceAt = Date.now();
    }
    this.announcedPhase = this.status.phase;
    const snapshot = this.indexStatus();
    for (const listener of this.statusListeners) {
      try { listener(snapshot); } catch { /* a listener's failure is not the pipeline's */ }
    }
  }

  mount(target: MountTarget): void {
    if (this.mounted?.id === target.id) return;
    const coding = new CodingKnowledgeEngine(target.path, {
      indexDir: homePath('index', target.id, 'coding'),
      projectName: target.name ?? target.id,
    });
    const fullstack = new FullStackKnowledgeEngine(target.path, {
      indexDir: homePath('index', target.id, 'fullstack'),
      projectName: target.name ?? target.id,
    });
    const projectProfile = loadProfile(target.id);
    this.mounted = { id: target.id, path: target.path, coding, fullstack, memory: new ProjectMemory(target.id), profile: projectProfile };
    this.status = { ...emptyStatus(), projectId: target.id, phase: 'indexing', message: 'Preparing index…', startedAt: new Date().toISOString() };
    this.announceStatus(true);
    this.indexing = this.runIndex(false);
    // The provider is a pure, stateless inference engine — it is never
    // pointed at the repository. AURA does all repository understanding and
    // hands the model fully-assembled context each turn.
  }

  unmount(): void {
    this.mounted = null;
    this.status = emptyStatus();
    this.announceStatus(true);
  }

  async whenIndexed(): Promise<IndexStatus> {
    if (this.indexing) await this.indexing;
    return this.indexStatus();
  }

  async reindex(): Promise<IndexStatus> {
    if (!this.mounted) return this.indexStatus();
    // Coalesce concurrent reindex calls (e.g. an impatient double-click) onto
    // the run already in flight, rather than starting a second full pass
    // that races the first over the same on-disk store.
    if (this.status.phase === 'indexing' && this.indexing) {
      await this.indexing;
      return this.indexStatus();
    }
    this.indexing = this.runIndex(true);
    await this.indexing;
    return this.indexStatus();
  }

  private async runIndex(force: boolean): Promise<void> {
    const m = this.mounted;
    if (!m) return;
    // Guards every status write below: if the user switches projects while
    // this run is still in flight, `this.mounted` moves on to the new
    // project and this now-superseded run must stop touching shared status
    // instead of corrupting it with stale progress from a project that's no
    // longer active.
    const isCurrent = () => this.mounted?.id === m.id;
    this.status = { ...this.status, phase: 'indexing', message: 'Indexing code…', error: undefined, startedAt: new Date().toISOString(), finishedAt: null };
    this.announceStatus(true);
    try {
      if (force || !(await m.coding.load())) {
        await m.coding.index({ onProgress: (p) => { if (!isCurrent()) return; this.status.coding.processed = p.processed; this.status.coding.total = p.total ?? this.status.coding.total; this.announceStatus(false); } });
      }
      if (!isCurrent()) return;
      this.status.coding.chunks = m.coding.stats().chunks;
      this.status.message = 'Analyzing system graph…';
      this.announceStatus(false);
      if (force || !(await m.fullstack.load())) {
        await m.fullstack.analyze({ onProgress: (p) => { if (!isCurrent()) return; this.status.fullstack.processed = p.processed; this.status.fullstack.total = p.total ?? this.status.fullstack.total; this.announceStatus(false); } });
      }
      if (!isCurrent()) return;
      const g = m.fullstack.stats();
      this.status.fullstack.entities = g.entities;
      this.status.fullstack.relations = g.relations;
      this.status = { ...this.status, phase: 'ready', message: 'Knowledge ready', finishedAt: new Date().toISOString() };
      this.announceStatus(true);
      // Fire-and-forget: run graphify to build the knowledge graph visualization.
      // This is non-blocking — the graph.html will appear once it finishes.
      try { runGraphify(m.id, m.path); } catch { /* graphify failure is non-fatal */ }
    } catch (e) {
      if (!isCurrent()) return;
      this.status = { ...this.status, phase: 'error', error: (e as Error).message, message: 'Indexing failed', finishedAt: new Date().toISOString() };
      this.announceStatus(true);
    }
  }

  /* ── settings (global across projects) ───────────────────────────── */

  getSettings(): AiSettings {
    return { ...this.settings };
  }
  setSettings(partial: Partial<AiSettings>): AiSettings {
    this.settings = { ...this.settings, ...partial };
    return this.getSettings();
  }

  setKey(_apiKey: string, _persist = false): { ok: boolean; fingerprint: string; reason?: string } {
    return { ok: true, fingerprint: '(configured)' };
  }
  clearKey(): void {}
  keyStatus(): { configured: boolean; fingerprint: string } {
    const connected = this.runtimeManager.hasRuntime;
    return { configured: connected, fingerprint: connected ? this.runtimeManager.providerLabel : '(no provider)' };
  }

  health() {
    const runtime = this.runtimeManager.runtime;
    if (!runtime) return Promise.resolve({ ok: false, status: 'offline' as const, latencyMs: 0, error: 'No AI provider connected' });
    return runtime.health();
  }

  /* ── real project views ─────────────────────────────────────────── */

  graphView() {
    if (!this.mounted) return { entities: [], relations: [], stats: null as unknown };
    return this.mounted.fullstack.graph();
  }

  retrieve(text: string, limit = 6) {
    if (!this.mounted || !text.trim()) return { entries: [], totalTokens: 0 };
    const ctx = this.mounted.coding.getContext({ text, limit: 24 }, { limit, neighbors: 1, maxTokens: 3000 });
    return {
      entries: ctx.entries.map((e) => ({
        source: e.source,
        score: e.score,
        snippet: e.chunks.map((c) => c.chunk.text).join('\n').slice(0, 1200),
        lines: e.chunks.map((c) => ({ start: c.chunk.startLine, end: c.chunk.endLine })),
      })),
      totalTokens: ctx.totalTokens,
    };
  }

  /* ── memory passthrough ─────────────────────────────────────────── */

  addMemory(item: Parameters<ProjectMemory['add']>[0]): MemoryItem | null {
    return this.mounted?.memory.add(item) ?? null;
  }

  /* ── inspection (single pass — no double work) ─────────────────── */

  /**
   * `scan` is a tree diff+snapshot already taken this request. Passing it
   * lets one Ask AURA request walk the repository ONCE instead of twice —
   * the Context Fabric composes a view before this runs, and both need the
   * same answer to "what changed?".
   */
  async inspect(text: string, scan?: TreeScan): Promise<InspectResult> {
    const m = this.mounted;
    const req = createRequest(text);
    const intent = await this.classifier.classify(req);
    const prompt = await this.enhancer.enhance(req, intent);

    // Single retrieval pass — coding engine
    let coding = { files: [] as string[], chunks: 0, tokens: 0 };
    let codingContextText = '';
    if (m) {
      const c = m.coding.getContext({ text: prompt.enhanced, limit: 24 }, { limit: 6, neighbors: 1, maxTokens: 3000 });
      coding = { files: c.entries.map((e) => e.source), chunks: c.entries.reduce((s, e) => s + e.chunks.length, 0), tokens: c.totalTokens };
      if (c.entries.length > 0) {
        codingContextText = c.entries.map((e) => {
          const snippets = e.chunks.map((c) => c.chunk.text).join('\n').slice(0, 1200);
          return `File: ${e.source}\n\`\`\`\n${snippets}\n\`\`\``;
        }).join('\n\n');
      }
    }

    // Single retrieval pass — fullstack engine
    let fullstack = { hits: [] as string[], paths: [] as string[] };
    let fsTokens = 0;
    let graphContextText = '';
    if (m) {
      const a = m.fullstack.search({ text: prompt.enhanced, limit: 8 });
      fullstack = {
        hits: a.hits.map((h) => `${h.entity.kind}: ${h.entity.name}`),
        paths: a.paths.filter((p) => p.entities.length >= 2).slice(0, 6).map((p) => {
          let s = p.entities[0].name;
          for (let i = 0; i < p.relations.length; i++) s += ` → ${p.relations[i].kind} → ${p.entities[i + 1]?.name ?? '?'}`;
          return s;
        }),
      };
      fsTokens = a.hits.reduce((s, h) => s + (h.entity.summary?.length ?? 0) / 4, 0) + fullstack.paths.reduce((s, p) => s + p.length / 4, 0);
      if (a.hits.length > 0) {
        const archLines = a.hits.map((h) => {
          let desc = `${h.entity.kind}: ${h.entity.name}`;
          if (h.entity.summary) desc += ` — ${h.entity.summary}`;
          return desc;
        });
        graphContextText = `Entities:\n${archLines.join('\n')}\n\nRelations:\n${fullstack.paths.join('\n')}`;
      }
    }

    // Single retrieval pass — memory
    let memory = { items: [] as { id: string; kind: string; title: string }[], tokens: 0 };
    let memoryContextText = '';
    if (m) {
      const hits = m.memory.recall(prompt.enhanced || text, 4);
      memory = {
        items: hits.map((h) => ({ id: h.id, kind: h.kind, title: h.title })),
        tokens: hits.reduce((s, h) => s + h.body.length / 4, 0),
      };
      if (hits.length > 0) {
        memoryContextText = hits.map((h) => `[${h.kind}] ${h.title}\n${h.body.slice(0, 500)}`).join('\n\n');
      }
    }

    // Run intelligence engine (identity, summary, profile, glossary, health, context assembly)
    let intelResult: IntelligenceEngineResult | null = null;
    if (m) {
      intelResult = runIntelligencePipeline(
        m.id,
        m.path,
        text,
        m.profile,
        codingContextText,
        graphContextText,
        memoryContextText,
        coding.files,
        scan,
      );
    }

    return {
      intent: intelResult?.intent.type ?? intent.type as RepositoryIntentType,
      intentConfidence: intelResult?.intent.confidence ?? intent.confidence,
      enhancedPrompt: prompt.enhanced,
      systemHints: prompt.systemHints,
      engines: [...(m && coding.files.length ? ['coding'] : []), ...(m && fullstack.hits.length ? ['fullstack'] : []), ...(memory.items.length ? ['memory'] : [])],
      coding,
      fullstack,
      memory,
      contextTokens: coding.tokens + fsTokens + memory.tokens + (intelResult?.context.totalTokens ?? 0),
      projectId: m?.id ?? null,
      identity: intelResult?.identity ?? null,
      summary: intelResult?.summary ?? null,
      repoProfile: intelResult?.profile ?? null,
      glossary: intelResult?.glossary ?? null,
      health: intelResult?.health ?? null,
      assembledContext: intelResult?.context ?? { systemMessages: [], totalTokens: 0, confidenceMarks: [], retrievedSources: [] },
    };
  }

  /* ── context assembly (uses intelligence engine output) ──────────── */

  /**
   * Build the message list for one request.
   *
   * `auraContext` is the canonical project contract for THIS request and
   * is passed down the call path rather than held on the instance.
   *
   * It used to be stored as `this.auraContext`, set by the host just
   * before `ask`/`streamEvents`. That was a correctness bug:
   * `PipelineManager` is a single instance shared by every request, and
   * both entry points `await this.inspect(...)` before reading the field.
   * Two overlapping requests therefore interleaved — the second one's
   * context overwrote the first's while the first was suspended, and the
   * first answered about the second's project. Request-scoped data cannot
   * live in singleton mutable state; the parameter is the fix.
   *
   * The pipeline still does not COMPOSE the contract — composing needs
   * live service state it does not own, and a second collector here is
   * how Ask AURA and delegated agents would start describing the same
   * project differently. It only carries what the host handed it.
   */
  private buildContextMessages(
    text: string,
    meta: InspectResult,
    history?: ConversationTurn[],
    auraContext?: string | null,
  ): { messages: RuntimeMessage[]; info: { contextTokens: number } } {
    const messages: RuntimeMessage[] = [];

    /* Canonical project context leads. It states WHAT IS TRUE about the
       project — identity, branch, environment, capabilities, freshness —
       ahead of the assembler's retrieval-derived material below, which
       supplies specifics. Ordering matters: freshness has to be readable
       before the facts it qualifies. */
    if (auraContext) {
      messages.push({ role: 'system', content: auraContext });
    }

    // Use the intelligence engine's assembled context as the system message
    // This is the single source of truth — no rebuilding
    if (meta.assembledContext.systemMessages.length > 0) {
      messages.push(...meta.assembledContext.systemMessages);
    }

    // Add conversation history
    if (history?.length) {
      for (const h of history) messages.push({ role: h.role, content: h.content });
    }

    // Add user message
    messages.push({ role: 'user', content: text });

    return { messages, info: { contextTokens: meta.assembledContext.totalTokens } };
  }

  /* ── generation ─────────────────────────────────────────────────── */

  /* ── routed generation (§ provider fallback chain) ──────────────── */

  /**
   * Run one model call along the router's chain.
   *
   * Two loops, and they are different loops on purpose:
   *
   *   • the INNER one is `withRetry` — same provider, transient error,
   *     backoff. Unchanged, and still the right response to a blip.
   *   • the OUTER one is this: the provider itself cannot serve the
   *     request, so move to the next candidate the router chose.
   *
   * The active provider is never reassigned. A request that failed over
   * ran somewhere else; the user's chosen provider is still their chosen
   * provider when it is over.
   */
  private async runRouted<T>(
    spec: {
      taskKind: RouteRequest['taskKind'];
      sensitivity: RouteRequest['sensitivity'];
      promptTokens: number;
      expectedOutputTokens?: number;
      requiresTools?: boolean;
      requiresJsonMode?: boolean;
      signal?: AbortSignal;
    },
    call: (runtime: Runtime, label: string) => Promise<T>,
  ): Promise<
    | { ok: true; value: T; candidate: RouteCandidate; label: string; decision: RouteDecision; attempted: RouteCandidate[] }
    | { ok: false; error: NormalizedError; decision: RouteDecision; attempted: RouteCandidate[] }
  > {
    const decision = this.runtimeManager.plan({
      taskKind: spec.taskKind,
      sensitivity: spec.sensitivity,
      promptTokens: spec.promptTokens,
      expectedOutputTokens: spec.expectedOutputTokens ?? this.settings.maxTokens,
      requiresTools: spec.requiresTools,
      requiresJsonMode: spec.requiresJsonMode,
    });

    if (!decision.ok) {
      return {
        ok: false,
        decision,
        attempted: [],
        // A refusal is a decision, not a crash: `retryable: false` because
        // repeating it changes nothing until the machine does.
        error: { type: decision.rule === 'privacy-gate' ? 'configuration' : 'no_provider', message: decision.detail, retryable: false },
      };
    }

    const attempted: RouteCandidate[] = [];
    let lastError: NormalizedError = { type: 'unknown', message: 'No provider was attempted.', retryable: false };

    for (const candidate of decision.chain) {
      if (spec.signal?.aborted) {
        return { ok: false, error: { type: 'aborted', message: 'Cancelled', retryable: false }, decision, attempted };
      }
      const runtime = this.runtimeManager.runtimeFor(candidate);
      if (!runtime) {
        lastError = { type: 'configuration', message: `${candidate.providerName} is connected but produced no runtime.`, retryable: false };
        continue;
      }
      attempted.push(candidate);
      const label = candidate.providerName;
      /* Cancellation has to follow the failover: the caller's abort must
         reach whichever runtime is in flight NOW, not the one that was
         active when the request started. */
      const onAbort = () => runtime.cancel();
      spec.signal?.addEventListener('abort', onAbort);
      let result: Awaited<ReturnType<typeof withRetry<T>>>;
      try {
        result = await withRetry(
          () => withTimeout(() => call(runtime, label), this.settings.timeoutMs, () => runtime.cancel()),
          { maxRetries: this.settings.maxRetries, signal: spec.signal, providerLabel: label },
        );
      } finally {
        spec.signal?.removeEventListener('abort', onAbort);
      }
      if (result.ok) return { ok: true, value: result.value, candidate, label, decision, attempted };
      lastError = result.error;
      if (!FAILOVER_ERRORS.has(result.error.type)) break;
    }
    return { ok: false, error: lastError, decision, attempted };
  }

  async ask(text: string, signal?: AbortSignal, history?: ConversationTurn[], auraContext?: string | null, scan?: TreeScan) {
    const meta = await this.inspect(text, scan);
    const runtime = this.runtimeManager.runtime;
    if (!runtime) return { ok: false as const, error: NO_PROVIDER, meta };
    if (!isModelValidForProvider(this.runtimeManager.getProviderId(), this.runtimeManager.getModel())) {
      return { ok: false as const, error: INVALID_MODEL, meta };
    }
    const t0 = performance.now();
    const onAbort = () => runtime.cancel();
    signal?.addEventListener('abort', onAbort);
    try {
      const { messages } = this.buildContextMessages(text, meta, history, auraContext);
      const request: GenerateRequest = {
        messages,
        temperature: this.settings.temperature,
        maxTokens: this.settings.maxTokens,
      };
      /* Measured, not guessed — the router's context gate refuses a model
         the prompt does not fit, and it can only do that against a real
         count. See tokenizer/. */
      const promptTokens = countTokensSync(
        messages.map((m) => m.content).join('\n'),
        { providerId: this.runtimeManager.getProviderId() ?? undefined, modelId: this.runtimeManager.getModel() },
      ).tokens;

      const routed = await this.runRouted(
        { taskKind: 'chat', sensitivity: this.settings.sensitivity, promptTokens, signal },
        (rt) => rt.generate(request),
      );
      if (!routed.ok) return { ok: false as const, error: routed.error, meta, routing: routingReport(routed.decision, routed.attempted) };
      const providerLabel = routed.label;
      const latencyMs = Math.round(performance.now() - t0);
      return {
        ok: true as const,
        answer: routed.value.content,
        meta,
        intent: meta.intent,
        engineId: providerLabel.toLowerCase().replace(/\s+/g, '-'),
        provider: providerLabel,
        citations: [],
        usage: routed.value.usage,
        finishReason: routed.value.finishReason,
        latencyMs,
        routing: routingReport(routed.decision, routed.attempted, routed.candidate),
        trace: [{ stage: 'generation', startedAt: t0, durationMs: latencyMs, ok: true }],
      };
    } catch (e) {
      return { ok: false as const, error: normalize(e, this.runtimeManager.providerLabel), meta };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async generate(
    input: { system?: string; user: string; json?: boolean },
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string; usage: unknown } | { ok: false; error: NormalizedError }> {
    const runtime = this.runtimeManager.runtime;
    if (!runtime) return { ok: false, error: NO_PROVIDER };
    if (!isModelValidForProvider(this.runtimeManager.getProviderId(), this.runtimeManager.getModel())) {
      return { ok: false, error: INVALID_MODEL };
    }
    const onAbort = () => runtime.cancel();
    signal?.addEventListener('abort', onAbort);
    try {
      const messages: RuntimeMessage[] = [];
      const m = this.mounted;
      if (m?.profile) {
        const id = m.profile;
        messages.push({ role: 'system', content: `[Project Context]\n${id.purpose || id.type} — ${id.primaryLanguage}` });
      }
      if (input.system) messages.push({ role: 'system', content: input.system });
      messages.push({ role: 'user', content: input.user });
      const request: GenerateRequest = {
        messages,
        temperature: this.settings.temperature,
        maxTokens: this.settings.maxTokens,
      };
      if (input.json) request.maxTokens = Math.min(request.maxTokens ?? 4096, 8096);
      const providerLabel = this.runtimeManager.providerLabel;
      const result = await withRetry(
        () => withTimeout(() => runtime.generate(request), this.settings.timeoutMs, () => runtime.cancel()),
        { maxRetries: this.settings.maxRetries, signal, providerLabel },
      );
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, text: result.value.content, usage: result.value.usage };
    } catch (e) {
      return { ok: false, error: normalize(e, this.runtimeManager.providerLabel) };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async streamEvents(text: string, emit: (e: StreamEmit) => void, signal?: AbortSignal, history?: ConversationTurn[], auraContext?: string | null, scan?: TreeScan): Promise<void> {
    let meta: InspectResult;
    try {
      meta = await this.inspect(text, scan);
      emit({ type: 'meta', meta });
    } catch (e) {
      emit({ type: 'error', error: normalize(e) });
      return;
    }
    const runtime = this.runtimeManager.runtime;
    if (!runtime) { emit({ type: 'error', error: NO_PROVIDER }); return; }
    if (!isModelValidForProvider(this.runtimeManager.getProviderId(), this.runtimeManager.getModel())) {
      emit({ type: 'error', error: INVALID_MODEL });
      return;
    }
    const t0 = performance.now();
    const { messages } = this.buildContextMessages(text, meta, history, auraContext);
    const request: GenerateRequest = {
      messages,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
    };
    const promptTokens = countTokensSync(
      messages.map((m) => m.content).join('\n'),
      { providerId: this.runtimeManager.getProviderId() ?? undefined, modelId: this.runtimeManager.getModel() },
    ).tokens;

    const decision = this.runtimeManager.plan({
      taskKind: 'chat',
      sensitivity: this.settings.sensitivity,
      promptTokens,
      expectedOutputTokens: this.settings.maxTokens,
    });
    if (!decision.ok) {
      emit({
        type: 'error',
        error: { type: decision.rule === 'privacy-gate' ? 'configuration' : 'no_provider', message: decision.detail, retryable: false },
      });
      return;
    }

    /* Two loops, as in `runRouted`, but the streaming case has one extra
       rule that matters more than either: once a token has reached the
       client, NOTHING may be retried and nothing may fail over — the
       user would see the answer restart, or two answers spliced. A
       mid-stream failure is reported as it happened. */
    let lastError: NormalizedError | null = null;
    const attempted: RouteCandidate[] = [];

    for (const candidate of decision.chain) {
      if (signal?.aborted) return;
      const runtime = this.runtimeManager.runtimeFor(candidate);
      if (!runtime) continue;
      attempted.push(candidate);
      const providerLabel = candidate.providerName;
      const onAbort = () => runtime.cancel();
      signal?.addEventListener('abort', onAbort);
      let sawToken = false;

      try {
        for (let attempt = 0; attempt <= this.settings.maxRetries; attempt++) {
          if (signal?.aborted) return;
          let emittedAnyToken = false;
          try {
            const iterator = runtime.stream(request)[Symbol.asyncIterator]();
            while (true) {
              const next = await withTimeout(() => iterator.next(), this.settings.timeoutMs, () => runtime.cancel());
              if (next.done) break;
              const chunk = next.value;
              if (chunk.delta) { emit({ type: 'token', text: chunk.delta }); emittedAnyToken = true; sawToken = true; }
              if (chunk.done) {
                const latencyMs = Math.round(performance.now() - t0);
                emit({
                  type: 'done',
                  usage: chunk.usage,
                  finishReason: chunk.finishReason ?? 'stop',
                  citations: [],
                  latencyMs,
                  trace: [{ stage: 'generation', startedAt: t0, durationMs: latencyMs, ok: true }],
                  provider: providerLabel,
                  engineId: providerLabel.toLowerCase().replace(/\s+/g, '-'),
                  routing: routingReport(decision, attempted, candidate),
                });
                return;
              }
            }
            return;
          } catch (e) {
            lastError = normalize(e, providerLabel);
            if (emittedAnyToken || !lastError.retryable || attempt === this.settings.maxRetries) break;
            await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }

      // Tokens already went to the user: this answer is theirs, broken or
      // not. Failing over now would emit a second one after the first.
      if (sawToken) break;
      if (!lastError || !FAILOVER_ERRORS.has(lastError.type)) break;
    }

    emit({ type: 'error', error: lastError ?? { type: 'unknown', message: 'Unknown error', retryable: false } });
  }
}

function emptyStatus(): IndexStatus {
  return {
    projectId: null,
    phase: 'empty',
    coding: { processed: 0, total: 0, chunks: 0 },
    fullstack: { processed: 0, total: 0, entities: 0, relations: 0 },
    message: 'No project open',
    startedAt: null,
    finishedAt: null,
  };
}
