/**
 * The AURA context prompt contract.
 * ==================================================================
 * Renders a `ContextView` into the tagged blocks an AURA agent prompt
 * consumes. This is the STRUCTURE only — deliberately no persuasive
 * wording, no role framing, no instructions. The canonical AURA system
 * prompt is a later phase; it will wrap these blocks, not replace them.
 *
 * Keeping the two apart is the point. The prompt says how to behave; this
 * says what is true. If they were one string, changing a sentence of
 * guidance would risk changing a fact, and every consumer — Ask AURA
 * today, delegated agents later — would have to re-derive the split.
 *
 *   AURA SYSTEM PROMPT   (later phase — behaviour)
 *          +
 *   THIS CONTRACT        (facts, from the ContextView)
 *          +
 *   USER TASK
 *          ↓
 *        AGENT
 *
 * ── Rules this renderer keeps ────────────────────────────────────────
 * 1. Never assert freshness it does not have. A stale or unanalysed view
 *    says so INSIDE the block, so a model cannot read confident facts
 *    without also reading that they may be out of date.
 * 2. Never emit an empty block. A section with nothing to say is omitted
 *    entirely rather than rendered as a header with no content, which
 *    reads as "AURA looked and there is nothing" rather than "unknown".
 * 3. Never emit a credential. The ContextView is already redacted at
 *    composition; this renderer additionally has no access to any key.
 */

import type { ContextView } from './types';

/**
 * Credential-shaped substrings, redacted at the render boundary.
 *
 * Composition already drops a credential-shaped provider id or model, but
 * that covered one field out of dozens. Most of what reaches this contract
 * is free text derived from the repository — a commit subject, a module
 * description, an identity purpose, an activity summary — and a commit
 * reading `fix: rotate AKIA… key` would otherwise travel verbatim into
 * every agent prompt.
 *
 * Redacting HERE rather than per-field is deliberate: this is the single
 * choke point every block passes through, so a section added later is
 * covered without anyone remembering to opt in.
 *
 * Deliberately conservative. It matches shapes, not names, and it never
 * tries to be a secret scanner — it is defence in depth behind "AURA does
 * not put secrets in context in the first place", not a replacement for it.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,              // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,                            // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                  // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,              // PEM private keys
  /\b(?:api[_-]?key|apikey|secret|password|passwd|token|bearer)\s*[:=]\s*\S+/gi,
];

/** Replace anything credential-shaped with a marker that says what happened. */
function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}

/** Emit a block only when it has content. */
function block(tag: string, lines: (string | null | undefined | false)[]): string {
  const body = lines.filter((l): l is string => typeof l === 'string' && l.length > 0);
  if (body.length === 0) return '';
  return `<${tag}>\n${redact(body.join('\n'))}\n</${tag}>`;
}

const list = (label: string, xs: string[], cap = 12): string | null =>
  xs.length ? `${label}: ${xs.slice(0, cap).join(', ')}` : null;

/**
 * The freshness line that leads PROJECT_CONTEXT.
 *
 * It is first, not last, because everything after it is conditional on it.
 */
function freshnessLine(view: ContextView): string {
  const f = view.freshness;
  if (f.state === 'fresh') {
    return `Context: v${view.contextVersion}, current as of ${f.generatedAt}.`;
  }
  if (f.state === 'stale') {
    return `Context: v${view.contextVersion}, STALE — ${f.reason} Repository facts below describe the project as of ${f.generatedAt} and may no longer be accurate.`;
  }
  return `Context: NOT ANALYSED — ${f.reason} Repository facts below are unavailable, not empty.`;
}

export interface RenderOptions {
  /** Omit sections that are usually irrelevant to a pure question. */
  include?: {
    environment?: boolean;
    capabilities?: boolean;
    activity?: boolean;
  };
}

/**
 * Render the contract. Returns '' when there is genuinely nothing to say,
 * so a caller can append it unconditionally.
 */
export function renderContextContract(view: ContextView, opts: RenderOptions = {}): string {
  const inc = { environment: true, capabilities: true, activity: true, ...(opts.include ?? {}) };

  const project = block('PROJECT_CONTEXT', [
    freshnessLine(view),
    `Project: ${view.project.name}`,
    `Root: ${view.project.root}`,
    `Type: ${view.project.type}`,
    view.git.available ? `Branch: ${view.git.branch}` : null,
    view.git.available && view.git.dirty
      ? `Working tree: ${view.git.changedFiles} uncommitted change(s)`
      : view.git.available ? 'Working tree: clean' : null,
    !view.git.available && view.git.reason ? `Git: unavailable (${view.git.reason})` : null,
    view.git.recentCommits.length
      ? `Recent commits:\n${view.git.recentCommits.map((c) => `  ${c.hash} ${c.subject}`).join('\n')}`
      : null,
  ]);

  const r = view.repository;
  const repository = r.intelligence === 'absent'
    ? block('REPOSITORY_CONTEXT', ['Not analysed yet. Do not infer repository facts; say so instead.'])
    : block('REPOSITORY_CONTEXT', [
      r.purpose ? `Purpose: ${r.purpose}` : null,
      r.repositoryType ? `Kind: ${r.repositoryType}` : null,
      r.architectureStyle ? `Architecture: ${r.architectureStyle}` : null,
      r.primaryLanguage ? `Primary language: ${r.primaryLanguage}` : null,
      list('Other languages', r.secondaryLanguages),
      list('Frameworks', r.frameworks),
      r.buildSystem ? `Build system: ${r.buildSystem}` : null,
      r.packageManager ? `Package manager: ${r.packageManager}` : null,
      r.fileCount !== null ? `Files: ${r.fileCount}` : null,
      list('Entry points', r.entryPoints, 5),
      r.modules.length
        ? `Modules:\n${r.modules.map((m) => `  ${m.name} (${m.path}) — ${m.description}`).join('\n')}`
        : list('Main modules', r.mainModules),
    ]);

  const e = view.environment;
  const environment = inc.environment
    ? block('ENVIRONMENT_CONTEXT', [
      `OS: ${e.os} (${e.platform}/${e.arch})`,
      `Node: ${e.nodeVersion}`,
      e.shell ? `Shell: ${e.shell}` : null,
      `Tools detected: ${e.presentCount} of ${e.catalogueCount} catalogued`,
      list('Present', e.presentNodes.map((n) => (n.version ? `${n.name} ${n.version}` : n.name)), 25),
    ])
    : '';

  const capabilities = inc.capabilities
    ? block('AVAILABLE_CAPABILITIES', [
      list('Available', view.tools.available, 40),
      view.agents.codingAgents.length
        ? `Coding agents: ${view.agents.codingAgents.map((a) => `${a.name}${a.drivable ? '' : ' (present but not drivable by AURA)'}`).join(', ')}`
        : null,
      `AI provider: ${view.agents.provider.connected ? `${view.agents.provider.id ?? 'connected'}${view.agents.provider.model ? ` (${view.agents.provider.model})` : ''}` : 'none connected'}`,
      list('Not available on this machine', view.tools.missing, 10),
    ])
    : '';

  const m = view.mission;
  const activity = inc.activity
    ? block('CURRENT_ACTIVITY', [
      m.active ? `Active mission: ${m.active.text} [${m.active.status}]` : null,
      m.pendingApprovals > 0 ? `Approvals awaiting a human: ${m.pendingApprovals}` : null,
      view.activity.events.length
        ? `Recent:\n${view.activity.events.map((ev) => `  ${ev.at} ${ev.kind}: ${ev.summary}`).join('\n')}`
        : null,
    ])
    : '';

  /* Not in the original five tags, but constraints are the part a model
     most needs before it ACTS rather than answers — a dirty tree, an
     unanalysed project, a missing provider. Emitted as its own block so it
     cannot be lost inside prose. */
  const constraints = block('CONTEXT_CONSTRAINTS',
    view.constraints.map((c) => `- ${c.text}`));

  return [project, repository, environment, capabilities, activity, constraints]
    .filter(Boolean)
    .join('\n\n');
}
