import {
  KeywordIntentClassifier,
  TemplatePromptEnhancer,
  createRequest,
  type ConversationTurn,
} from '@aura/intelligence';
import { CodingKnowledgeEngine } from '@aura/knowledge-coding';
import { FullStackKnowledgeEngine } from '@aura/knowledge-fullstack';
import type { GenerateRequest, RuntimeMessage } from '@aura/runtime';
import { DEFAULT_SETTINGS, type AiSettings } from './settings';
import { ProjectMemory, type MemoryItem } from './memory';
import { loadProfile, type ProjectProfile } from './profile';
import { homePath } from './persist';
import { RuntimeManager } from './provider';
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
 * Classifies thrown errors into a stable, user-facing shape. Provider
 * adapters throw `Error(\`API error ${status}: ...\`)` on non-2xx HTTP
 * responses (see provider/adapters/base.ts and friends) and surface
 * `AbortError`/`TimeoutError` on cancellation or timeout — this is the one
 * place that turns those into `{ type, retryable }` so 401/404 stop
 * retrying immediately while 429/5xx/timeouts/network failures retry.
 */
function normalize(e: unknown): NormalizedError {
  const err = e as Error;
  const message = err?.message ?? String(e);
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return { type: 'timeout', message: 'The request timed out.', retryable: true };
  }
  // Every adapter throws its own `"<Provider> error <status>: ..."` string
  // (see provider/adapters/{base,anthropic,gemini}.ts) — match any of them.
  const statusMatch = /\berror (\d{3}):/i.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401 || status === 403) return { type: 'auth', message, retryable: false };
    if (status === 404) return { type: 'not_found', message, retryable: false };
    if (status === 429) return { type: 'rate_limit', message, retryable: true };
    if (status >= 500) return { type: 'server_error', message, retryable: true };
    return { type: 'http_error', message, retryable: false };
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message)) {
    return { type: 'network', message, retryable: true };
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
  opts: { maxRetries: number; signal?: AbortSignal },
): Promise<{ ok: true; value: T } | { ok: false; error: NormalizedError }> {
  let lastError: NormalizedError = { type: 'unknown', message: 'Unknown error', retryable: false };
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) return { ok: false, error: { type: 'aborted', message: 'Cancelled', retryable: false } };
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      lastError = normalize(e);
      if (!lastError.retryable || attempt === opts.maxRetries) break;
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
    }
  }
  return { ok: false, error: lastError };
}

const NO_PROVIDER: NormalizedError = {
  type: 'no_provider',
  message: 'No AI provider connected. Add your API key in Settings to use AURA\'s AI.',
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
  | { type: 'done'; usage: unknown; finishReason: string; citations: unknown; latencyMs: number; trace: unknown; provider: string; engineId: string }
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

export class PipelineManager {
  private mounted: Mount | null = null;
  readonly runtimeManager: RuntimeManager;
  private settings: AiSettings = { ...DEFAULT_SETTINGS };
  private readonly classifier = new KeywordIntentClassifier();
  private readonly enhancer = new TemplatePromptEnhancer();
  private status: IndexStatus = emptyStatus();
  private indexing: Promise<void> | null = null;

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
    this.indexing = this.runIndex(false);
    // The provider is a pure, stateless inference engine — it is never
    // pointed at the repository. AURA does all repository understanding and
    // hands the model fully-assembled context each turn.
  }

  unmount(): void {
    this.mounted = null;
    this.status = emptyStatus();
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
    try {
      if (force || !(await m.coding.load())) {
        await m.coding.index({ onProgress: (p) => { if (!isCurrent()) return; this.status.coding.processed = p.processed; this.status.coding.total = p.total ?? this.status.coding.total; } });
      }
      if (!isCurrent()) return;
      this.status.coding.chunks = m.coding.stats().chunks;
      this.status.message = 'Analyzing system graph…';
      if (force || !(await m.fullstack.load())) {
        await m.fullstack.analyze({ onProgress: (p) => { if (!isCurrent()) return; this.status.fullstack.processed = p.processed; this.status.fullstack.total = p.total ?? this.status.fullstack.total; } });
      }
      if (!isCurrent()) return;
      const g = m.fullstack.stats();
      this.status.fullstack.entities = g.entities;
      this.status.fullstack.relations = g.relations;
      this.status = { ...this.status, phase: 'ready', message: 'Knowledge ready', finishedAt: new Date().toISOString() };
      // Fire-and-forget: run graphify to build the knowledge graph visualization.
      // This is non-blocking — the graph.html will appear once it finishes.
      try { runGraphify(m.id, m.path); } catch { /* graphify failure is non-fatal */ }
    } catch (e) {
      if (!isCurrent()) return;
      this.status = { ...this.status, phase: 'error', error: (e as Error).message, message: 'Indexing failed', finishedAt: new Date().toISOString() };
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

  async inspect(text: string): Promise<InspectResult> {
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

  private buildContextMessages(text: string, meta: InspectResult, history?: ConversationTurn[]): { messages: RuntimeMessage[]; info: { contextTokens: number } } {
    const messages: RuntimeMessage[] = [];

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

  async ask(text: string, signal?: AbortSignal, history?: ConversationTurn[]) {
    const meta = await this.inspect(text);
    const runtime = this.runtimeManager.runtime;
    if (!runtime) return { ok: false as const, error: NO_PROVIDER, meta };
    const t0 = performance.now();
    const onAbort = () => runtime.cancel();
    signal?.addEventListener('abort', onAbort);
    try {
      const { messages } = this.buildContextMessages(text, meta, history);
      const request: GenerateRequest = {
        messages,
        temperature: this.settings.temperature,
        maxTokens: this.settings.maxTokens,
      };
      const result = await withRetry(
        () => withTimeout(() => runtime.generate(request), this.settings.timeoutMs, () => runtime.cancel()),
        { maxRetries: this.settings.maxRetries, signal },
      );
      if (!result.ok) return { ok: false as const, error: result.error, meta };
      const providerLabel = this.runtimeManager.providerLabel;
      const latencyMs = Math.round(performance.now() - t0);
      return {
        ok: true as const,
        answer: result.value.content,
        meta,
        intent: meta.intent,
        engineId: providerLabel.toLowerCase().replace(/\s+/g, '-'),
        provider: providerLabel,
        citations: [],
        usage: result.value.usage,
        finishReason: result.value.finishReason,
        latencyMs,
        trace: [{ stage: 'generation', startedAt: t0, durationMs: latencyMs, ok: true }],
      };
    } catch (e) {
      return { ok: false as const, error: normalize(e), meta };
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
      const result = await withRetry(
        () => withTimeout(() => runtime.generate(request), this.settings.timeoutMs, () => runtime.cancel()),
        { maxRetries: this.settings.maxRetries, signal },
      );
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, text: result.value.content, usage: result.value.usage };
    } catch (e) {
      return { ok: false, error: normalize(e) };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async streamEvents(text: string, emit: (e: StreamEmit) => void, signal?: AbortSignal, history?: ConversationTurn[]): Promise<void> {
    let meta: InspectResult;
    try {
      meta = await this.inspect(text);
      emit({ type: 'meta', meta });
    } catch (e) {
      emit({ type: 'error', error: normalize(e) });
      return;
    }
    const runtime = this.runtimeManager.runtime;
    if (!runtime) { emit({ type: 'error', error: NO_PROVIDER }); return; }
    const onAbort = () => runtime.cancel();
    signal?.addEventListener('abort', onAbort);
    const t0 = performance.now();
    const { messages } = this.buildContextMessages(text, meta, history);
    const request: GenerateRequest = {
      messages,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
    };

    // Retries only cover the case where a failure (timeout/429/5xx/network) happens
    // before any token reached the client — once tokens have streamed, retrying
    // would duplicate output, so a mid-stream failure is reported as-is.
    let lastError: NormalizedError | null = null;
    for (let attempt = 0; attempt <= this.settings.maxRetries; attempt++) {
      if (signal?.aborted) { signal.removeEventListener('abort', onAbort); return; }
      let emittedAnyToken = false;
      try {
        const iterator = runtime.stream(request)[Symbol.asyncIterator]();
        while (true) {
          const next = await withTimeout(() => iterator.next(), this.settings.timeoutMs, () => runtime.cancel());
          if (next.done) break;
          const chunk = next.value;
          if (chunk.delta) { emit({ type: 'token', text: chunk.delta }); emittedAnyToken = true; }
          if (chunk.done) {
            const providerLabel = this.runtimeManager.providerLabel;
            const latencyMs = Math.round(performance.now() - t0);
            emit({ type: 'done', usage: chunk.usage, finishReason: chunk.finishReason ?? 'stop', citations: [], latencyMs, trace: [{ stage: 'generation', startedAt: t0, durationMs: latencyMs, ok: true }], provider: providerLabel, engineId: providerLabel.toLowerCase().replace(/\s+/g, '-') });
            signal?.removeEventListener('abort', onAbort);
            return;
          }
        }
        signal?.removeEventListener('abort', onAbort);
        return;
      } catch (e) {
        lastError = normalize(e);
        if (emittedAnyToken || !lastError.retryable || attempt === this.settings.maxRetries) break;
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
      }
    }
    signal?.removeEventListener('abort', onAbort);
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
