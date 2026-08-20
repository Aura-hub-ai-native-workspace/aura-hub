/**
 * Smart Context Assembler
 * ==================================================================
 * Builds context based on the user's intent. Different intents
 * assemble different combinations of knowledge sources.
 *
 * Context is assembled BEFORE any provider is called.
 * Providers receive an already-optimized context.
 */

import type {
  RepositoryIntent, ProjectIdentity, RepositorySummary,
  PrioritizedDocument, RepositoryProfile,
  ProjectGlossary, RepositoryHealth, ConfidenceMark,
} from './types';
import type { RuntimeMessage } from '@aura/runtime';
import { evaluateConfidence } from './confidence';
import type { ContextItem } from '../context/item';
import { fromAuraFact, fromMemory, fromRepositoryFile } from '../context/item';
import { composeContext } from '../context/composer';
import { redact } from '../context/redact';
import { FALLBACK_WINDOW, type BudgetSpec, type BudgetDecision } from '../context/budget';

/**
 * The governing directive. Establishes AURA as the authoritative source of
 * repository understanding and the provider as a pure verbalizer. Everything
 * that follows in the system message was computed by AURA BEFORE inference;
 * the model reasons over these facts rather than re-deriving the project.
 * This is what makes the answer provider-independent: swapping the model
 * provider (the built-in AURA Runtime, or any BYOK provider) changes only
 * the wording, not the facts, because the facts originate here — not the model.
 */
const AUTHORITATIVE_PREAMBLE = [
  '[AURA — Repository Intelligence]',
  'You are the voice of AURA, a repository intelligence engine. Every section below was computed by AURA BEFORE you were invoked and is AURA\'s authoritative understanding of THIS specific repository.',
  'Your job is to verbalize and reason over AURA\'s knowledge — not to independently decide what the repository is. Its identity, purpose, architecture, modules, status and relationships are established FACTS supplied by AURA; treat them as ground truth.',
  'Do not invent a competing description of the project, and do not override AURA\'s identity with your own inference. Any source excerpts are supporting evidence only and never outrank AURA\'s structured facts. If the facts below do not cover something, say so plainly rather than guessing.',
].join('\n');

/* ── Context assembly by intent ──────────────────────────────────── */

export interface AssembledContext {
  systemMessages: RuntimeMessage[];
  totalTokens: number;
  confidenceMarks: ConfidenceMark[];
  retrievedSources: string[];
  /**
   * One entry per candidate: what happened to it and why. This is the
   * audit trail that makes "every inclusion carries a reason" checkable
   * from outside rather than asserted from inside.
   */
  decisions: BudgetDecision[];
  /** What the budget allowed and what was spent. Null when nothing was assembled. */
  budget: AssembledBudget | null;
}

export interface AssembledBudget {
  model: string;
  floorTokens: number;
  itemTokens: number;
  totalTokens: number;
  budgetTokens: number;
  containsUntrusted: boolean;
  sensitivity: 'public' | 'project' | 'private' | 'secret';
}

export interface ContextAssemblerInput {
  intent: RepositoryIntent;
  identity: ProjectIdentity | null;
  summary: RepositorySummary | null;
  profile: RepositoryProfile | null;
  glossary: ProjectGlossary | null;
  health: RepositoryHealth | null;
  prioritizedDocs: PrioritizedDocument[];
  codingContext: string;
  graphContext: string;
  memoryContext: string;
  retrievedFiles: string[];
  /**
   * Additional context items from the caller, already carrying the
   * trust and sensitivity assigned where they entered AURA.
   */
  items?: readonly ContextItem[];
  /** The user's actual words, for lexical scoring. Falls back to the intent. */
  query?: string;
  /** The model being assembled for. Without it, a conservative window applies. */
  budget?: BudgetSpec;
}

const TYPE_NOUN: Record<string, string> = {
  'operating-system': 'operating-system kernel',
  kernel: 'operating-system kernel',
  compiler: 'compiler / language toolchain',
  database: 'database engine',
  library: 'library',
  cli: 'command-line tool',
  frontend: 'frontend application',
  backend: 'backend service',
  fullstack: 'full-stack application',
  infrastructure: 'infrastructure project',
  'ai-framework': 'AI / ML framework',
  mobile: 'mobile application',
  desktop: 'desktop application',
  game: 'game',
  embedded: 'embedded firmware project',
  unknown: 'software project',
};

/**
 * AURA verbalizes its OWN identity as a natural-language paragraph — built
 * only from AURA's structured facts. Leading with prose (rather than a
 * key:value table) means even a weak, echo-prone model produces a fluent
 * answer instead of mirroring the table format as keyword fragments.
 */
function identityNarrative(id: ProjectIdentity): string {
  const arch = id.architectureStyle && id.architectureStyle !== 'unknown' ? `${id.architectureStyle} ` : '';
  const noun = TYPE_NOUN[id.repositoryType] ?? 'software project';
  const clauses = [`${id.name} is a ${arch}${noun}`];
  if (id.primaryLanguage && id.primaryLanguage !== 'unknown') clauses.push(`written in ${id.primaryLanguage}`);
  const plats = id.platforms.filter((p) => p !== 'native' && p !== 'node');
  if (plats.length) clauses.push(`targeting ${plats.join(', ')}`);
  let opening = clauses.join(' ');
  if (id.buildSystem) opening += `, built with ${id.buildSystem}`;
  opening += '.';

  const sentences = [opening];
  const readmePurpose = id.purpose && /\s/.test(id.purpose) && id.purpose.length > 20 ? id.purpose.replace(/\s+/g, ' ').trim() : '';
  if (readmePurpose && !opening.toLowerCase().includes(readmePurpose.slice(0, 24).toLowerCase())) {
    sentences.push(readmePurpose.endsWith('.') ? readmePurpose : `${readmePurpose}.`);
  }
  if (id.mainModules.length) sentences.push(`Its major subsystems include ${id.mainModules.slice(0, 6).join(', ')}.`);
  if (id.entryPoints.length) sentences.push(`The entry point is ${id.entryPoints[0]}.`);
  if (id.frameworks.length) sentences.push(`It uses ${id.frameworks.slice(0, 5).join(', ')}.`);
  return sentences.join(' ');
}

function buildIdentitySection(identity: ProjectIdentity): string {
  const facts = [
    `Type: ${identity.repositoryType}`,
    `Primary Language: ${identity.primaryLanguage}`,
    `Secondary Languages: ${identity.secondaryLanguages.join(', ') || 'none'}`,
    `Architecture: ${identity.architectureStyle}`,
    `Build System: ${identity.buildSystem ?? 'unknown'}`,
    `Frameworks: ${identity.frameworks.join(', ') || 'none'}`,
    `Platforms: ${identity.platforms.join(', ')}`,
    `Main Modules: ${identity.mainModules.join(', ') || 'none detected'}`,
    `Entry Points: ${identity.entryPoints.join(', ') || 'none detected'}`,
    `Status: ${identity.status}`,
    `Technology Stack: ${identity.technologyStack.join(', ')}`,
  ];
  // Lead with AURA's own prose description; keep the fields as reference only.
  return `[Repository Identity]\n${identityNarrative(identity)}\n\nReference facts (do not copy verbatim — write prose):\n${facts.join('\n')}`;
}

function buildSummarySection(summary: RepositorySummary): string {
  const lines: string[] = [];
  lines.push(`# ${summary.projectName} — Module Overview`);
  if (summary.purpose) lines.push(`Purpose: ${summary.purpose}`);
  lines.push(`Total Files: ${summary.totalFiles}`);
  lines.push('');
  for (const mod of summary.modules.slice(0, 10)) {
    lines.push(`## ${mod.name}`);
    lines.push(mod.description);
    if (mod.capabilities.length > 0) {
      lines.push(`Key: ${mod.capabilities.slice(0, 6).join(', ')}`);
    }
    if (mod.childModules.length > 0) {
      lines.push(`Submodules: ${mod.childModules.join(', ')}`);
    }
    lines.push('');
  }
  return `[Module Summaries]\n${lines.join('\n')}`;
}

function buildProfileSection(profile: RepositoryProfile): string {
  const lines = [
    `[Repository Profile]`,
    `Architecture Style: ${profile.architectureStyle}`,
    profile.designPatterns.length ? `Design Patterns: ${profile.designPatterns.join(', ')}` : '',
    profile.namingConventions.length ? `Naming Conventions: ${profile.namingConventions.join(', ')}` : '',
    profile.moduleStructure.length ? `Module Structure: ${profile.moduleStructure.join(', ')}` : '',
    profile.keyDecisions.length ? `Key Decisions:\n${profile.keyDecisions.map(d => `- ${d}`).join('\n')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildGlossaryHint(glossary: ProjectGlossary | null): string {
  if (!glossary) return '';
  const terms = Object.keys(glossary.entries).slice(0, 15);
  if (terms.length === 0) return '';
  return `[Project Terms] Use these project-specific terms: ${terms.join(', ')}`;
}

/**
 * Answering rules. Deliberately defers to AURA's structured facts as the
 * source of truth (NOT the raw retrieved context). Source excerpts only
 * supply specifics; they never redefine the repository.
 */
function buildGroundingRules(): string {
  return [
    '[Answering Rules]',
    'Answer as AURA, from the authoritative facts above. Treat the Repository Identity, Architecture, Modules, Status, Relationships and Memory as established truth — never contradict or re-derive them.',
    'Use source excerpts only for specifics (names, signatures, exact behavior); they support the facts above but do not redefine the project.',
    'If a detail is not present in AURA\'s facts, state that plainly instead of inventing it.',
    '',
    '[Response Style]',
    'Reply as a knowledgeable senior engineer writing for another engineer: a complete, fluent, well-structured answer in natural prose. Begin with a direct one- or two-sentence summary that answers the question, then explain — what the project is, what it does, how it is built and organized — drawing naturally on the identity, purpose, architecture, modules and platform.',
    'Write in full sentences and connected paragraphs. Where it genuinely aids clarity, use light markdown: a short lead paragraph followed by a few bullet points for the major modules or key facts. Aim for a thorough, confident, readable explanation — several sentences at minimum, not one line.',
    'CRITICAL: never answer with terse fragments, comma-separated keywords, or the bracketed "[Field: value]" notation used above. That notation is AURA\'s internal data format, NOT your output format — translate it into prose. For example, do not write "aura-kernel a kernel C, /main, x86"; instead write "aura-kernel is a small operating-system kernel written in C. It targets x86_64 and boots from ...".',
  ].join('\n');
}

/* ── Candidates, not a switch ─────────────────────────────────────────
 *
 * What used to be here: nine `assemble*` functions and a `switch (intent.type)`
 * choosing between them. That design could not answer either question a
 * prompt has to answer — why is this here, and does it fit — because a
 * `switch` returns strings and a string carries no provenance and no cost.
 *
 * What is here now: every knowledge source becomes a `ContextItem` with
 * its provenance, sensitivity and trust set AT THE BOUNDARY, and the one
 * composer scores, budgets, compresses and assembles them. Intent has not
 * disappeared — it survives as one of four scoring signals (`taskFit` in
 * `context/score.ts`), where it influences ranking instead of dictating
 * inclusion.
 *
 * The trust assignments below are the load-bearing part:
 *
 *   AURA's own derived understanding (identity, module summaries,
 *   profile, architecture graph, glossary) is `trusted`. AURA computed it
 *   from its own registries; it is not attacker-controlled text.
 *
 *   Retrieved source excerpts and recalled memory are `untrusted`, and
 *   the composer fences them. They are quoted from the repository, and a
 *   repository can contain a file that says "ignore your instructions".
 *   The old code framed them in prose as "supporting evidence"; prose is
 *   not a boundary.
 */

/** AURA's own derived project understanding. Trusted; never a fence. */
function auraFact(
  kind: 'app' | 'env' | 'git' | 'mission' | 'event',
  locator: string,
  driver: string,
  value: string,
): ContextItem<string> {
  return fromAuraFact({ kind, locator, driver, value });
}

function buildCandidates(input: ContextAssemblerInput): { items: ContextItem[]; protectedIds: string[] } {
  const items: ContextItem[] = [];
  const protectedIds: string[] = [];

  if (input.identity) {
    const item = auraFact('app', 'aura://identity', 'repository-intelligence', buildIdentitySection(input.identity));
    /* Identity is protected, not merely high-scoring. It is what makes an
       answer about THIS repository rather than about software in general,
       so it must survive a budget that a lexical match happens to win. */
    protectedIds.push(item.id);
    items.push(item);
  }
  if (input.summary) {
    items.push(auraFact('app', 'aura://module-summary', 'repository-intelligence', buildSummarySection(input.summary)));
  }
  if (input.profile) {
    items.push(auraFact('app', 'aura://profile', 'repository-memory', buildProfileSection(input.profile)));
  }
  if (input.graphContext) {
    items.push(auraFact('app', 'aura://architecture-graph', 'knowledge-graph', `[Architecture Graph]\n${input.graphContext}`));
  }
  const glossaryHint = buildGlossaryHint(input.glossary);
  if (glossaryHint) {
    items.push(auraFact('app', 'aura://glossary', 'glossary', glossaryHint));
  }

  /* Repository excerpts. Untrusted: this is file content. */
  if (input.codingContext) {
    items.push(fromRepositoryFile({
      kind: 'chunk',
      path: input.retrievedFiles.length ? input.retrievedFiles.join(', ') : 'retrieved source excerpts',
      content: input.codingContext,
      driver: 'coding-index',
    }));
  }

  /* Recalled memory. Untrusted: AURA stored it, but what it stores is
     quoted from conversations and files it did not write. */
  if (input.memoryContext) {
    items.push(fromMemory({
      id: 'aura://memory-recall',
      body: input.memoryContext,
      store: 'project-memory',
    }));
  }

  if (input.retrievedFiles.length > 0) {
    items.push(auraFact('app', 'aura://retrieved-manifest', 'retrieval',
      `[Retrieved Files]\n${input.retrievedFiles.map((f) => `- ${f}`).join('\n')}`));
  }

  /* Anything the caller supplies — conversation turns, tool results, page
     text — already carries its own boundary-assigned trust. */
  for (const extra of input.items ?? []) items.push(extra);

  return { items, protectedIds };
}

/* ── Main assembler ──────────────────────────────────────────────── */

/**
 * Path A's entry into the ONE composer.
 *
 * This function no longer builds a prompt. It turns what the
 * intelligence engine knows into `ContextItem`s and hands them to
 * `composeContext`, which is the same composer the agent path
 * (`context/systemPrompt.ts`) uses. Two consequences follow structurally
 * rather than by convention:
 *
 *   every item passes `redact()` exactly once, inside `block()` in
 *   `context/promptContract.ts`;
 *
 *   nothing can exceed the chosen model's window, because the composer
 *   refuses rather than truncating.
 *
 * `redact()` is applied once more to the composed text below. That is
 * Phase 1's `fullContext` choke point, and it is idempotent — a second
 * pass over already-redacted text changes nothing. It is kept so that the
 * property survives even if some future caller assembles a system message
 * here by another route.
 */
export function assembleContext(input: ContextAssemblerInput): AssembledContext {
  const confidenceMarks: ConfidenceMark[] = [];
  for (const source of input.retrievedFiles) {
    confidenceMarks.push(evaluateConfidence(source, {
      identity: input.identity,
      summary: input.summary,
      documentation: input.retrievedFiles,
      graphEntities: [],
    }));
  }

  const { items, protectedIds } = buildCandidates(input);

  /* No knowledge at all: emit nothing rather than a preamble that
     promises facts and then supplies none. Preserved from the original —
     an empty context that reads as authoritative is worse than none. */
  if (items.length === 0) {
    return { systemMessages: [], totalTokens: 0, confidenceMarks, retrievedSources: input.retrievedFiles, decisions: [], budget: null };
  }

  const budget: BudgetSpec = input.budget ?? { model: 'unspecified', windowTokens: FALLBACK_WINDOW };

  let composed;
  try {
    composed = composeContext({
      /* The preamble and the answering rules are BEHAVIOUR, so they go in
         the rules slot and are incompressible. They were previously
         interleaved with the facts, which meant a long retrieval could
         push the instruction that governs it out of the prompt. */
      systemPrompt: `${AUTHORITATIVE_PREAMBLE}\n\n${buildGroundingRules()}`,
      items,
      floorItemIds: protectedIds,
      query: input.query ?? (input.intent.entities.join(' ') || input.intent.type),
      intent: input.intent.type,
      budget,
    });
  } catch (err) {
    /* A refusal is a real result, not an exception to swallow. It is
       re-thrown so the caller sees WHAT was dropped; the alternative —
       returning a silently smaller context — is the behaviour this whole
       change exists to remove. */
    throw err;
  }

  const fullContext = redact(composed.text);
  const systemMessages: RuntimeMessage[] = fullContext
    ? [{ role: 'system', content: fullContext }]
    : [];

  return {
    systemMessages,
    totalTokens: composed.tokens.total,
    confidenceMarks,
    retrievedSources: input.retrievedFiles,
    decisions: composed.decisions,
    budget: {
      model: composed.model,
      floorTokens: composed.tokens.floor,
      itemTokens: composed.tokens.items,
      totalTokens: composed.tokens.total,
      budgetTokens: composed.tokens.budget,
      containsUntrusted: composed.containsUntrusted,
      sensitivity: composed.sensitivity,
    },
  };
}
