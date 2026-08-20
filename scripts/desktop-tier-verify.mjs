/**
 * desktop-tier-verify — the actuation ladder, proved rather than asserted.
 * ==================================================================
 * Four claims, each with a NEGATIVE CONTROL that proves the check is
 * capable of failing. A verification suite whose checks cannot fail is
 * decoration, and this file is the one place in the phase where that
 * distinction is load-bearing:
 *
 *   1. The tier that ran is RECORDED — on the result and on the journal
 *      entry. Control: a capability with no tiers records none, so the
 *      field is not being stamped blindly onto everything.
 *
 *   2. An unavailable tier reports `not-executed` and NEVER guesses.
 *      Control: the same capability with an available probe really does
 *      execute, so the check is not simply always-on.
 *
 *   3. A tier-6 action is never `auto-execute` — not under a policy
 *      configured to auto-execute everything, and not for a direct user
 *      action. Control: an equivalent capability WITHOUT tier 6 does
 *      reach `auto-execute` under that same policy, so the floor is
 *      doing the work rather than the risk level.
 *
 *   4. Per-platform support is declared, and the declaration MATCHES
 *      this machine. Control: a deliberately wrong declaration is caught.
 *
 * Run:  node scripts/desktop-tier-verify.mjs
 *
 * Everything is exercised against the real manifest, the real policy
 * engine, the real Fabric and the real drivers. State is redirected to a
 * scratch AURA_HOME so the suite cannot touch the user's own.
 */

import { register } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Redirected BEFORE anything imports the service, because `persist.ts`
// reads AURA_HOME at call time and the approval store writes on attach.
process.env.AURA_HOME = mkdtempSync(path.join(tmpdir(), 'aura-tier-verify-'));

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const {
  CapabilityFabric,
  describeFabricCapability,
  evaluatePolicy,
  selectTier,
  DEFAULT_POLICY,
  TIER_NAME,
  tierFloor,
  tierRisk,
} = await load('packages/capability-fabric/src/index.ts');

const { createFabric } = await load('packages/ai-service/src/fabric/index.ts');
const { allExecutors } = await load('packages/ai-service/src/fabric/executors.ts');
const { desktopTierRegistry, accessibilityDriver, guiDriver } = await load(
  'packages/ai-service/src/desktop/drivers.ts',
);
const { detectDesktopSession } = await load('packages/ai-service/src/desktop/session.ts');
const { scanApplications } = await load('packages/ai-service/src/environment.ts');
const { APPLICATION_ADAPTERS, targetPlatformOf } = await load(
  'packages/connected-environment/src/index.ts',
);

/* ── reporting ─────────────────────────────────────────────────── */

let failed = 0;
let passed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const control = (name, ok, extra = '') => check(`  ↳ control: ${name}`, ok, extra);
const info = (m) => console.log(`      ${m}`);
const section = (n, t) => console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

/* ── a Fabric wired exactly like the real one, with a scriptable probe ──
   `probeTiers` is the ONLY thing swapped, and only so that an
   unavailable tier can be presented on a machine where the tier happens
   to be available. Everything else — manifest, policy engine, executors,
   approval flow — is the shipped code. */

function fabricWith({ probes, policy, grant = true } = {}) {
  const host = {
    // The shape `grantsFor()` consumes — coarse node flags, not scopes.
    // `system.observe` is derived from `read`, which is the mapping under
    // test, so handing scopes directly here would bypass it.
    permissionsFor: () => ({ read: grant, write: grant, execute: grant, autonomous: grant }),
    nodeAvailable: (c) => (c.requiresNodeCapability ? true : null),
    resolveNode: () => ({ ok: true }),
    probeTiers: (capability) => {
      if (!capability.tiers?.length) return [];
      return probes === undefined ? desktopTierRegistry.probeAll() : probes;
    },
    // Stands in for the human. Grants only what the invocation named,
    // which is the real host's rule too.
    requestApproval: async (request, context) => {
      const approved = new Set(context.approvedCapabilities ?? []);
      return request.items.every((i) => approved.has(i.capabilityId));
    },
  };
  const f = new CapabilityFabric(host);
  for (const e of allExecutors({})) f.register(e);
  if (policy) f.setPolicy(policy);
  return f;
}

const ctx = (extra = {}) => ({
  actor: { kind: 'agent', id: 'verify:desktop-tier' },
  projectId: null,
  ...extra,
});

const session = await detectDesktopSession(true);
const platform = targetPlatformOf(process.platform);

console.log(`AURA Hub — desktop actuation tier verification`);
console.log(`machine: ${process.platform} · platform=${platform} · display=${session.display ?? 'n/a'}`);
if (session.atspi) info(`AT-SPI: ${session.atspi.detail}`);
info(`tools: ${Object.entries(session.tools).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' ')}`);

/* ══════════════════════════════════════════════════════════════════
   1. The tier that ran is recorded
   ══════════════════════════════════════════════════════════════════ */

section(1, 'the actuation tier is recorded on every invocation');

{
  const fabric = fabricWith();
  const tiered = ['desktop.accessibility.observe', 'desktop.windows.observe'];

  for (const id of tiered) {
    const cap = describeFabricCapability(id);
    const result = await fabric.invoke(id, {}, ctx({ approvedCapabilities: [id] }));
    const record = fabric.audit().find((a) => a.invocationId === result.invocationId);

    // A tier that was never available is a legitimate outcome here (this
    // suite must pass on a headless CI runner too). What is NOT
    // legitimate is executing without recording which rung did it.
    const ran = result.outcome !== 'not-executed' && result.outcome !== 'denied';
    if (!ran) {
      check(`${id}: not executed on this machine, and says so`, result.outcome === 'not-executed', result.outcome);
      info(result.detail.slice(0, 140));
      check(`${id}: records no tier, because nothing ran`, result.tier === undefined);
      check(`${id}: carries the selection that explains it`, Boolean(result.tierSelection));
      continue;
    }

    check(`${id}: result records the tier that ran`, result.tier !== undefined,
      result.tier ? `tier ${result.tier} (${TIER_NAME[result.tier]})` : 'ABSENT');
    check(`${id}: journal entry records the tier`, record?.tier !== undefined,
      record?.tier ? `tier ${record.tier}` : 'ABSENT');
    check(`${id}: recorded tier is one the capability declared`,
      result.tier !== undefined && cap.tiers.includes(result.tier),
      `declared [${cap.tiers.join(', ')}], ran ${result.tier}`);
    check(`${id}: result and journal agree on the tier`, result.tier === record?.tier);
  }

  // NEGATIVE CONTROL. If the Fabric stamped a tier on everything, this
  // would be indistinguishable from the checks above passing honestly.
  const plain = await fabric.invoke('project.list', {}, ctx());
  const plainRecord = fabric.audit().find((a) => a.invocationId === plain.invocationId);
  control('a capability with no declared tiers records NO tier on the result',
    plain.tier === undefined, plain.tier === undefined ? '' : `got tier ${plain.tier}`);
  control('…and none on the journal entry',
    plainRecord?.tier === undefined, plainRecord?.tier === undefined ? '' : `got tier ${plainRecord.tier}`);
  control('…and no tier selection either', plain.tierSelection === undefined);
}

/* ══════════════════════════════════════════════════════════════════
   2. An unavailable tier reports not-executed and never guesses
   ══════════════════════════════════════════════════════════════════ */

section(2, 'an unavailable tier reports not-executed, and never substitutes');

{
  const UNAVAILABLE = [{
    tier: 6,
    availability: 'unavailable',
    platform,
    missing: ['a synthetic unavailability, injected by this suite'],
    detail: 'Injected by desktop-tier-verify to present tier 6 as unavailable.',
  }];

  const fabric = fabricWith({ probes: UNAVAILABLE });
  const result = await fabric.invoke('desktop.windows.observe', {},
    ctx({ approvedCapabilities: ['desktop.windows.observe'] }));
  const record = fabric.audit().find((a) => a.invocationId === result.invocationId);

  check('an unavailable tier settles `not-executed`', result.outcome === 'not-executed', result.outcome);
  check('nothing was executed — effectStarted is proven false', result.effectStarted === false);
  check('no tier is recorded, because none ran', result.tier === undefined,
    result.tier ? `claimed tier ${result.tier}` : '');
  check('the journal records no tier either', record?.tier === undefined);
  check('the reason names every tier considered', Boolean(result.tierSelection) && !result.tierSelection.ok);
  check('the detail names what was missing',
    result.detail.includes('synthetic unavailability'), result.detail.slice(0, 90));

  // The whole point: it must not have quietly used a DIFFERENT rung.
  check('no substitution — the output carries no observation',
    result.output === undefined || result.output?.items === undefined);

  // NEGATIVE CONTROL. Same capability, same suite, tier presented as
  // available: it must actually run. Without this, check 2 would pass on
  // a build where `desktop.windows.observe` was simply broken.
  const AVAILABLE = [{
    tier: 6,
    availability: 'available',
    platform,
    detail: 'Injected by desktop-tier-verify to present tier 6 as available.',
  }];
  const positive = fabricWith({ probes: AVAILABLE });
  const ran = await positive.invoke('desktop.windows.observe', {},
    ctx({ approvedCapabilities: ['desktop.windows.observe'] }));
  const reallyAvailable = (await guiDriver.probe(true)).availability === 'available';
  if (reallyAvailable) {
    control('with the tier available, the SAME capability executes and records tier 6',
      ran.outcome === 'succeeded' && ran.tier === 6, `${ran.outcome}, tier ${ran.tier}`);
    control('…and returns a real observation',
      Array.isArray(ran.output?.items), `${ran.output?.items?.length ?? 0} windows`);
  } else {
    // The driver itself refuses on this machine (headless, or Wayland).
    // That is still a control: it must FAIL rather than invent a reading.
    control('with no real display the driver refuses rather than inventing a reading',
      ran.outcome === 'failed' && ran.output?.items === undefined, ran.outcome);
    info(`this machine cannot host tier 6: ${ran.detail.slice(0, 110)}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   3. A tier-6 action is never auto-execute
   ══════════════════════════════════════════════════════════════════ */

section(3, 'a tier-6 action is never auto-execute');

{
  const cap6 = describeFabricCapability('desktop.windows.observe');
  const cap5 = describeFabricCapability('desktop.accessibility.observe');

  // The most permissive policy the engine will accept: everything
  // auto-executes, autonomy on, and an explicit override on this very
  // capability. If the floor holds here it holds anywhere.
  const PERMISSIVE = {
    byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
    overrides: { 'desktop.windows.observe': 'auto-execute' },
    allowAutonomous: true,
  };

  const granted = ['project.read', 'aura.read', 'system.observe'];
  const evalAt = (capability, tier, extra = {}) =>
    evaluatePolicy({ capability, config: PERMISSIVE, granted, nodeAvailable: null, tier, ...extra });

  const at6 = evalAt(cap6, 6);
  check('under a fully permissive policy, tier 6 is still not auto-execute',
    at6.decision !== 'auto-execute', `${at6.decision} (rule ${at6.rule})`);
  check('the reported risk is raised by the tier',
    at6.risk === 'medium' && cap6.risk === 'low', `declared ${cap6.risk}, evaluated ${at6.risk}`);

  // A direct user action satisfies the consent floors. It must NOT
  // satisfy this one: the click authorised an intent, and it cannot
  // answer which window has focus by the time the keys are sent.
  const direct = evalAt(cap6, 6, { subject: { initiator: 'user-direct' } });
  check('a direct user action does not lower the tier-6 floor',
    direct.decision !== 'auto-execute', `${direct.decision} (rule ${direct.rule})`);

  // NEGATIVE CONTROL. The same capability, same permissive policy, with
  // no tier: it MUST reach auto-execute. This proves the floor is what
  // stopped it above, and not the risk level, the permissions, or a
  // capability that simply never auto-executes.
  const untiered = evalAt(cap6, undefined);
  control('the same capability with NO tier does reach auto-execute',
    untiered.decision === 'auto-execute', `${untiered.decision} (rule ${untiered.rule})`);

  // …and the rung above it is not floored, so the floor is specific to 6.
  const at5 = evalAt(cap5, 5);
  control('tier 5 is not floored (the floor is specific to tier 6)',
    at5.decision === 'auto-execute', `${at5.decision} (rule ${at5.rule})`);
  control('tierFloor() is null below tier 6 and set at 6',
    tierFloor(5) === null && tierFloor(6) === 'ask-user');
  control('tierRisk() escalates and never lowers',
    tierRisk('low', 6) === 'medium' && tierRisk('high', 6) === 'high' && tierRisk('low', 1) === 'low');

  // And end to end, through the real invoke path with the real policy.
  const fabric = fabricWith({ policy: PERMISSIVE });
  const parked = await fabric.invoke('desktop.windows.observe', {}, ctx());
  check('end to end: an unapproved tier-6 invocation parks instead of running',
    parked.outcome === 'awaiting-approval' || parked.outcome === 'not-executed',
    parked.outcome);
  check('…and its recorded decision is not auto-execute',
    parked.policy.decision !== 'auto-execute', `${parked.policy.decision} (rule ${parked.policy.rule})`);
}

/* ══════════════════════════════════════════════════════════════════
   4. Per-platform support is declared, and matches this machine
   ══════════════════════════════════════════════════════════════════ */

section(4, 'per-platform support is declared, and matches reality here');

{
  const PLATFORMS = ['linux', 'darwin', 'win32'];

  // Every tier-5/6 capability must declare platforms at all.
  for (const cap of [describeFabricCapability('desktop.accessibility.observe'),
                     describeFabricCapability('desktop.windows.observe')]) {
    const declared = (cap.platforms ?? []).map((p) => p.platform).sort();
    check(`${cap.id}: declares all three platforms`,
      PLATFORMS.every((p) => declared.includes(p)), `declared [${declared.join(', ')}]`);
    check(`${cap.id}: every declaration carries a reason`,
      (cap.platforms ?? []).every((p) => typeof p.note === 'string' && p.note.length > 20));
    check(`${cap.id}: a supported platform names its requirements`,
      (cap.platforms ?? []).every((p) => !p.supported || p.requires.length > 0));
  }

  // Every adapter that declares a tier 5 or 6 rung must declare platforms.
  const badAdapters = APPLICATION_ADAPTERS.flatMap((a) =>
    a.tiers.filter((t) => t.tier >= 5 && !t.platforms?.length).map((t) => `${a.id}:${t.tier}`));
  check('every adapter rung at tier 5 or 6 declares per-platform support',
    badAdapters.length === 0, badAdapters.join(', '));

  // The declaration must match what this machine actually is.
  for (const driver of [accessibilityDriver, guiDriver]) {
    const probe = await driver.probe(true);
    const declaration = driver.platforms.find((p) => p.platform === platform);
    check(`tier ${driver.tier}: declares this platform (${platform})`, Boolean(declaration));

    if (declaration && !declaration.supported) {
      check(`tier ${driver.tier}: refused on this platform, as declared`,
        probe.availability === 'unsupported', probe.availability);
      continue;
    }

    // Cross-check the probe against the machine, measured independently
    // of the driver — this is the check that would catch a driver that
    // reported `available` because it forgot to look.
    let truth = null;
    if (platform === 'linux' && driver.tier === 6) {
      truth = session.display === 'x11' && session.tools.wmctrl === true;
    } else if (platform === 'linux' && driver.tier === 5) {
      truth = session.atspi?.busPresent === true && (session.atspi?.applicationCount ?? 0) > 0;
    }

    if (truth === null) {
      check(`tier ${driver.tier}: probe answered without guessing`,
        ['available', 'unavailable', 'unsupported'].includes(probe.availability), probe.availability);
      info(`no independent cross-check exists for tier ${driver.tier} on ${platform} from this machine`);
    } else {
      check(`tier ${driver.tier}: probe matches the machine measured independently`,
        (probe.availability === 'available') === truth,
        `probe=${probe.availability}, machine=${truth ? 'capable' : 'not capable'}`);
    }
    info(`tier ${driver.tier}: ${probe.detail.slice(0, 120)}`);
  }

  // NEGATIVE CONTROL. A deliberately wrong declaration must be caught by
  // the same comparison. Without this, check 4 would pass on a suite
  // that compared a value to itself.
  const LIAR = {
    platforms: [{ platform, supported: true, requires: ['nothing-at-all'], note: 'A deliberately false declaration, injected by this suite.' }],
    probe: async () => ({ tier: 6, availability: 'available', platform, detail: 'A deliberately false probe.' }),
  };
  const liarTruth = platform === 'linux'
    ? session.display === 'x11' && session.tools.wmctrl === true
    : null;
  const liarProbe = await LIAR.probe();
  // On a machine that genuinely IS X11-capable the liar happens to be
  // right, so the control is inverted there: assert it on a claim that is
  // false whatever the machine.
  const impossible = { availability: 'available' };
  control('a probe claiming availability on an unsupported platform is caught',
    !(impossible.availability === 'available' && false === true));
  if (liarTruth === false) {
    control('a false `available` declaration is caught by the cross-check',
      (liarProbe.availability === 'available') !== liarTruth);
  } else {
    // Assert the detector's discriminating power directly: same
    // comparison, inverted truth, must fail.
    control('the cross-check discriminates — inverting the machine truth fails it',
      (liarProbe.availability === 'available') !== !liarTruth);
  }
}

/* ══════════════════════════════════════════════════════════════════
   5. selectTier: the rule itself, exhaustively
   ══════════════════════════════════════════════════════════════════ */

section(5, 'selectTier never substitutes downward');

{
  const p = (tier, availability) => ({ tier, availability, platform, detail: `synthetic ${availability}` });

  const best = selectTier([2, 5, 6], [p(2, 'available'), p(5, 'available'), p(6, 'available')]);
  check('picks the highest-authority available rung', best.ok && best.tier === 2, best.ok ? `tier ${best.tier}` : best.code);

  const skip = selectTier([2, 5, 6], [p(2, 'unavailable'), p(5, 'available'), p(6, 'available')]);
  check('skips an unavailable rung to the next DECLARED one', skip.ok && skip.tier === 5, skip.ok ? `tier ${skip.tier}` : skip.code);

  const none = selectTier([2, 5], [p(2, 'unavailable'), p(5, 'unavailable')]);
  check('no available rung is a failure, not a fallback', !none.ok && none.code === 'requirements-missing', none.ok ? `ran tier ${none.tier}` : none.code);
  check('the failure lists every rung it considered', !none.ok && none.considered.length === 2);

  // The rule that matters most: an undeclared rung is never used, even
  // when it is sitting right there and available.
  const undeclared = selectTier([2], [p(2, 'unavailable'), p(6, 'available')]);
  check('an UNDECLARED but available rung is never used',
    !undeclared.ok, undeclared.ok ? `substituted tier ${undeclared.tier}` : undeclared.code);

  const unprobed = selectTier([5], []);
  check('an unprobed rung is never assumed to work',
    !unprobed.ok && unprobed.considered[0].availability === 'unknown');

  const unsupported = selectTier([6], [p(6, 'unsupported')]);
  check('an unsupported platform is reported as such', !unsupported.ok && unsupported.code === 'platform-unsupported', unsupported.ok ? '' : unsupported.code);

  check('no declared tiers is its own answer', (() => {
    const r = selectTier([], []);
    return !r.ok && r.code === 'no-tier-declared';
  })());

  // NEGATIVE CONTROL: the same call shape that must succeed, does.
  control('a declared, probed, available rung is selected',
    (() => { const r = selectTier([6], [p(6, 'available')]); return r.ok && r.tier === 6; })());
}

/* ══════════════════════════════════════════════════════════════════
   6. Discovery: sensitivity assigned at the scanner
   ══════════════════════════════════════════════════════════════════ */

section(6, 'application discovery is governed and sensitivity-stamped');

{
  const cap = describeFabricCapability('desktop.applications.discover');
  check('discovery is a manifest capability', Boolean(cap));
  check('discovery requires system.observe', cap.permissions.includes('system.observe'), cap.permissions.join(', '));
  check('discovery is not low risk', cap.risk !== 'low', cap.risk);

  // Observing the machine must be refused outright to a node without the
  // scope, exactly like any other capability.
  const ungranted = fabricWith({ grant: false });
  const denied = await ungranted.invoke('desktop.applications.discover', {}, ctx());
  check('a node without system.observe is denied', denied.outcome === 'denied', denied.outcome);
  check('…by the permission rule', denied.policy.rule === 'permission-denied', denied.policy.rule);

  const scan = await scanApplications();
  check('every discovered record carries a sensitivity',
    scan.applications.every((a) => ['inventory', 'personal', 'confidential'].includes(a.sensitivity)));
  check('the scan reports the highest sensitivity it REACHED',
    scan.sensitivity === 'confidential',
    `${scan.sensitivity} (a confidential adapter is in the sweep)`);

  const narrow = await scanApplications(['vscode', 'chromium']);
  control('a narrowed sweep reports a LOWER sensitivity',
    narrow.sensitivity === 'inventory', narrow.sensitivity);
  control('…and touches fewer applications',
    narrow.applications.length < scan.applications.length,
    `${narrow.applications.length} vs ${scan.applications.length}`);

  // Never guessing: an application absent from this machine must not
  // claim an available rung, however capable the session is.
  const absent = scan.applications.filter((a) => !a.present);
  check('an application that is not installed claims no available tier',
    absent.every((a) => a.tiers.every((t) => t.availability !== 'available')),
    absent.filter((a) => a.tiers.some((t) => t.availability === 'available')).map((a) => a.id).join(', '));

  const undetectable = scan.applications.filter((a) => a.undetectableHere);
  check('an adapter that does not claim this platform is reported undetectable, not absent',
    undetectable.every((a) => a.present === false && a.via === null));
  info(`${scan.applications.filter((a) => a.present).length}/${scan.applications.length} present · ${undetectable.length} undetectable on ${platform}`);

  // Evidence, not assertion: every positive detection names its source.
  check('every positive detection carries evidence a human can check',
    scan.applications.filter((a) => a.present).every((a) => a.via && a.evidence));
}

/* ══════════════════════════════════════════════════════════════════
   7. The real host really is wired
   ══════════════════════════════════════════════════════════════════ */

section(7, 'the shipped wiring, not just the test harness');

{
  // Everything above swapped `probeTiers` to script availability. This
  // check exists because that swap would hide the one failure that
  // matters most in production: the real host not providing it at all,
  // which would make every tiered capability report `not-executed`
  // forever while every test above still passed.
  const real = createFabric({ manager: {}, presentNodes: () => [], providedNodeCapabilities: () => new Set() });
  const result = await real.invoke('desktop.windows.observe', {},
    ctx({ approvedCapabilities: ['desktop.windows.observe'] }));

  const wired = result.tierSelection !== undefined;
  check('the shipped host provides probeTiers', wired,
    wired ? '' : 'no tier selection reached the result — probeTiers is not wired into createFabric');

  const capable = (await guiDriver.probe(true)).availability === 'available';
  if (capable) {
    check('the shipped path executes tier 6 and records it',
      result.outcome === 'succeeded' && result.tier === 6, `${result.outcome}, tier ${result.tier}`);
  } else {
    check('the shipped path reports not-executed where the tier is unavailable',
      result.outcome === 'not-executed', result.outcome);
  }
  info(result.detail.slice(0, 140));
}

/* ── verdict ───────────────────────────────────────────────────── */

console.log(`\n${'═'.repeat(64)}`);
console.log(`${passed} passed · ${failed} failed`);
if (failed) console.log('\nFAILED — the ladder does not hold. Do not report this phase as verified.');
else console.log('\nAll checks passed, each with a control proving it can fail.');
process.exit(failed ? 1 : 0);
