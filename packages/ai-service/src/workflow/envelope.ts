/**
 * envelope — the authority a workflow requests, derived from its graph.
 * ==================================================================
 * An envelope answers "what could this workflow do to my machine?"
 * BEFORE it runs, and it is computed, never declared: it is a projection
 * of the node types actually present in a version, resolved against the
 * `CAPABILITY_MANIFEST`. A workflow cannot claim to be harmless — the
 * only thing that decides its envelope is which nodes it contains.
 *
 * ── This is not a policy engine ────────────────────────────────────
 * The distinction matters and is easy to lose. `evaluatePolicy()` decides
 * whether an action may happen. This file decides nothing. It reports what
 * a graph WOULD ask for so a human can be shown it once, up front,
 * instead of discovering it one approval at a time. Every scope listed
 * here is still evaluated, gated and audited by the Fabric at run time
 * exactly as if the envelope did not exist. Delete this file and the
 * security properties are unchanged; only the user's ability to see them
 * in advance is lost.
 *
 * ── Why it earns its place anyway ──────────────────────────────────
 * Three things in the product need it and cannot be built without it:
 *
 *   1. An imported or AI-generated workflow is untrusted content with a
 *      friendly name. Showing its full envelope before the first run is
 *      the supply-chain control.
 *   2. Privilege creep across versions is invisible without a diff.
 *      `diffEnvelopes()` makes "this version adds process.execute" a fact
 *      the UI can state.
 *   3. "The agent's tools ≤ the workflow's permissions" needs a set to
 *      compare against. `envelope.capabilities` IS that set — see
 *      `agent/bounds.ts`.
 *
 * The most important field is `cannot`. A list of what a workflow may do
 * tells a user what to fear; a plain statement of what it can never do is
 * what lets them stop reading. Absence of authority is information.
 */

import {
  CAPABILITY_MANIFEST,
  describeFabricCapability,
  type CapabilityDescriptor,
  type PermissionScope,
  type RiskLevel,
} from '@aura/capability-fabric';
import { NEEDS_NETWORK, NODE_CLASS, capabilityForNode } from './governed';
import type { WfNode, WfNodeType } from './types';

/** Scopes reported on an envelope, in the order a person reads them. */
const SCOPE_ORDER: PermissionScope[] = [
  'project.read',
  'project.write',
  'process.execute',
  'network.outbound',
  'aura.read',
  'aura.write',
  'account.authorize',
  'resource.destroy',
  'system.modify',
];

const SCOPE_LABEL: Record<PermissionScope, string> = {
  'project.read': 'read this project',
  'project.write': 'write to this project',
  'process.execute': 'run commands',
  'network.outbound': 'reach the network',
  'aura.read': "read AURA's own state",
  'aura.write': "change AURA's own state",
  'account.authorize': 'act against your accounts',
  'resource.destroy': 'destroy resources',
  'system.modify': 'install or change software on this machine',
};

export interface EnvelopeCapability {
  capabilityId: string;
  name: string;
  risk: RiskLevel;
  irreversible: boolean;
  permissions: PermissionScope[];
  /** Workflow node ids that request it. */
  nodeIds: string[];
  /**
   * True when this capability is here because an agent node declared it
   * rather than because a node type implies it.
   *
   * Worth distinguishing on the envelope card: "this workflow writes
   * files" and "an agent in this workflow may decide to write files" are
   * different promises, and only one of them is deterministic.
   */
  viaAgent?: boolean;
}

export interface EnvelopeScope {
  scope: PermissionScope;
  label: string;
  /** Capability ids in this workflow that need it. */
  capabilityIds: string[];
  nodeIds: string[];
  /** The strictest risk among the capabilities requesting it. */
  risk: RiskLevel;
}

export interface AuthorityEnvelope {
  /** Governed capabilities the graph can invoke, sorted by risk then id. */
  capabilities: EnvelopeCapability[];
  /** Scopes those capabilities need, in reading order. */
  scopes: EnvelopeScope[];
  /** Scopes NOT requested. The load-bearing half of the envelope. */
  notRequested: PermissionScope[];
  /** Plain sentence naming what this workflow can never do. */
  cannot: string;
  /** True when the graph contains an irreversible capability. */
  hasIrreversible: boolean;
  /** Highest risk present, or null for a graph with no governed node. */
  highestRisk: RiskLevel | null;
  /** Hosts the graph can reach, when every URL is a literal. */
  hosts: { known: string[]; dynamic: boolean };
  /** True when nothing in the graph declares a need for the network. */
  offlineCapable: boolean;
  /** Node types present that cause an effect but have no capability. */
  auraInternalEffects: { nodeId: string; type: WfNodeType }[];
  /** Node ids whose type this build does not know. Never silently ignored. */
  unknownNodes: string[];
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const stricterRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (RISK_RANK[a] >= RISK_RANK[b] ? a : b);

/**
 * The host a node will contact, when it can be known without running.
 *
 * A URL containing `{{…}}` is interpolated at run time from data this
 * function cannot see, so the honest answer is "dynamic" rather than a
 * guess. Reporting a guessed host would be worse than reporting none: it
 * would tell a user their workflow is confined to a host when it is not.
 */
/** Tools an agent node declares, in either shape the inspector may save. */
function agentToolsOf(node: WfNode): string[] {
  const raw = node.config?.tools;
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string' && !!t);
  if (typeof raw === 'string') return raw.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  return [];
}

function hostOf(raw: unknown): { host?: string; dynamic: boolean } {
  if (typeof raw !== 'string' || !raw.trim()) return { dynamic: false };
  if (/\{\{/.test(raw)) return { dynamic: true };
  try {
    return { host: new URL(raw).host, dynamic: false };
  } catch {
    return { dynamic: true };
  }
}

export function computeEnvelope(nodes: WfNode[]): AuthorityEnvelope {
  const byCapability = new Map<string, EnvelopeCapability>();
  const auraInternalEffects: { nodeId: string; type: WfNodeType }[] = [];
  const unknownNodes: string[] = [];
  const hosts = new Set<string>();
  let dynamicHost = false;
  let needsNetwork = false;

  for (const node of nodes) {
    const klass = NODE_CLASS[node.type];
    if (!klass) { unknownNodes.push(node.id); continue; }
    if (klass === 'aura-internal') auraInternalEffects.push({ nodeId: node.id, type: node.type });
    if (NEEDS_NETWORK[node.type]) needsNetwork = true;

    /* An agent node contributes the tools it declares.
     *
     * It has to. The envelope's job is to say what the workflow can do,
     * and an agent holding `git.status` can do `git.status` — leaving it
     * out would make the envelope understate the workflow's authority,
     * which is the one direction it must never be wrong in. It would also
     * make an agent-only workflow unable to use any tool at all, since
     * `resolveTools` narrows against this set.
     *
     * The SAME four safety rules `bounds.ts` applies are applied here, and
     * they are applied here FIRST: a definition naming `git.push` in an
     * agent's tools does not widen the envelope, so it cannot widen the
     * run's least-privilege grants either. The two places agree because
     * an id excluded here is absent from the envelope `resolveTools` then
     * checks against.
     */
    if (node.type === 'agent') {
      for (const requested of agentToolsOf(node)) {
        const descriptor = describeFabricCapability(requested);
        if (!descriptor) continue;
        if (descriptor.irreversible) continue;
        if (descriptor.permissions.some((p) => p === 'account.authorize' || p === 'resource.destroy' || p === 'system.modify')) continue;
        const existing = byCapability.get(requested);
        if (existing) { if (!existing.nodeIds.includes(node.id)) existing.nodeIds.push(node.id); continue; }
        byCapability.set(requested, {
          capabilityId: requested,
          name: descriptor.name,
          risk: descriptor.risk,
          irreversible: false,
          permissions: [...descriptor.permissions],
          nodeIds: [node.id],
          viaAgent: true,
        });
      }
      continue;
    }

    const capabilityId = capabilityForNode(node.type);
    if (!capabilityId) continue;

    const descriptor = describeFabricCapability(capabilityId);
    if (!descriptor) {
      // A binding pointing at a capability the manifest does not define is
      // a build error, not a runtime surprise. Surfacing it as an unknown
      // node keeps it visible instead of silently narrowing the envelope.
      unknownNodes.push(node.id);
      continue;
    }

    const existing = byCapability.get(capabilityId);
    if (existing) existing.nodeIds.push(node.id);
    else {
      byCapability.set(capabilityId, {
        capabilityId,
        name: descriptor.name,
        risk: descriptor.risk,
        irreversible: Boolean(descriptor.irreversible),
        permissions: [...descriptor.permissions],
        nodeIds: [node.id],
      });
    }

    if (node.type === 'http-request') {
      const { host, dynamic } = hostOf(node.config?.url);
      if (host) hosts.add(host);
      if (dynamic) dynamicHost = true;
    }
    if (node.type === 'slack-notify') {
      const { host, dynamic } = hostOf(node.config?.webhookUrl);
      if (host) hosts.add(host);
      if (dynamic) dynamicHost = true;
    }
  }

  const capabilities = [...byCapability.values()].sort(
    (a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || a.capabilityId.localeCompare(b.capabilityId),
  );

  const scopeMap = new Map<PermissionScope, EnvelopeScope>();
  for (const cap of capabilities) {
    for (const scope of cap.permissions) {
      const entry = scopeMap.get(scope);
      if (entry) {
        entry.capabilityIds.push(cap.capabilityId);
        for (const id of cap.nodeIds) if (!entry.nodeIds.includes(id)) entry.nodeIds.push(id);
        entry.risk = stricterRisk(entry.risk, cap.risk);
      } else {
        scopeMap.set(scope, {
          scope,
          label: SCOPE_LABEL[scope],
          capabilityIds: [cap.capabilityId],
          nodeIds: [...cap.nodeIds],
          risk: cap.risk,
        });
      }
    }
  }

  const scopes = SCOPE_ORDER.filter((s) => scopeMap.has(s)).map((s) => scopeMap.get(s)!);

  /* An agent holding a network capability can reach the network, so a
     workflow containing one is not offline-capable.
     
     Derived from the ADMITTED capabilities, never from the raw config. An
     earlier version read the agent's configured tool list directly, which
     meant a tool the envelope had already refused — `git.push`, say — still
     flipped this flag. The report then said "cannot reach the network" and
     "offlineCapable: false" in the same breath, which is not a conservative
     answer, it is a contradictory one. */
  if (scopeMap.has('network.outbound')) needsNetwork = true;
  const notRequested = SCOPE_ORDER.filter((s) => !scopeMap.has(s));

  const cannotParts: string[] = [];
  if (notRequested.includes('system.modify')) cannotParts.push('install or change software on this machine');
  if (notRequested.includes('resource.destroy')) cannotParts.push('destroy anything');
  if (notRequested.includes('account.authorize')) cannotParts.push('act against your accounts');
  if (notRequested.includes('process.execute')) cannotParts.push('run commands');
  if (notRequested.includes('project.write')) cannotParts.push('write to this project');
  if (notRequested.includes('network.outbound')) cannotParts.push('reach the network');
  else if (hosts.size && !dynamicHost) cannotParts.push(`reach any host other than ${[...hosts].sort().join(', ')}`);

  const cannot = cannotParts.length
    ? `This workflow cannot ${cannotParts.join(', ')}.`
    : 'This workflow requests every permission AURA can grant.';

  return {
    capabilities,
    scopes,
    notRequested,
    cannot,
    hasIrreversible: capabilities.some((c) => c.irreversible),
    highestRisk: capabilities.length ? capabilities.reduce<RiskLevel>((a, c) => stricterRisk(a, c.risk), 'low') : null,
    hosts: { known: [...hosts].sort(), dynamic: dynamicHost },
    offlineCapable: !needsNetwork,
    auraInternalEffects,
    unknownNodes,
  };
}

/* ══════════════════════════════════════════════════════════════════
   Diff — privilege creep across versions
   ══════════════════════════════════════════════════════════════════ */

export interface EnvelopeDiff {
  /** True when the new envelope asks for anything the old one did not. */
  widened: boolean;
  addedScopes: PermissionScope[];
  removedScopes: PermissionScope[];
  addedCapabilities: string[];
  removedCapabilities: string[];
  /** True when the new version introduces an irreversible action. */
  newlyIrreversible: boolean;
  /** One sentence, or null when nothing changed. */
  summary: string | null;
}

export function diffEnvelopes(before: AuthorityEnvelope, after: AuthorityEnvelope): EnvelopeDiff {
  const beforeScopes = new Set(before.scopes.map((s) => s.scope));
  const afterScopes = new Set(after.scopes.map((s) => s.scope));
  const beforeCaps = new Set(before.capabilities.map((c) => c.capabilityId));
  const afterCaps = new Set(after.capabilities.map((c) => c.capabilityId));

  const addedScopes = [...afterScopes].filter((s) => !beforeScopes.has(s)).sort();
  const removedScopes = [...beforeScopes].filter((s) => !afterScopes.has(s)).sort();
  const addedCapabilities = [...afterCaps].filter((c) => !beforeCaps.has(c)).sort();
  const removedCapabilities = [...beforeCaps].filter((c) => !afterCaps.has(c)).sort();
  const newlyIrreversible = after.hasIrreversible && !before.hasIrreversible;
  const widened = addedScopes.length > 0 || addedCapabilities.length > 0 || newlyIrreversible;

  const parts: string[] = [];
  if (addedScopes.length) parts.push(`adds ${addedScopes.join(', ')}`);
  if (removedScopes.length) parts.push(`no longer needs ${removedScopes.join(', ')}`);
  if (newlyIrreversible) parts.push('introduces an action that cannot be undone');

  return {
    widened,
    addedScopes,
    removedScopes,
    addedCapabilities,
    removedCapabilities,
    newlyIrreversible,
    summary: parts.length ? `This version ${parts.join('; ')}.` : null,
  };
}

/** Every capability id the manifest defines, for the agent tool picker. */
export function allCapabilityIds(): string[] {
  return CAPABILITY_MANIFEST.map((c: CapabilityDescriptor) => c.id).sort();
}
