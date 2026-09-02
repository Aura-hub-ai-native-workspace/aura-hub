/**
 * AURA Context Fabric — the agent contract
 * ==================================================================
 * Renders a `ContextView` into the stable, plain-text block that a
 * downstream agent receives. This is the wire format between AURA and
 * anything that reasons on its behalf — a delegated CLI agent, Ask AURA,
 * a future tool.
 *
 * Five rules, all of them load-bearing:
 *
 *   1. **Unknown is rendered; empty is omitted.** A section AURA never
 *      established prints an explicit `unknown` line with the reason. A
 *      section AURA established and found empty is left out entirely.
 *      An agent must be able to tell "there are no recent commits" from
 *      "nobody checked".
 *
 *   2. **Stale is labelled in place.** Not in a footnote — on the
 *      section, so it cannot be read past.
 *
 *   3. **No secrets.** Only values that already passed through the
 *      projections in `compose.ts` reach here, and none of those carry
 *      credentials. This renderer adds no new source of data.
 *
 *   4. **No persuasion.** No confidence adjectives, no "comprehensive",
 *      no "you have full access to". Facts and their provenance only.
 *
 *   5. **Compact.** Orientation, not content. No file bodies, no full
 *      dependency trees, no complete git history. The agent inspects
 *      files itself once it knows where to look.
 */

import type {
  ContextCapability, ContextSurface, ContextView, Freshness, Section,
} from './types';

/* ══════════════════════════════════════════════════════════════════
   Per-surface budgets
   ══════════════════════════════════════════════════════════════════ */

interface SurfaceBudget {
  modules: number;
  commits: number;
  hotspots: number;
  activity: number;
  /** Show every capability, or only the ones that can actually be used. */
  allCapabilities: boolean;
}

/**
 * How much of each section a surface needs. A `git` question does not
 * need twenty module summaries; an `architecture` question does.
 * These are budgets, not new intent logic — the intent vocabulary itself
 * stays owned by `intelligence/contextAssembler.ts`.
 */
const BUDGETS: Record<ContextSurface, SurfaceBudget> = {
  general:      { modules: 8,  commits: 3, hotspots: 3, activity: 5,  allCapabilities: false },
  coding:       { modules: 12, commits: 3, hotspots: 5, activity: 5,  allCapabilities: false },
  debugging:    { modules: 8,  commits: 5, hotspots: 8, activity: 10, allCapabilities: false },
  architecture: { modules: 20, commits: 2, hotspots: 3, activity: 3,  allCapabilities: false },
  git:          { modules: 3,  commits: 5, hotspots: 5, activity: 5,  allCapabilities: false },
  testing:      { modules: 10, commits: 3, hotspots: 5, activity: 5,  allCapabilities: false },
  mission:      { modules: 6,  commits: 3, hotspots: 3, activity: 10, allCapabilities: true },
  planning:     { modules: 16, commits: 3, hotspots: 5, activity: 5,  allCapabilities: true },
  review:       { modules: 10, commits: 5, hotspots: 8, activity: 10, allCapabilities: false },
};

/* ══════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════ */

const STALE_NOTE = (r?: string) => ` [STALE${r ? `: ${r}` : ''}]`;

/** Section header, carrying its own freshness so it cannot be read past. */
function head(tag: string, freshness: Freshness, reason?: string): string {
  return freshness === 'stale' ? `<${tag}>${STALE_NOTE(reason)}` : `<${tag}>`;
}

/**
 * Render a section, or an explicit unknown marker, or nothing.
 * Returns null when the section is known-and-empty (omit it).
 */
function section<T>(
  tag: string,
  s: Section<T>,
  body: (value: T) => string[],
): string | null {
  if (s.freshness === 'unknown' || s.value === null) {
    return [`<${tag}>`, `unknown: ${s.reason ?? 'not established'}`, `</${tag}>`].join('\n');
  }
  const lines = body(s.value).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return [head(tag, s.freshness, s.reason), ...lines, `</${tag}>`].join('\n');
}

const list = (items: string[], max: number): string =>
  items.slice(0, max).join(', ') + (items.length > max ? `, +${items.length - max} more` : '');

/* ══════════════════════════════════════════════════════════════════
   The renderer
   ══════════════════════════════════════════════════════════════════ */

export interface RenderOptions {
  /** Override the view's own surface budget. */
  surface?: ContextSurface;
}

/**
 * Render the contract. Deterministic: the same view renders the same
 * text, so a caller can diff two contracts to see what actually changed.
 */
export function renderContextContract(view: ContextView, options: RenderOptions = {}): string {
  const budget = BUDGETS[options.surface ?? view.surface] ?? BUDGETS.general;
  const blocks: (string | null)[] = [];

  /* ── project ─────────────────────────────────────────────────── */
  blocks.push([
    '<PROJECT_CONTEXT>',
    `name: ${view.project.name}`,
    `root: ${view.project.root}`,
    `type: ${view.project.type}`,
    `language: ${view.project.language}`,
    `context_version: ${view.contextVersion ?? 'none recorded'}`,
    `context_freshness: ${view.freshness}`,
    `composed_at: ${view.composedAt}`,
    '</PROJECT_CONTEXT>',
  ].join('\n'));

  /* ── repository ──────────────────────────────────────────────── */
  blocks.push(section('REPOSITORY_CONTEXT', view.repository, (r) => {
    const lines: string[] = [];
    if (r.identity) {
      const id = r.identity;
      lines.push(`kind: ${id.repositoryType}${id.architectureStyle !== 'unknown' ? ` (${id.architectureStyle})` : ''}`);
      if (id.purpose) lines.push(`purpose: ${id.purpose.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      if (id.primaryLanguage && id.primaryLanguage !== 'unknown') lines.push(`primary_language: ${id.primaryLanguage}`);
      if (id.buildSystem) lines.push(`build_system: ${id.buildSystem}`);
      if (id.frameworks.length) lines.push(`frameworks: ${list(id.frameworks, 8)}`);
    }
    if (r.totalFiles !== null) lines.push(`total_files: ${r.totalFiles}`);
    if (r.entryPoints.length) lines.push(`entry_points: ${list(r.entryPoints, 5)}`);
    if (r.modules.length) {
      lines.push('modules:');
      for (const m of r.modules.slice(0, budget.modules)) {
        lines.push(`  - ${m.name} (${m.path}, ${m.fileCount} files)`);
      }
      if (r.modules.length > budget.modules) {
        lines.push(`  - +${r.modules.length - budget.modules} more modules`);
      }
    }
    if (r.profile) {
      if (r.profile.designPatterns.length) lines.push(`design_patterns: ${list(r.profile.designPatterns, 6)}`);
      if (r.profile.keyDecisions.length) {
        lines.push('key_decisions:');
        for (const d of r.profile.keyDecisions.slice(0, 5)) lines.push(`  - ${d}`);
      }
    }
    if (r.health) lines.push(`health_score: ${r.health.score.overall}/100`);
    return lines;
  }));

  /* ── changes ─────────────────────────────────────────────────── */
  blocks.push(section('RECENT_CHANGES', view.changes, (c) => {
    const lines: string[] = [];
    if (c.velocity) lines.push(`change_velocity: ${c.velocity}`);
    if (c.patterns.length) lines.push(`patterns: ${list(c.patterns, 5)}`);
    if (c.hotspots.length) {
      lines.push('hotspots:');
      for (const h of c.hotspots.slice(0, budget.hotspots)) lines.push(`  - ${h.file} (${h.reason})`);
    }
    return lines;
  }));

  /* ── git ─────────────────────────────────────────────────────── */
  blocks.push(section('GIT_CONTEXT', view.git, (g) => {
    const lines = [
      `branch: ${g.branch}`,
      `working_tree: ${g.dirty ? `dirty (${g.changedFiles} changed file(s))` : 'clean'}`,
    ];
    if (g.recentCommits.length) {
      lines.push('recent_commits:');
      for (const c of g.recentCommits.slice(0, budget.commits)) lines.push(`  - ${c.hash} ${c.subject}`);
    }
    return lines;
  }));

  /* ── environment ─────────────────────────────────────────────── */
  blocks.push(section('ENVIRONMENT_CONTEXT', view.environment, (e) => {
    const lines = [`os: ${e.os}`, `arch: ${e.arch}`];
    // Programs on the machine and AURA's own subsystems are listed
    // apart: only the former are things an agent could invoke directly.
    const installed = e.tools.filter((t) => !t.internal);
    const subsystems = e.tools.filter((t) => t.internal);
    if (installed.length) {
      lines.push('tools_installed:');
      for (const t of installed) lines.push(`  - ${t.name}${t.version ? ` ${t.version}` : ''}`);
    }
    if (subsystems.length) {
      lines.push(`aura_subsystems: ${list(subsystems.map((t) => t.name), 10)}`);
    }
    return lines;
  }));

  /* ── capabilities ────────────────────────────────────────────── */
  blocks.push(section('AVAILABLE_CAPABILITIES', view.capabilities, (caps) => {
    const usable = caps.filter((c) => c.availability === 'available');
    const gated = caps.filter((c) => c.availability === 'approval');
    const blocked = caps.filter((c) => c.availability === 'not-drivable');

    const lines: string[] = [];
    if (usable.length) lines.push(`available: ${list(usable.map((c) => c.id), 40)}`);
    if (gated.length) lines.push(`requires_human_approval: ${list(gated.map((c) => c.id), 40)}`);
    if (budget.allCapabilities && blocked.length) {
      lines.push('present_but_not_drivable:');
      for (const c of blocked.slice(0, 10)) lines.push(`  - ${c.id}${c.reason ? ` (${c.reason})` : ''}`);
    }
    // Unavailable capabilities are deliberately not listed: an agent does
    // not need the catalogue of everything this machine cannot do.
    return lines;
  }));

  /* ── missions ────────────────────────────────────────────────── */
  blocks.push(section('ACTIVE_MISSIONS', view.missions, (ms) => {
    const lines: string[] = [];
    for (const m of ms) {
      const status = m.status ?? 'no plan';
      lines.push(`- ${m.text.slice(0, 120)} [${m.category}] status=${status} tasks=${m.completedTasks}/${m.taskCount}`);
    }
    return lines;
  }));

  /* ── activity ────────────────────────────────────────────────── */
  blocks.push(section('CURRENT_ACTIVITY', view.activity, (as) => {
    const lines: string[] = [];
    for (const a of as.slice(0, budget.activity)) {
      const who = a.nodeId ? `${a.actor}/${a.nodeId}` : a.actor;
      lines.push(`- ${a.at} ${a.capabilityId} by ${who} → ${a.outcome}`);
    }
    return lines;
  }));

  /* ── constraints ─────────────────────────────────────────────── */
  if (view.constraints.length) {
    blocks.push([
      '<CONTEXT_CONSTRAINTS>',
      ...view.constraints.map((c) => `- ${c.text}`),
      '</CONTEXT_CONSTRAINTS>',
    ].join('\n'));
  }

  return blocks.filter((b): b is string => b !== null).join('\n\n');
}

/**
 * The smallest useful orientation: who am I working on, and is what I
 * am being told current. Used where a full contract would not fit.
 */
export function renderContextHeader(view: ContextView): string {
  return [
    `project: ${view.project.name} (${view.project.root})`,
    `context: v${view.contextVersion ?? '—'} ${view.freshness}`,
  ].join('\n');
}

/** Which capabilities a caller may actually invoke, for a UI or a prompt. */
export function usableCapabilities(view: ContextView): ContextCapability[] {
  return (view.capabilities.value ?? []).filter(
    (c) => c.availability === 'available' || c.availability === 'approval',
  );
}
