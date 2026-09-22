/**
 * autonomy — normal operations run; destruction still parks.
 *
 * The shipped default policy carries explicit autonomy grants for
 * delegation, mission control, writes, terminal use and git. Each is
 * reversible through version control or bounded by allow-lists, and
 * the grant fires only when no floor fired: floors beat grants, so
 * listing a destructive capability changes nothing. Operators can
 * still re-gate any grant with an override (overrides only escalate).
 *
 * Runs with `npm run test:service` from the repo root.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  CAPABILITY_MANIFEST,
  type CapabilityDescriptor,
  type PermissionScope,
  type PolicyConfig,
} from '@aura/capability-fabric';

const AUTO = [
  'agent.delegate',
  'mission.approve',
  'mission.start',
  'filesystem.write',
  'terminal.execute',
  'git.commit',
  'git.push',
];

const STILL_GATED = ['filesystem.delete', 'system.install', 'provider.connect'];

function cap(id: string): CapabilityDescriptor {
  const found = CAPABILITY_MANIFEST.find((c) => c.id === id);
  if (!found) throw new Error(`${id} is not in the manifest`);
  return found;
}

function decide(id: string, config: PolicyConfig = DEFAULT_POLICY): string {
  const c = cap(id);
  return evaluatePolicy({
    capability: c,
    config,
    // Grant everything grantable; human-only scopes stay absent, which
    // is exactly the production shape (no node can hold them).
    granted: (c.permissions ?? []).filter(
      (p): p is PermissionScope =>
        p !== 'resource.destroy' && p !== 'account.authorize' && p !== 'system.modify',
    ),
    nodeAvailable: true,
  }).decision;
}

describe('autonomy grants', () => {
  it.each(AUTO)('%s runs without parking', (id) => {
    expect(decide(id)).toBe('auto-execute');
  });

  it.each(STILL_GATED)('%s still parks', (id) => {
    expect(decide(id)).toBe('require-approval');
  });

  it('floors beat grants: a listed destructive capability still parks', () => {
    const config: PolicyConfig = {
      ...DEFAULT_POLICY,
      autonomy: [...DEFAULT_POLICY.autonomy, 'filesystem.delete'],
    };
    expect(decide('filesystem.delete', config)).toBe('require-approval');
  });

  it('an operator override can re-gate any grant', () => {
    const config: PolicyConfig = {
      ...DEFAULT_POLICY,
      overrides: { ...DEFAULT_POLICY.overrides, 'agent.delegate': 'require-approval' },
    };
    expect(decide('agent.delegate', config)).toBe('require-approval');
  });

  it('allowAutonomous=false suppresses every grant', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY, allowAutonomous: false };
    for (const id of AUTO) expect(decide(id, config)).toBe('ask-user');
    // Floors are unaffected by the switch.
    expect(decide('filesystem.delete', config)).toBe('require-approval');
  });
});
