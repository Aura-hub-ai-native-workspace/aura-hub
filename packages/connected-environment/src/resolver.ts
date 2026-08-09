/**
 * resolver — a missing tool is a question, never a wall.
 * ==================================================================
 * When a plan needs a capability nothing provides, the old answer was
 * "tool not found" and the mission stopped. Here the answer is a ranked
 * shortlist with the reasoning attached, so the next interaction is a
 * decision the user can make in one click instead of a dead end they
 * have to research their way out of.
 *
 * The ranking is deliberate and stated in full below, because a
 * recommendation the user cannot audit is just an opinion. Preference
 * order, highest weight first: something already on this machine, then
 * something the Hub can genuinely connect today, then free and open
 * source, then cross-platform, maintained, and low authentication
 * friction.
 */

import type { CapabilityId } from './capabilities';
import { describeCapability } from './capabilities';
import { entriesProviding, isConnectable } from './catalog';
import type { Candidate, CapabilityGap, EnvironmentNode } from './types';

const WEIGHTS = {
  alreadyConnected: 45,
  presentOnMachine: 30,
  connectableToday: 20,
  openSource: 12,
  freeTier: 7,
  crossPlatform: 8,
  maintained: 6,
  internalTransport: 10,
  localTransport: 6,
  noAuth: 6,
  cliSession: 4,
  apiKey: 2,
} as const;

function scoreCandidate(entry: ReturnType<typeof entriesProviding>[number], node: EnvironmentNode | undefined): Candidate {
  const rationale: string[] = [];
  let score = 0;

  if (node?.connected) {
    score += WEIGHTS.alreadyConnected;
    rationale.push('Already connected — nothing to set up.');
  } else if (node?.health.status === 'available') {
    score += WEIGHTS.presentOnMachine;
    rationale.push(`Already installed here${node.health.version ? ` (${node.health.version})` : ''} — one click connects it.`);
  }

  const connectable = isConnectable(entry);
  if (connectable) {
    score += WEIGHTS.connectableToday;
  } else {
    rationale.push('Catalogued for planning — the Hub cannot drive this one yet.');
  }

  if (entry.license === 'open-source') {
    score += WEIGHTS.openSource;
    rationale.push('Open source.');
  } else if (entry.license === 'free-tier') {
    score += WEIGHTS.freeTier;
    rationale.push('Has a free tier.');
  }

  if (entry.crossPlatform) score += WEIGHTS.crossPlatform;
  else rationale.push('Platform-specific.');

  if (entry.maintained) score += WEIGHTS.maintained;

  if (entry.transport === 'internal') {
    score += WEIGHTS.internalTransport;
    rationale.push('Built into the Hub — no network, no quota.');
  } else if (entry.transport === 'local-process') {
    score += WEIGHTS.localTransport;
    rationale.push('Runs locally — your code never leaves the machine.');
  }

  if (entry.auth === 'none') score += WEIGHTS.noAuth;
  else if (entry.auth === 'cli-session') {
    score += WEIGHTS.cliSession;
    rationale.push('Uses your existing CLI session.');
  } else if (entry.auth === 'api-key') {
    score += WEIGHTS.apiKey;
    rationale.push('Needs an API key you supply.');
  } else {
    rationale.push('Needs an account connection.');
  }

  return { entry, score: Math.min(100, score), rationale, connectable };
}

/**
 * Rank every catalogued system that provides `capability`, best first.
 * Non-connectable options are still returned — knowing that Figma is the
 * right answer is useful even when the Hub cannot drive Figma yet.
 */
export function rankCandidates(capability: CapabilityId, nodes: EnvironmentNode[]): Candidate[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return entriesProviding(capability)
    .map((entry) => scoreCandidate(entry, byId.get(entry.id)))
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

/** The forward-moving sentence shown wherever a gap appears. */
function gapMessage(capability: CapabilityId, candidates: Candidate[]): string {
  const job = describeCapability(capability).toLowerCase();
  const top = candidates[0];
  if (!top) {
    return `Nothing in the catalog can ${job} yet. The mission continues around it, and this becomes the next connector worth building.`;
  }
  if (top.connectable && top.rationale.some((r) => r.startsWith('Already installed'))) {
    return `${top.entry.name} is already on this machine and can ${job}. Connect it and this part of the mission unblocks.`;
  }
  if (top.connectable) {
    return `${top.entry.name} looks like the best way to ${job} here. Connect it and the Hub takes it from there.`;
  }
  const connectableAlternative = candidates.find((c) => c.connectable);
  if (connectableAlternative) {
    return `${top.entry.name} is the strongest option to ${job}, though the Hub cannot drive it yet — ${connectableAlternative.entry.name} can be connected today instead.`;
  }
  return `${top.entry.name} is the recommended way to ${job}. No connector exists for it yet, so this step is planned and handed to you rather than executed.`;
}

/** What some caller needs, and (optionally) which existing tasks need it. */
export interface CapabilityRequirement {
  capability: CapabilityId;
  /**
   * Ids of the **existing** `MissionTask`s that need this. Supplied by the
   * Capability Fabric from the authoritative `MissionRecord`; empty when a
   * caller is simply asking "could I do X here?".
   */
  taskIds?: string[];
}

/**
 * Every required capability that no connected node provides.
 *
 * Takes a requirement list rather than a mission, deliberately: this
 * package must not know what a mission is. The Fabric derives the list
 * from the authoritative `MissionRecord` and passes it in, so the gap
 * reading stays live without a second mission model existing anywhere.
 */
export function findGaps(required: CapabilityRequirement[], nodes: EnvironmentNode[]): CapabilityGap[] {
  const provided = new Set<CapabilityId>();
  for (const node of nodes) {
    if (!node.connected) continue;
    for (const cap of node.entry.capabilities) provided.add(cap);
  }

  // Merge duplicate requirements so one capability yields one gap.
  const needed = new Map<CapabilityId, string[]>();
  for (const req of required) {
    const existing = needed.get(req.capability) ?? [];
    needed.set(req.capability, [...existing, ...(req.taskIds ?? [])]);
  }

  const gaps: CapabilityGap[] = [];
  for (const [capability, taskIds] of needed) {
    if (provided.has(capability)) continue;
    const candidates = rankCandidates(capability, nodes);
    gaps.push({
      capability,
      taskIds: [...new Set(taskIds)],
      candidates,
      message: gapMessage(capability, candidates),
    });
  }

  // Most-blocking first: a gap holding up five tasks matters more than one
  // holding up a single optional step.
  return gaps.sort((a, b) => b.taskIds.length - a.taskIds.length);
}

/**
 * The single next action that unblocks the most work. Drives the one
 * prominent suggestion the environment surfaces, rather than presenting
 * the user with a wall of every gap at once.
 */
export function nextBestConnection(gaps: CapabilityGap[]): { gap: CapabilityGap; candidate: Candidate } | null {
  for (const gap of gaps) {
    const candidate = gap.candidates.find((c) => c.connectable);
    if (candidate) return { gap, candidate };
  }
  return null;
}
