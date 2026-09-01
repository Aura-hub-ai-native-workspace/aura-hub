/**
 * prompt-redaction-verify — one redaction authority, both prompt paths.
 * ==================================================================
 * AURA builds a prompt in two places, and until now only one of them
 * filtered credentials:
 *
 *   context/promptContract.ts        agent prompt   redact() in block()
 *   intelligence/contextAssembler.ts chat  prompt   NOTHING
 *
 * The chat composer is fed raw source excerpts and raw recalled memory,
 * so a credential committed to a repository file was retrieved, assembled
 * and sent verbatim to a third-party provider. That is an exfiltration
 * path, not a design gap, and closing it by copying the patterns into the
 * second composer would have produced two authorities that drift apart.
 * They now share one: packages/ai-service/src/context/redact.ts.
 *
 * What this suite proves, in order:
 *   [A] there is exactly ONE definition of the patterns in the tree
 *   [B] every credential SHAPE is redacted, and lookalikes are not
 *   [C] the name=value rule reads the VALUE, so source code survives
 *   [D] the chat path does not leak — end to end through the composer
 *   [E] the agent path still does not leak, through the same authority
 *   [F] the user's own words are deliberately NOT filtered
 *
 * Every section carries a NEGATIVE CONTROL. Where a control is a build of
 * the same module with redaction removed, the leak is demonstrated rather
 * than assumed — a check that cannot fail proves nothing.
 *
 * Usage: node scripts/prompt-redaction-verify.mjs
 * Needs no service, no provider, no network.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'packages/ai-service/src');
const out = mkdtempSync(path.join(tmpdir(), 'redaction-verify-'));

let failed = false;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

/** Bundle a TypeScript entry to ESM and import it. */
async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  execFileSync('npx', [
    'esbuild', entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${file}`,
  ], { cwd: ROOT, stdio: 'pipe' });
  return import(file);
}

/**
 * Copy the source tree into a scratch directory, apply an edit, and bundle
 * from there. This is how a negative control is built: the SAME composer,
 * with the redaction call removed, must leak what the real one holds.
 */
async function loadPatched(name, relPath, patch) {
  const dir = path.join(out, `patched-${name}`);
  fs.cpSync(SRC, path.join(dir, 'src'), { recursive: true });
  const target = path.join(dir, 'src', relPath);
  const before = fs.readFileSync(target, 'utf8');
  const after = patch(before);
  if (after === before) throw new Error(`patch for ${name} changed nothing — control is invalid`);
  writeFileSync(target, after);
  return load(target, name);
}

const { redact, redactWithCount, REDACTION_MARKER } =
  await load(path.join(SRC, 'context/redact.ts'), 'redact');

/* ══ [A] ONE AUTHORITY ═══════════════════════════════════════════════
   The invariant this repo states as "do not duplicate an authority",
   applied to redaction. A second copy of the patterns is the failure
   mode that produced the leak in the first place. */
{
  // -co --exclude-standard: tracked AND new-but-not-ignored, so a freshly
  // added second copy is caught before it is ever committed.
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'packages', 'apps'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));

  const definers = files.filter(f => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /\bfunction redact\s*\(/.test(s) || /SECRET_SHAPE_PATTERNS\s*:/.test(s);
  });

  check('A1. exactly one module defines the redaction patterns',
    definers.length === 1 && definers[0] === 'packages/ai-service/src/context/redact.ts',
    definers.join(', ') || 'none found');

  const importers = files.filter(f =>
    /from '\.{1,2}\/(?:context\/)?redact'/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('A2. both composers import it rather than reimplementing it',
    importers.includes('packages/ai-service/src/context/promptContract.ts') &&
    importers.includes('packages/ai-service/src/intelligence/contextAssembler.ts'),
    importers.join(', '));

  // NEGATIVE CONTROL: the detector in A1 must be able to find a duplicate.
  const decoy = path.join(out, 'decoy.ts');
  writeFileSync(decoy, 'function redact(t: string) { return t; }\n');
  const decoyFound = /\bfunction redact\s*\(/.test(fs.readFileSync(decoy, 'utf8'));
  check('A3. NEGATIVE CONTROL — the duplicate detector fires on a planted copy', decoyFound);
}

/* ══ [B] SHAPES ══════════════════════════════════════════════════════
   Formats that are a credential and essentially nothing else. */
{
  const SHAPES = [
    ['OpenAI-style key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub token', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456'],
    ['Slack token', 'xoxb-123456789012-abcdefghijkl'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    ['PEM private key header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['Bearer header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ];
  for (const [label, sample] of SHAPES) {
    const r = redact(`the log line said ${sample} and then stopped`);
    check(`B1. ${label} is redacted`, !r.includes(sample), r.includes(sample) ? 'LEAKED' : 'redacted');
  }

  check('B2. redaction leaves a visible marker rather than deleting silently',
    redact('key sk-abcdefghijklmnopqrstuvwxyz012345 here').includes(REDACTION_MARKER));

  check('B3. surrounding text survives',
    redact('key sk-abcdefghijklmnopqrstuvwxyz012345 here').startsWith('key ') &&
    redact('key sk-abcdefghijklmnopqrstuvwxyz012345 here').endsWith(' here'));

  // NEGATIVE CONTROL: lookalikes of similar length must NOT be redacted,
  // or "nothing leaked" would only mean "everything was destroyed".
  const LOOKALIKES = [
    'sk-1234',                                   // too short for the key shape
    'AKIALOWERCASEISNOTAKEY'.toLowerCase(),      // wrong case
    'the-quick-brown-fox-jumped-over-the-dog',   // ordinary hyphenated prose
    'eyJustSomeCamelCase',                       // starts like a JWT, is not one
  ];
  for (const s of LOOKALIKES) {
    check(`B4. NEGATIVE CONTROL — "${s.slice(0, 28)}" is left alone`,
      redact(`value ${s} end`).includes(s));
  }

  check('B5. the count is reported, not guessed',
    redactWithCount('a sk-abcdefghijklmnopqrstuvwxyz012345 b AKIAIOSFODNN7EXAMPLE c').count === 2);
}

/* ══ [C] THE NAME=VALUE RULE READS THE VALUE ═════════════════════════
   The chat path's retrieved material IS source code. A rule that
   redacts everything after `password:` deletes type declarations and
   environment lookups — the model is then asked to explain code it can
   no longer see, and nothing was protected, because none of those are
   credentials. */
{
  const REAL = [
    ['quoted literal', 'const apiKey = "A1b2C3d4E5f6G7h8";', 'A1b2C3d4E5f6G7h8'],
    ['env file line', 'DATABASE_PASSWORD=hunter2correcthorse', 'hunter2correcthorse'],
    ['yaml value', 'client_secret: 9f8e7d6c5b4a39281706', '9f8e7d6c5b4a39281706'],
    ['json value', '"token": "ya29.a0AfH6SMBx7Qk"', 'ya29.a0AfH6SMBx7Qk'],
  ];
  for (const [label, line, secret] of REAL) {
    const r = redact(line);
    check(`C1. ${label} — the value is redacted`, !r.includes(secret),
      r.includes(secret) ? `LEAKED: ${r}` : r);
  }

  const CODE = [
    ['a type declaration', 'interface Login { password: string; token: string }'],
    ['an environment lookup', 'const apiKey = process.env.OPENAI_API_KEY;'],
    ['a config reference', 'const secret = config.auth.clientSecret;'],
    ['a function call', 'const token = readTokenFromKeychain();'],
    ['a python env read', 'password = os.environ["DB_PASSWORD"]'],
    ['a nullable default', 'let token = null;'],
  ];
  for (const [label, line] of CODE) {
    const r = redact(line);
    check(`C2. ${label} survives intact`, r === line, r === line ? 'unchanged' : `MANGLED: ${r}`);
  }

  /* NEGATIVE CONTROL: the rule this replaced. Running the old pattern over
     the same lines shows the C2 checks are testing a real behaviour change
     and would have failed before it. */
  const OLD_RULE = /\b(?:api[_-]?key|apikey|secret|password|passwd|token|bearer)\s*[:=]\s*\S+/gi;
  const mangledByOldRule = CODE.filter(([, line]) => {
    OLD_RULE.lastIndex = 0;
    return line.replace(OLD_RULE, REDACTION_MARKER) !== line;
  });
  check('C3. NEGATIVE CONTROL — the previous rule destroyed these same lines',
    mangledByOldRule.length === CODE.length,
    `${mangledByOldRule.length}/${CODE.length} would have been mangled`);

  check('C4. the key is kept so the excerpt keeps its shape',
    redact('const apiKey = "A1b2C3d4E5f6G7h8";').includes('apiKey') &&
    redact('const apiKey = "A1b2C3d4E5f6G7h8";').includes(REDACTION_MARKER));
}

/* ══ [D] THE CHAT PATH, END TO END ═══════════════════════════════════ */
const SECRET = 'sk-liveKeyDoNotShipThis0123456789';
const NAMED = 'db_password=SuperSecretValue99';

function assemblerInput() {
  return {
    intent: { type: 'general_question', confidence: 1, entities: [] },
    // null: this section is about material AURA RETRIEVED, and the identity
    // block is composed from AURA's own structured facts, not from the repo.
    identity: null,
    summary: null, profile: null, glossary: null, health: null,
    prioritizedDocs: [],
    // The three fields that carry raw repository material into the prompt.
    codingContext: `src/config.ts:12\n  const key = "${SECRET}";\n  // ${NAMED}`,
    graphContext: `config.ts uses ${SECRET}`,
    memoryContext: `Recalled: the deploy key is ${SECRET}`,
    retrievedFiles: ['src/config.ts'],
  };
}

{
  const { assembleContext } = await load(path.join(SRC, 'intelligence/contextAssembler.ts'), 'assembler');
  const sent = assembleContext(assemblerInput()).systemMessages.map(m => m.content).join('\n');

  check('D1. a credential in a retrieved source excerpt does not reach the payload',
    !sent.includes(SECRET), sent.includes(SECRET) ? 'LEAKED' : 'redacted');
  check('D2. a credential in recalled memory does not reach the payload',
    !sent.includes('deploy key is ' + SECRET));
  check('D3. a named secret in the same excerpt does not reach the payload',
    !sent.includes('SuperSecretValue99'));
  check('D4. the rest of the excerpt still reaches the model',
    sent.includes('src/config.ts') && sent.includes('const key'),
    'redaction removed the credential, not the context');

  /* NEGATIVE CONTROL — the same composer with the redact() call removed.
     If this does not leak, D1–D3 are proving nothing. */
  const leaky = await loadPatched('assembler-leak', 'intelligence/contextAssembler.ts',
    s => s.replace("const fullContext = redact(parts.filter(Boolean).join('\\n\\n'));",
                   "const fullContext = parts.filter(Boolean).join('\\n\\n');"));
  const leaked = leaky.assembleContext(assemblerInput()).systemMessages.map(m => m.content).join('\n');
  check('D5. NEGATIVE CONTROL — without the choke point the same input leaks',
    leaked.includes(SECRET), leaked.includes(SECRET) ? 'leaked as expected' : 'CONTROL DID NOT LEAK');
}

/* ══ [E] THE AGENT PATH, THROUGH THE SAME AUTHORITY ══════════════════ */
{
  const { renderContextContract } = await load(path.join(SRC, 'context/promptContract.ts'), 'contract');
  const view = {
    contextVersion: 1, generatedAt: new Date().toISOString(),
    freshness: { state: 'fresh', generatedAt: new Date().toISOString(), reason: null, changedFiles: 0, addedFiles: 0, removedFiles: 0, truncated: false },
    project: { id: 'p', name: 'P', root: '/tmp/p', type: 'library', language: 'ts', mounted: true },
    repository: {
      purpose: `A project. ${SECRET}`, repositoryType: 'library', architectureStyle: 'layered',
      primaryLanguage: 'TypeScript', secondaryLanguages: [], frameworks: [], buildSystem: null,
      packageManager: 'npm', mainModules: [], entryPoints: [], fileCount: 1,
      modules: [{ name: 'm', path: 'src/m', description: `does things ${NAMED}` }],
      intelligence: 'ready',
    },
    git: { available: true, branch: 'main', dirty: false, changedFiles: 0,
      recentCommits: [{ hash: 'abc1234', subject: `fix: rotate ${SECRET}`, date: '2026-01-01' }], reason: null },
    environment: { os: 'Linux', platform: 'linux', arch: 'x64', nodeVersion: 'v22', shell: '/bin/bash', presentNodes: [], presentCount: 0, catalogueCount: 1, scannedAt: null },
    tools: { available: [], missing: [] },
    agents: { codingAgents: [], provider: { id: null, connected: false, model: null } },
    mission: { active: null, total: 0, pendingApprovals: 0 },
    activity: { events: [] }, constraints: [], buildMs: 1,
  };

  const rendered = renderContextContract(view);
  check('E1. the agent path still redacts after the extraction',
    !rendered.includes(SECRET) && !rendered.includes('SuperSecretValue99'),
    rendered.includes(SECRET) ? 'LEAKED' : 'redacted');
  check('E2. and its facts survive', rendered.includes('main'));

  const leaky = await loadPatched('contract-leak', 'context/promptContract.ts',
    s => s.replace("return `<${tag}>\\n${redact(body.join('\\n'))}\\n</${tag}>`;",
                   "return `<${tag}>\\n${body.join('\\n')}\\n</${tag}>`;"));
  check('E3. NEGATIVE CONTROL — without block()’s call the agent path leaks too',
    leaky.renderContextContract(view).includes(SECRET));
}

/* ══ [F] THE DELIBERATE BOUNDARY ═════════════════════════════════════
   AURA filters what it went and fetched. It does not filter what the
   user typed: someone pasting a key to ask what is wrong with it must
   still get an answer, and the conversation history is their own words
   coming back. This is a decision, so it is asserted rather than left
   to be rediscovered as a bug. */
{
  const pipeline = fs.readFileSync(path.join(SRC, 'pipeline.ts'), 'utf8');
  const fn = pipeline.slice(pipeline.indexOf('private buildContextMessages'),
                            pipeline.indexOf('/* ── generation'));
  check('F1. the user message and history are assembled without a filter',
    fn.includes("messages.push({ role: 'user', content: text })") && !fn.includes('redact('),
    'deliberate — see the comment at the chat choke point');

  const assembler = fs.readFileSync(path.join(SRC, 'intelligence/contextAssembler.ts'), 'utf8');
  check('F2. and the decision is written down where it was made',
    /user's own words|what it was told/.test(assembler));

}

console.log(failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
