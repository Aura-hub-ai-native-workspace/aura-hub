/**
 * policy — may this happen, and on whose authority?
 * ==================================================================
 * Evaluated on EVERY invocation, before any executor is reached. The
 * order below is deliberate and is the security argument of the whole
 * Fabric: the things that protect the user are checked first and cannot
 * be configured away.
 *
 *   1. Hard floors      — cannot be overridden by any configuration
 *   2. Permission check — the acting node's granted scopes
 *   3. Capability override — explicit per-capability configuration
 *   4. Autonomy switch  — the user's global "ask me first"
 *   5. Risk default     — low/medium/high → decision
 *
 * A configuration mistake can make the Fabric *more* cautious than
 * intended. It cannot make it less cautious than the hard floors.
 */

import type {
  CapabilityDescriptor,
  PermissionScope,
  PolicyConfig,
  PolicyDecision,
  PolicyEvaluation,
  RiskLevel,
} from './types';

/**
 * The shipped default. Matches §5 of the brief: low risk runs, medium
 * risk asks, high risk requires an explicit authorization record.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  byRisk: {
    low: 'auto-execute',
    medium: 'ask-user',
    high: 'require-approval',
  },
  overrides: {
    // Human gates by definition — approving a plan or authorizing an
    // account is the moment the human is *supposed* to be present.
    'mission.approve': 'ask-user',
    'provider.connect': 'require-approval',
  },
  allowAutonomous: true,
};

/**
 * Scopes no node flag can ever grant. Only a human authorization
 * satisfies these — see the floors in `evaluatePolicy`.
 */
const HUMAN_ONLY_SCOPES = new Set<PermissionScope>(['account.authorize', 'resource.destroy']);

const DECISIONS = new Set<PolicyDecision>(['auto-execute', 'ask-user', 'require-approval', 'deny']);

const isDecision = (v: unknown): v is PolicyDecision => typeof v === 'string' && DECISIONS.has(v as PolicyDecision);

/**
 * Coerce untrusted input — a hand-edited file on disk, or a request body —
 * into a policy this engine will accept.
 *
 * Persisted configuration is the one place a *file* gets a say in security
 * decisions, so it is treated as hostile: anything not recognised is
 * dropped rather than passed through to `evaluatePolicy`. This does not
 * need to protect the hard floors — those are checked before any
 * configuration is consulted and return early, so no value here can reach
 * them. What it does protect against is a corrupt or malicious file
 * injecting an unknown decision string that later comparisons would treat
 * as "not require-approval" and quietly wave through.
 */
export function sanitizePolicy(raw: unknown): PolicyConfig {
  const input = (raw ?? {}) as Partial<PolicyConfig>;
  const byRisk = { ...DEFAULT_POLICY.byRisk };
  for (const level of ['low', 'medium', 'high'] as RiskLevel[]) {
    const v = (input.byRisk as Record<string, unknown> | undefined)?.[level];
    if (isDecision(v)) byRisk[level] = v;
  }

  const overrides: Record<string, PolicyDecision> = {};
  for (const [id, v] of Object.entries((input.overrides ?? {}) as Record<string, unknown>)) {
    if (typeof id === 'string' && id && isDecision(v)) overrides[id] = v;
  }

  // Absent means "never configured" → the shipped default. Present but not
  // a boolean means a corrupt or tampered file, and the safe reading of a
  // damaged autonomy setting is the cautious one, not the permissive one.
  // Node rules get the same hostile-input treatment: an unrecognised
  // decision is dropped rather than carried into the engine, and a
  // malformed allowlist becomes an EMPTY list, not a missing one — a
  // corrupt allowlist must fail closed (deny everything) rather than open.
  const nodeOverrides: Record<string, PolicyDecision> = {};
  for (const [key, v] of Object.entries((input.nodeOverrides ?? {}) as Record<string, unknown>)) {
    if (typeof key === 'string' && key.includes('@') && isDecision(v)) nodeOverrides[key] = v;
  }

  const nodeAllowlists: Record<string, string[]> = {};
  for (const [capabilityId, v] of Object.entries((input.nodeAllowlists ?? {}) as Record<string, unknown>)) {
    if (typeof capabilityId !== 'string' || !capabilityId) continue;
    nodeAllowlists[capabilityId] = Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && !!x)
      : [];
  }

  const rawAutonomy = (input as Record<string, unknown>).allowAutonomous;
  const allowAutonomous = rawAutonomy === undefined
    ? DEFAULT_POLICY.allowAutonomous
    : typeof rawAutonomy === 'boolean' ? rawAutonomy : false;

  return { byRisk, overrides, nodeOverrides, nodeAllowlists, allowAutonomous };
}

const RANK: Record<PolicyDecision, number> = {
  'auto-execute': 0,
  'ask-user': 1,
  'require-approval': 2,
  deny: 3,
};

/** The stricter of two decisions. Policy only ever escalates. */
function stricter(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Who and what a decision is about, beyond the capability itself.
 *
 * Only `node` is consulted by a rule today (§23.5). The rest is threaded
 * through for the audit trail and for rules that may key off it later;
 * saying so plainly is better than implying a governance surface that
 * does not exist yet.
 */
export interface PolicySubject {
  /** The node that will actually perform this. Identity only — not the
   *  whole `NodeRef`, so catalogue metadata is not duplicated here. */
  node?: { id: string; name: string };
  /** What the caller asked for, when they named a node. */
  requestedNodeId?: string;
  actorKind?: string;
  actorId?: string;
  projectId?: string | null;
  missionId?: string;
  taskId?: string;
}

export interface PolicyInput {
  capability: CapabilityDescriptor;
  config: PolicyConfig;
  /**
   * Scopes the acting node actually holds. Derived from the node's
   * `NodePermissions` by the host — see `grantsFor()`.
   */
  granted: PermissionScope[];
  /**
   * Whether the node capability this action needs is currently provided
   * by a connected node. `null` when the capability needs none.
   */
  nodeAvailable: boolean | null;
  /** Node identity and correlation keys. Absent for node-free calls. */
  subject?: PolicySubject;
}

export function evaluatePolicy(input: PolicyInput): PolicyEvaluation {
  const { capability, config, granted, nodeAvailable } = input;
  const risk: RiskLevel = capability.risk;

  /* 1. Hard floors — not configurable, in precedence order. */

  if (nodeAvailable === false) {
    return {
      decision: 'deny',
      rule: 'no-provider',
      risk,
      reason: `Nothing connected can perform ${capability.name.toLowerCase()} yet. Connect a node that provides it and this becomes available.`,
    };
  }

  // Only node-grantable scopes are checked here. `account.authorize` and
  // `resource.destroy` are deliberately ungrantable by any node flag —
  // they are satisfied by the human approval the floors below demand.
  // Checking them here instead would deny those capabilities outright and
  // make authorization impossible rather than gated.
  const missing = capability.permissions.filter(
    (p) => !HUMAN_ONLY_SCOPES.has(p) && !granted.includes(p),
  );
  if (missing.length) {
    return {
      decision: 'deny',
      rule: 'permission-denied',
      risk,
      reason: `This needs ${missing.join(', ')}, which has not been granted. Grant it on the node and try again.`,
    };
  }

  /**
   * The `require-approval` floors are a LOWER BOUND, not a final answer.
   *
   * They used to return immediately, which made them a ceiling as well as
   * a floor: nothing could ever be *stricter* than "needs approval", so a
   * rule denying a specific node could not be expressed for exactly the
   * capabilities where it matters most — the irreversible ones.
   *
   * Seeding the decision instead keeps the guarantee intact, because every
   * layer below folds with `stricter()` and can only escalate. No
   * configuration can go beneath a floor; a denial can still rise above
   * one.
   */
  let decision: PolicyDecision = config.byRisk[risk];
  let rule = `risk-default:${risk}`;
  let reason = '';

  const floor = (name: string, why: string) => {
    decision = stricter(decision, 'require-approval');
    rule = name;
    reason = why;
  };

  if (capability.irreversible) {
    // An action the Fabric cannot undo is never silent, no matter how the
    // policy is configured. This is the floor that makes "autonomous" safe
    // to switch on at all.
    floor('irreversible-floor',
      `${capability.name} cannot be undone from here, so it always needs your explicit go-ahead.`);
  } else if (capability.permissions.includes('resource.destroy')) {
    floor('destructive-floor', `${capability.name} destroys something. That is always your call.`);
  } else if (capability.permissions.includes('account.authorize')) {
    floor('authorization-floor',
      `${capability.name} acts against your account, so you authorize it yourself.`);
  }

  /* 2–6. Configurable layers, each only able to escalate. */

  /**
   * Fold one candidate in, and decide whether it earns the reported rule.
   *
   * A candidate claims the rule when it genuinely escalates, or when it
   * restates the current level from a more specific position (candidates
   * arrive least-specific first, so a later equal is more specific). A
   * candidate weaker than the standing decision changes nothing and must
   * NOT claim it — otherwise a permissive capability override would
   * relabel an irreversible floor it never actually overcame, and the
   * decision would be reported under a rule that did not cause it.
   */
  const apply = (candidate: PolicyDecision | undefined, name: string, why: string) => {
    if (!candidate) return;
    const escalates = RANK[candidate] > RANK[decision];
    const confirms = RANK[candidate] === RANK[decision] && candidate === decision;
    if (escalates || confirms) { rule = name; reason = why; }
    decision = stricter(decision, candidate);
  };

  apply(config.overrides[capability.id], `override:${capability.id}`, '');

  const node = input.subject?.node;
  if (node) {
    // Least specific first: node-wide, then this capability on this node.
    apply(
      config.nodeOverrides?.[`@${node.id}`],
      `node-override:@${node.id}`,
      `${node.name} is restricted by the workspace policy.`,
    );
    apply(
      config.nodeOverrides?.[`${capability.id}@${node.id}`],
      `node-override:${capability.id}@${node.id}`,
      `${node.name} is not permitted to perform ${capability.name.toLowerCase()} under the workspace policy.`,
    );

    // An allowlist that exists and excludes this node is a denial. An
    // absent allowlist is not an empty one — it means "no list configured".
    const allowlist = config.nodeAllowlists?.[capability.id];
    if (allowlist && !allowlist.includes(node.id)) {
      apply(
        'deny',
        `node-not-allowlisted:${capability.id}`,
        `${node.name} is not on the list of nodes permitted to perform ${capability.name.toLowerCase()}.`,
      );
    }
  }

  if (!config.allowAutonomous && decision === 'auto-execute') {
    decision = 'ask-user';
    rule = 'autonomy-disabled';
    reason = '';
  }

  return { decision, rule, risk, reason: reason || reasonFor(decision, capability) };
}

function reasonFor(decision: PolicyDecision, capability: CapabilityDescriptor): string {
  switch (decision) {
    case 'auto-execute':
      return `${capability.name} is low risk and reversible, so it runs without interrupting you.`;
    case 'ask-user':
      return `${capability.name} changes something. One confirmation and it proceeds.`;
    case 'require-approval':
      return `${capability.name} needs your explicit authorization, recorded against this mission.`;
    case 'deny':
      return `${capability.name} is not permitted under the current policy.`;
  }
}

/**
 * Translate a node's coarse permission flags into the scopes the policy
 * engine checks. Kept here, next to the check, so the mapping cannot
 * drift away from what it is used for.
 */
export function grantsFor(permissions: {
  read: boolean;
  write: boolean;
  execute: boolean;
  autonomous: boolean;
}): PermissionScope[] {
  const out: PermissionScope[] = [];
  if (permissions.read) out.push('project.read', 'aura.read');
  if (permissions.write) out.push('project.write', 'aura.write');
  if (permissions.execute) out.push('process.execute', 'network.outbound');
  // `resource.destroy` and `account.authorize` are never granted by a node
  // flag. They are always the user's explicit act, per the hard floors
  // above — which is why granting "write" can never escalate into
  // destroying a database or connecting an account.
  return out;
}
