/**
 * Execution safety without a human approval step.
 *
 * Every capability decision the policy can produce is auto-execute or deny.
 * Routine work runs; a hard floor or a disallowed action is refused at once,
 * before any effect. No decision parks work for a person.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_MANIFEST,
  DEFAULT_POLICY,
  evaluatePolicy,
  sanitizePolicy,
  type CapabilityDescriptor,
  type PolicyConfig,
} from '@aura/capability-fabric';

const cap = (id: string): CapabilityDescriptor => {
  const c = CAPABILITY_MANIFEST.find((x) => x.id === id);
  if (!c) throw new Error(`manifest has no ${id}`);
  return c;
};

const decide = (c: CapabilityDescriptor, config: PolicyConfig, nodeAvailable: boolean | null = null) =>
  // The host grants the scopes the node really holds; here, exactly what the capability needs.
  evaluatePolicy({ capability: c, config, granted: [...c.permissions], nodeAvailable });

const ROUTINE = ['git.status', 'filesystem.write'];

describe('supported tasks run without a human approval step', () => {
  it('routine read and write capabilities auto-execute under the default policy', () => {
    for (const id of ROUTINE) {
      const out = decide(cap(id), DEFAULT_POLICY);
      expect(out.decision, id).toBe('auto-execute');
    }
  });
});

describe('disallowed actions are refused directly, never held', () => {
  it('an irreversible action is refused by its floor', () => {
    const out = decide(cap('git.push'), DEFAULT_POLICY);
    expect(out.decision).toBe('deny');
    expect(out.rule).toBe('irreversible-floor');
  });

  it('turning autonomy off refuses AURA-initiated work instead of asking', () => {
    const out = decide(cap('git.status'), { ...DEFAULT_POLICY, allowAutonomous: false });
    expect(out.decision).toBe('deny');
    expect(out.rule).toBe('autonomy-disabled');
  });

  it('a missing node is refused', () => {
    const out = decide(cap('git.status'), DEFAULT_POLICY, false);
    expect(out.decision).toBe('deny');
  });
});

describe('every decision is final: no approval state is reachable', () => {
  const CONFIGS: Array<[string, PolicyConfig]> = [
    ['default', DEFAULT_POLICY],
    ['autonomy off', { ...DEFAULT_POLICY, allowAutonomous: false }],
    ['legacy ask/approve values', sanitizePolicy({
      byRisk: { low: 'ask-user', medium: 'require-approval', high: 'require-approval' },
      overrides: { 'git.status': 'ask-user', 'git.push': 'require-approval' },
    })],
  ];

  it('no capability in the manifest can produce ask-user or require-approval', () => {
    for (const [name, config] of CONFIGS) {
      for (const c of CAPABILITY_MANIFEST) {
        for (const nodeAvailable of [null, true, false] as const) {
          const { decision } = decide(c, config, nodeAvailable);
          expect(['auto-execute', 'deny'], `${name} / ${c.id}`).toContain(decision);
        }
      }
    }
  });
});

describe('saved policy from before the approval workflow', () => {
  it('a legacy "ask" runs under policy and a legacy "require approval" is refused', () => {
    const cfg = sanitizePolicy({ byRisk: { low: 'ask-user', medium: 'require-approval', high: 'deny' } });
    expect(cfg.byRisk.low).toBe('auto-execute');
    expect(cfg.byRisk.medium).toBe('deny');
    expect(cfg.byRisk.high).toBe('deny');
  });

  it('an unrecognised saved value is dropped, not carried into the engine', () => {
    const cfg = sanitizePolicy({ byRisk: { low: 'maybe-later' } });
    expect(cfg.byRisk.low).toBe(DEFAULT_POLICY.byRisk.low);
  });
});
