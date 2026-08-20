/**
 * tool-schema-verify — the manifest really is the only source of truth.
 * ==================================================================
 *   node scripts/tool-schema-verify.mjs
 *
 * What this proves, and why each claim needed proving:
 *
 *   A  Every capability in CAPABILITY_MANIFEST yields a JSON schema that
 *      is structurally valid — the whole point of deriving rather than
 *      hand-writing is that "all of them" is checkable.
 *   B  Names round-trip exactly, and ONLY exactly. A model-emitted name
 *      is a lookup key; if any string manipulation could turn an
 *      arbitrary name into a capability, the manifest would stop being
 *      the boundary.
 *   C  Enums are enforced, not advertised. A schema that says GET|POST
 *      while the Fabric accepts FETCH is worse than no schema, because
 *      it is believed.
 *   D  Result shapes exist for every capability and carry the six
 *      outcomes without collapsing any of them.
 *
 * NEGATIVE CONTROLS. Every check above is re-run against a deliberately
 * broken input, and the suite fails if the detector does not notice.
 * A checker that cannot fail proves nothing, and it is the normal way a
 * verification suite rots into decoration.
 */

import { register } from 'node:module';
import assert from 'node:assert';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const {
  CAPABILITY_MANIFEST,
  describeFabricCapability,
  capabilityForToolName,
  toolNameForCapability,
  capabilityInputSchema,
  capabilityResultSchema,
  toolSpecFor,
  toolSpecsFor,
  allToolSpecs,
  CapabilityFabric,
} = await import('@aura/capability-fabric');

let passed = 0;
let failed = 0;

const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

/* ══════════════════════════════════════════════════════════════════
   The validator, used on real input AND on deliberately broken input
   ══════════════════════════════════════════════════════════════════ */

const JSON_SCALARS = new Set(['string', 'number', 'boolean', 'array', 'object']);

/**
 * Structural validation of a derived input schema.
 *
 * Returns a list of problems. Written to be reusable against a descriptor
 * this suite breaks on purpose — the negative controls call it with known
 * bad input and require a non-empty result.
 */
function validateInputSchema(capability, schema) {
  const problems = [];
  if (schema?.type !== 'object') problems.push('root type is not "object"');
  if (schema?.additionalProperties !== false) {
    problems.push('additionalProperties is not false — undeclared arguments would be silently accepted');
  }
  const properties = schema?.properties ?? {};
  if (typeof properties !== 'object') problems.push('properties is not an object');

  const declared = new Set((capability.input ?? []).map((f) => f.name));
  for (const name of Object.keys(properties)) {
    if (!declared.has(name)) problems.push(`schema advertises "${name}", which the capability does not declare`);
  }
  for (const field of capability.input ?? []) {
    const property = properties[field.name];
    if (!property) { problems.push(`field "${field.name}" is missing from the schema`); continue; }
    if (!JSON_SCALARS.has(property.type)) problems.push(`field "${field.name}" has non-JSON type "${property.type}"`);
    if (property.type === 'array' && !property.items) problems.push(`field "${field.name}" is an array with no items schema`);
    if (typeof property.description !== 'string' || !property.description) {
      problems.push(`field "${field.name}" has no description`);
    }
    if (field.enum) {
      if (!Array.isArray(property.enum)) problems.push(`field "${field.name}" declares an enum the schema does not carry`);
      else if (property.enum.length !== field.enum.length) problems.push(`field "${field.name}" enum lost values`);
    }
  }

  const required = schema?.required ?? [];
  if (!Array.isArray(required)) problems.push('required is not an array');
  else {
    for (const name of required) {
      if (!properties[name]) problems.push(`required names "${name}", which is not a property`);
      const field = (capability.input ?? []).find((f) => f.name === name);
      if (!field?.required) problems.push(`required names "${name}", which the capability declares optional`);
    }
    for (const field of capability.input ?? []) {
      if (field.required && !required.includes(field.name)) {
        problems.push(`field "${field.name}" is required but absent from required[]`);
      }
    }
  }
  return problems;
}

/** Structural validation of a derived tool definition. */
function validateToolSpec(spec) {
  const problems = [];
  if (typeof spec.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name)) {
    problems.push(`name "${spec.name}" is not accepted by mainstream tool APIs`);
  }
  if (typeof spec.description !== 'string' || spec.description.length < 10) {
    problems.push('description is missing or too short to be useful');
  }
  if (!spec.parameters || typeof spec.parameters !== 'object') problems.push('parameters is not an object');
  return problems;
}

const SIX_OUTCOMES = ['success', 'failure', 'partial', 'unknown', 'not-executed', 'requires-approval'];

function validateResultSchema(capability, schema) {
  const problems = [];
  const outcome = schema?.properties?.outcome;
  if (!outcome) problems.push('result schema has no outcome');
  else {
    const values = outcome.enum ?? [];
    for (const expected of SIX_OUTCOMES) {
      if (!values.includes(expected)) problems.push(`outcome enum is missing "${expected}"`);
    }
    if (values.length !== SIX_OUTCOMES.length) {
      problems.push(`outcome enum has ${values.length} values, not the six that must stay distinct`);
    }
  }
  if (!schema?.properties?.detail) problems.push('result schema has no detail');
  if (!schema?.properties?.verified) problems.push('result schema has no verified');
  if (!capability.result) problems.push('capability declares no output shape');
  else if (!schema?.properties?.output) problems.push('declared an output shape that the schema does not carry');
  return problems;
}

/* ══════════════════════════════════════════════════════════════════
   A. every capability yields a valid schema
   ══════════════════════════════════════════════════════════════════ */

section('A. schema derivation');

check('A0. the manifest is non-trivial', CAPABILITY_MANIFEST.length >= 30, `${CAPABILITY_MANIFEST.length} capabilities`);

{
  const broken = [];
  for (const capability of CAPABILITY_MANIFEST) {
    const problems = validateInputSchema(capability, capabilityInputSchema(capability));
    if (problems.length) broken.push(`${capability.id}: ${problems.join('; ')}`);
  }
  check(`A1. all ${CAPABILITY_MANIFEST.length} capabilities yield a valid input schema`,
    broken.length === 0, broken.slice(0, 3).join(' | '));
}

{
  const broken = [];
  for (const spec of allToolSpecs()) {
    const problems = validateToolSpec(spec);
    if (problems.length) broken.push(`${spec.name}: ${problems.join('; ')}`);
  }
  check('A2. all capabilities yield a provider-acceptable tool definition',
    broken.length === 0, broken.slice(0, 3).join(' | '));
}

{
  const broken = [];
  for (const capability of CAPABILITY_MANIFEST) {
    const problems = validateResultSchema(capability, capabilityResultSchema(capability));
    if (problems.length) broken.push(`${capability.id}: ${problems.join('; ')}`);
  }
  check('A3. every capability declares an output shape, and the six outcomes stay six',
    broken.length === 0, broken.slice(0, 3).join(' | '));
}

check('A4. the risk level reaches the model in the description, from the descriptor',
  CAPABILITY_MANIFEST.every((c) => toolSpecFor(c).description.includes(`Risk: ${c.risk}`)));

check('A5. an irreversible capability says so where a planner will read it',
  CAPABILITY_MANIFEST.filter((c) => c.irreversible)
    .every((c) => /IRREVERSIBLE/.test(toolSpecFor(c).description)),
  `${CAPABILITY_MANIFEST.filter((c) => c.irreversible).length} irreversible capabilities`);

/* ── NEGATIVE CONTROLS for A ─────────────────────────────────────── */

section('A′. negative controls — the schema checker can fail');

{
  // A descriptor whose `required` names a field it does not declare.
  const bad = { ...CAPABILITY_MANIFEST[1], input: [{ name: 'name', type: 'string', required: true, description: 'x' }] };
  const schemaMissingRequired = { type: 'object', properties: { name: { type: 'string', description: 'x' } }, required: [], additionalProperties: false };
  check('A′1. a schema that drops a required field is DETECTED',
    validateInputSchema(bad, schemaMissingRequired).length > 0);
}
{
  const bad = { ...CAPABILITY_MANIFEST[1], input: [{ name: 'p', type: 'string', required: false, description: 'x' }] };
  const schemaOpen = { type: 'object', properties: { p: { type: 'string', description: 'x' } }, required: [] };
  check('A′2. a schema without additionalProperties:false is DETECTED',
    validateInputSchema(bad, schemaOpen).some((p) => /additionalProperties/.test(p)));
}
{
  const bad = { ...CAPABILITY_MANIFEST[1], input: [{ name: 'm', type: 'string', required: true, description: 'x', enum: ['A', 'B'] }] };
  const schemaNoEnum = { type: 'object', properties: { m: { type: 'string', description: 'x' } }, required: ['m'], additionalProperties: false };
  check('A′3. a schema that loses an enum is DETECTED',
    validateInputSchema(bad, schemaNoEnum).some((p) => /enum/.test(p)));
}
{
  const collapsed = { type: 'object', properties: { outcome: { enum: ['success', 'failure'] }, detail: {}, verified: {}, output: {} } };
  check('A′4. a result schema that collapses the six outcomes is DETECTED',
    validateResultSchema(CAPABILITY_MANIFEST[0], collapsed).length > 0);
}
{
  check('A′5. a tool name a provider would reject is DETECTED',
    validateToolSpec({ name: 'filesystem.read', description: 'a'.repeat(20), parameters: {} }).length > 0);
}

/* ══════════════════════════════════════════════════════════════════
   B. names are lookup keys, never constructions
   ══════════════════════════════════════════════════════════════════ */

section('B. name resolution');

{
  const broken = [];
  for (const capability of CAPABILITY_MANIFEST) {
    const name = toolNameForCapability(capability.id);
    const back = name ? capabilityForToolName(name) : null;
    if (!name || back?.id !== capability.id) broken.push(capability.id);
  }
  check('B1. every capability round-trips id → tool name → the SAME capability',
    broken.length === 0, broken.slice(0, 3).join(', '));
}

{
  // Names a model plausibly emits. None of them is a capability, and none
  // of them may become one by any transformation.
  const hallucinated = [
    'search_web',
    'bash',
    'run_command',
    'filesystem__delete',
    'filesystem__read__admin',
    'admin__filesystem__read',
    'FILESYSTEM__READ',
    'filesystem.read',
    'filesystem__read ',
    ' filesystem__read',
    'filesystem__read\n',
    'filesystem__READ',
    '__proto__',
    'constructor',
    'toString',
    'git__push_force',
    'terminal__execute_as_root',
  ];
  const leaked = hallucinated.filter((n) => capabilityForToolName(n) !== null);
  check(`B2. ${hallucinated.length} hallucinated / adversarial names all resolve to nothing`,
    leaked.length === 0, leaked.join(', '));
}

check('B3. prototype keys cannot be reached through the lookup table',
  capabilityForToolName('__proto__') === null && capabilityForToolName('constructor') === null);

check('B4. an unknown id yields no tool name rather than a fabricated one',
  toolNameForCapability('not.a.capability') === null);

{
  const { tools, unknown } = toolSpecsFor(['filesystem.read', 'not.a.capability', 'git.status']);
  check('B5. an allowlist naming a dead capability narrows what is offered, and says so',
    tools.length === 2 && unknown.length === 1 && unknown[0] === 'not.a.capability');
}

section('B′. negative control — a naive decoder WOULD leak');

{
  // The thing this design refuses to do: rebuild an id by string surgery.
  // If `capabilityForToolName` did this, the adversarial names above would
  // partly resolve. Demonstrating that the naive version behaves
  // differently is what makes B2 meaningful rather than vacuous.
  const naive = (name) => describeFabricCapability(name.replace(/__/g, '.').trim().toLowerCase()) ?? null;
  const leakedByNaive = ['FILESYSTEM__READ', ' filesystem__read', 'filesystem__read\n']
    .filter((n) => naive(n) !== null);
  check('B′1. a naive decoder resolves names the real one refuses (so B2 is a real constraint)',
    leakedByNaive.length === 3, `naive leaked ${leakedByNaive.length}/3`);
  check('B′2. …and the real resolver refuses every one of them',
    leakedByNaive.every((n) => capabilityForToolName(n) === null));
}

/* ══════════════════════════════════════════════════════════════════
   C. enums are enforced by the Fabric, not merely advertised
   ══════════════════════════════════════════════════════════════════ */

section('C. enum enforcement, through the real Fabric');

const enumFields = CAPABILITY_MANIFEST.flatMap((c) => c.input.filter((f) => f.enum).map((f) => `${c.id}.${f.name}`));
check('C0. at least one manifest field declares a closed set', enumFields.length > 0, enumFields.join(', '));

{
  let ran = 0;
  const fabric = new CapabilityFabric({
    permissionsFor: () => ({ read: true, write: true, execute: true, autonomous: false }),
    nodeAvailable: () => true,
    resolveNode: () => ({ ok: true, node: { id: 'n', name: 'N', capabilities: ['http-client'] } }),
    requestApproval: async () => false,
  });
  fabric.setPolicy({
    byRisk: { low: 'auto-execute', medium: 'auto-execute', high: 'auto-execute' },
    overrides: {}, allowAutonomous: true,
  });
  fabric.register({
    capabilityId: 'http.request',
    supportsNode: () => true,
    run: async () => { ran += 1; return { ok: true, detail: 'stub', output: { status: 200, text: '' } }; },
  });

  const ctx = { actor: { kind: 'agent', id: 'schema-verify' }, projectId: null };

  const bad = await fabric.invoke('http.request', { url: 'https://example.com', method: 'FETCH' }, ctx);
  check('C1. a value outside the declared enum is REFUSED before execution',
    bad.outcome === 'failed' && bad.policy.rule === 'invalid-input' && ran === 0,
    `outcome=${bad.outcome} rule=${bad.policy.rule} ran=${ran}`);
  check('C2. the refusal names the allowed values, so it is actionable',
    /GET/.test(bad.detail) && /POST/.test(bad.detail), bad.detail);

  const good = await fabric.invoke('http.request', { url: 'https://example.com', method: 'POST' }, ctx);
  check('C3. NEGATIVE CONTROL — a value inside the enum reaches the executor',
    good.outcome === 'succeeded' && ran === 1, `outcome=${good.outcome} ran=${ran}`);

  const schema = capabilityInputSchema(describeFabricCapability('http.request'));
  check('C4. the schema advertises exactly what the Fabric enforces',
    JSON.stringify(schema.properties.method.enum)
      === JSON.stringify([...describeFabricCapability('http.request').input.find((f) => f.name === 'method').enum]));

  // An undeclared argument is not a capability escalation: the Fabric
  // iterates the DECLARED contract, so extra keys govern nothing.
  const smuggled = await fabric.invoke('http.request', {
    url: 'https://example.com', method: 'GET',
    risk: 'low', irreversible: false, permissions: [], __policy: 'auto-execute',
  }, ctx);
  check('C5. arguments the manifest does not declare cannot alter the decision',
    smuggled.policy.risk === 'medium' && smuggled.outcome === 'succeeded',
    `risk=${smuggled.policy.risk}`);
}

/* ══════════════════════════════════════════════════════════════════
   D. the generator is the only place this happens
   ══════════════════════════════════════════════════════════════════ */

section('D. single source of truth');

{
  // Two independent derivations of the same capability must be identical.
  // If a second generator ever appears, this is the check that catches the
  // day the two disagree.
  const a = JSON.stringify(allToolSpecs());
  const b = JSON.stringify(CAPABILITY_MANIFEST.map(toolSpecFor));
  check('D1. bulk and single derivation produce byte-identical definitions', a === b);
}

check('D2. a capability with no arguments still yields a well-formed schema',
  (() => {
    const noArgs = CAPABILITY_MANIFEST.filter((c) => c.input.length === 0);
    if (noArgs.length === 0) return false;
    return noArgs.every((c) => {
      const s = capabilityInputSchema(c);
      return s.type === 'object' && Object.keys(s.properties).length === 0 && s.required.length === 0;
    });
  })(),
  `${CAPABILITY_MANIFEST.filter((c) => c.input.length === 0).length} capabilities take no arguments`);

/* ══════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
