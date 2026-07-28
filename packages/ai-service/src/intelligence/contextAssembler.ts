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
  ModuleSummary, PrioritizedDocument, RepositoryProfile,
  ProjectGlossary, RepositoryHealth, ConfidenceMark,
} from './types';
import type { RuntimeMessage } from '@aura/runtime';
import { evaluateConfidence } from './confidence';

const estTokens = (s: string) => Math.ceil(s.length / 4);

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

/** Frame raw retrieved code as subordinate supporting evidence. */
function framedEvidence(codingContext: string): string {
  return `[Supporting Source Excerpts — evidence only, subordinate to AURA's facts above]\n${codingContext}`;
}

/** Give recalled repository memory an explicit authoritative header. */
function framedMemory(memoryContext: string): string {
  return `[Repository Memory]\n${memoryContext}`;
}

/* ── Intent-specific assembly ────────────────────────────────────── */

function assembleProjectOverview(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.identity) parts.push(buildIdentitySection(input.identity));
  if (input.summary) parts.push(buildSummarySection(input.summary));
  if (input.profile) parts.push(buildProfileSection(input.profile));
  if (input.graphContext) parts.push(`[Architecture Graph]\n${input.graphContext}`);
  if (input.memoryContext) parts.push(input.memoryContext);
  return parts;
}

function assembleArchitecture(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.identity) parts.push(buildIdentitySection(input.identity));
  if (input.profile) parts.push(buildProfileSection(input.profile));
  if (input.graphContext) parts.push(`[Architecture Graph]\n${input.graphContext}`);
  if (input.summary) parts.push(buildSummarySection(input.summary));
  if (input.memoryContext) parts.push(input.memoryContext);
  return parts;
}

function assembleModuleExplanation(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  // Find the target module summary
  const targetEntity = input.intent.entities[0]?.toLowerCase();
  if (input.summary && targetEntity) {
    const mod = input.summary.modules.find(m => m.name.toLowerCase().includes(targetEntity));
    if (mod) parts.push(`[Target Module]\n${buildModuleDetail(mod)}`);
  }
  if (input.graphContext) parts.push(`[Module Relationships]\n${input.graphContext}`);
  if (input.codingContext) parts.push(input.codingContext);
  if (input.memoryContext) parts.push(input.memoryContext);
  return parts;
}

function assembleFunctionExplanation(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.codingContext) parts.push(input.codingContext);
  if (input.graphContext) parts.push(`[Code Relationships]\n${input.graphContext}`);
  return parts;
}

function assembleBugFix(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.codingContext) parts.push(input.codingContext);
  if (input.graphContext) parts.push(`[Dependencies & Relationships]\n${input.graphContext}`);
  if (input.memoryContext) parts.push(input.memoryContext);
  return parts;
}

function assembleCodeSearch(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.codingContext) parts.push(input.codingContext);
  return parts;
}

function assembleApiReference(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.codingContext) parts.push(input.codingContext);
  if (input.graphContext) parts.push(`[API Relationships]\n${input.graphContext}`);
  if (input.summary) parts.push(buildSummarySection(input.summary));
  return parts;
}

function assembleTesting(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.codingContext) parts.push(input.codingContext);
  if (input.summary) parts.push(buildSummarySection(input.summary));
  return parts;
}

function assembleGeneric(input: ContextAssemblerInput): string[] {
  const parts: string[] = [];
  if (input.identity) parts.push(buildIdentitySection(input.identity));
  if (input.codingContext) parts.push(input.codingContext);
  if (input.graphContext) parts.push(`[Architecture]\n${input.graphContext}`);
  if (input.memoryContext) parts.push(input.memoryContext);
  return parts;
}

function buildModuleDetail(mod: ModuleSummary): string {
  const lines = [
    `Module: ${mod.name}`,
    `Path: ${mod.path}`,
    `Language: ${mod.primaryLanguage}`,
    `Files: ${mod.fileCount}`,
    `Description: ${mod.description}`,
    mod.capabilities.length ? `Key Components: ${mod.capabilities.join(', ')}` : '',
    mod.childModules.length ? `Submodules: ${mod.childModules.join(', ')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/* ── Main assembler ──────────────────────────────────────────────── */

export function assembleContext(input: ContextAssemblerInput): AssembledContext {
  const { intent } = input;
  const confidenceMarks: ConfidenceMark[] = [];

  // Subordinate raw retrieval: code excerpts and recalled memory are framed
  // as supporting evidence so they never dominate or redefine AURA's facts.
  const wrapped: ContextAssemblerInput = {
    ...input,
    codingContext: input.codingContext ? framedEvidence(input.codingContext) : '',
    memoryContext: input.memoryContext ? framedMemory(input.memoryContext) : '',
  };

  // Intent-specific selection of AURA's authoritative knowledge sources.
  const facts: string[] = [];
  switch (intent.type) {
    case 'project_overview': facts.push(...assembleProjectOverview(wrapped)); break;
    case 'architecture': facts.push(...assembleArchitecture(wrapped)); break;
    case 'module_explanation': facts.push(...assembleModuleExplanation(wrapped)); break;
    case 'function_explanation': facts.push(...assembleFunctionExplanation(wrapped)); break;
    case 'bug_fix':
    case 'debugging': facts.push(...assembleBugFix(wrapped)); break;
    case 'code_search': facts.push(...assembleCodeSearch(wrapped)); break;
    case 'api_reference': facts.push(...assembleApiReference(wrapped)); break;
    case 'testing': facts.push(...assembleTesting(wrapped)); break;
    default: facts.push(...assembleGeneric(wrapped)); break;
  }
  const hasContent = facts.some(Boolean);

  // Ordering: authoritative directive → AURA's structured facts →
  // project terms → answering rules → retrieved-file manifest.
  const parts: string[] = [];
  if (hasContent) parts.push(AUTHORITATIVE_PREAMBLE);
  parts.push(...facts);

  const glossaryHint = buildGlossaryHint(input.glossary);
  if (glossaryHint) parts.push(glossaryHint);

  if (hasContent) parts.push(buildGroundingRules());

  // Evaluate confidence for each retrieved source (surfaced in inspect/debug).
  for (const source of input.retrievedFiles) {
    confidenceMarks.push(evaluateConfidence(source, {
      identity: input.identity,
      summary: input.summary,
      documentation: input.retrievedFiles,
      graphEntities: [],
    }));
  }

  if (input.retrievedFiles.length > 0) {
    parts.push(`[Retrieved Files]\n${input.retrievedFiles.map(f => `- ${f}`).join('\n')}`);
  }

  const systemMessages: RuntimeMessage[] = [];
  const fullContext = parts.filter(Boolean).join('\n\n');
  if (fullContext) {
    systemMessages.push({ role: 'system', content: fullContext });
  }

  return { systemMessages, totalTokens: estTokens(fullContext), confidenceMarks, retrievedSources: input.retrievedFiles };
}
