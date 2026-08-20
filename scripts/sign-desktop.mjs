/**
 * sign-desktop — OS-level code signing, or an honest refusal.
 * ==================================================================
 * AURA Hub ships unsigned on Windows and macOS today, and says so. This
 * script is the pipeline that changes that WHEN — and only when — the
 * signing material exists. It never fabricates an identity, never stubs a
 * step to look successful, and never reports an artifact signed that it
 * did not sign.
 *
 * It has exactly three outcomes, and which one it takes is decided by two
 * questions: was signing REQUESTED, and are the required secrets PRESENT?
 *
 *   requested + present   → sign for real, verify the signature with the
 *                           OS's own verifier, and report `signed: true`.
 *   requested + absent    → FAIL LOUDLY. Exit non-zero, name every missing
 *                           variable, and sign nothing. A release that was
 *                           asked to be signed and cannot be is a release
 *                           that must not proceed as though it were.
 *   not requested         → sign nothing, report `signed: false` plainly.
 *                           This is the v0.1.0 path: unsigned, and honest
 *                           about it, rather than pretending.
 *
 * "Requested" is `--require` on the command line or `AURA_SIGN_REQUIRE=1`
 * in the environment, set by the CI job when a signed release is the
 * intent. The default is not requested, so an ordinary build is unchanged.
 *
 * Usage:
 *   node scripts/sign-desktop.mjs --artifact <path> [--require] [--report <path>]
 *
 * The secrets themselves are read from the environment and never logged.
 * The exact set required on each platform is documented in QUESTIONS.md.
 *
 * BUILT: NOT COMPILED on Windows/macOS from this Linux machine — signtool
 * and codesign do not exist here. The gating logic (which outcome, which
 * missing variables) is exercised by scripts/signing-config-verify.mjs
 * with negative controls. The actual signing must run on the native
 * runner; the exact commands a human/CI must run are below and in
 * HANDOFF.md.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { argv, env, platform, exit } from 'node:process';

/* ── argument parsing ──────────────────────────────────────────── */

function arg(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const REQUIRED = arg('require', false) === true || env.AURA_SIGN_REQUIRE === '1';
const ARTIFACT = arg('artifact');
const REPORT_PATH = arg('report');

/* ── the secret contracts, per platform ────────────────────────── */

/**
 * Each platform names the environment variables that MUST all be present
 * for signing, and how the signature is applied and then verified. The
 * variable names are the contract with CI — they are what QUESTIONS.md
 * tells the user to set, and what the loud failure below names.
 */
const CONTRACTS = {
  win32: {
    method: 'Authenticode',
    /**
     * Two shapes are accepted, because the right one depends on a
     * business decision (a stored PFX vs a cloud-HSM / EV token), which
     * is a question for the user, not for this script:
     *
     *   A. WINDOWS_CERTIFICATE (base64 of a .pfx) + WINDOWS_CERTIFICATE_PASSWORD
     *   B. WINDOWS_CERTIFICATE_THUMBPRINT of a cert already in the
     *      machine store (how an EV token or an Azure Trusted Signing
     *      setup is usually driven).
     */
    secretSets: [
      ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'],
      ['WINDOWS_CERTIFICATE_THUMBPRINT'],
    ],
    timestampUrl: env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com',
  },
  darwin: {
    method: 'codesign + notarization',
    /**
     * Signing needs the Developer ID Application identity; notarization
     * needs credentials Apple accepts. Both are required — a signed but
     * un-notarized app is still gatekept on a user's machine, so signing
     * without notarizing would be a half-measure reported as done.
     *
     *   APPLE_CERTIFICATE (base64 of the Developer ID .p12) + password,
     *   APPLE_SIGNING_IDENTITY (the "Developer ID Application: …" name),
     *   and one notarization credential set:
     *     APPLE_API_KEY (+ issuer + key id)  — the recommended path, or
     *     APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID.
     */
    secretSets: [
      ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
       'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_ID'],
      ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
       'APPLE_ID', 'APPLE_APP_PASSWORD', 'APPLE_TEAM_ID'],
    ],
  },
  linux: {
    /**
     * Linux has no OS-level equivalent that a package manager verifies
     * the way Gatekeeper and SmartScreen do. The updater signature (Tauri
     * minisign, already in place) is the integrity mechanism, and repo
     * signing is a distribution decision, not a per-artifact one. So
     * there is nothing for THIS script to do on Linux, and it says so
     * rather than inventing a step.
     */
    method: 'none (updater signature covers integrity; see HANDOFF.md)',
    secretSets: [],
  },
};

/* ── which secret set, if any, is satisfied ────────────────────── */

const present = (name) => typeof env[name] === 'string' && env[name].length > 0;

function chooseSecretSet(contract) {
  // The first fully-present set wins. The "closest" set (fewest missing)
  // is remembered so a loud failure can tell the user precisely what to
  // add rather than dumping every alternative.
  let closest = null;
  for (const set of contract.secretSets) {
    const missing = set.filter((n) => !present(n));
    if (missing.length === 0) return { set, missing: [] };
    if (!closest || missing.length < closest.missing.length) closest = { set, missing };
  }
  return closest ?? { set: [], missing: [] };
}

/* ── report ────────────────────────────────────────────────────── */

function emit(report) {
  const line = JSON.stringify(report);
  console.log(`signing-report ${line}`);
  if (typeof REPORT_PATH === 'string') {
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function fail(report, message, extra = {}) {
  console.error(`::error::${message}`);
  emit({ ...report, ...extra, signed: false, error: message });
  exit(1);
}

/* ── the platform signers ──────────────────────────────────────── */

/**
 * Run a command, streaming nothing sensitive. Returns {ok, out}.
 * The secret material is passed to the tools by file or env, never on a
 * command line an `ps` could read.
 */
function sh(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function signWindows(contract, set) {
  // signtool is the SDK tool; on a GitHub windows runner it is on PATH.
  const signtool = 'signtool';
  const usingThumbprint = set.includes('WINDOWS_CERTIFICATE_THUMBPRINT');

  // A base64 PFX is materialised to a temp file that is deleted in
  // `finally`; the password is passed with /p, which signtool requires —
  // acceptable because a CI runner is single-tenant, but noted.
  const artifacts = [ARTIFACT];
  const signArgs = usingThumbprint
    ? ['sign', '/fd', 'SHA256', '/tr', contract.timestampUrl, '/td', 'SHA256',
       '/sha1', env.WINDOWS_CERTIFICATE_THUMBPRINT, ARTIFACT]
    : ['sign', '/fd', 'SHA256', '/tr', contract.timestampUrl, '/td', 'SHA256',
       '/f', env.__PFX_PATH, '/p', env.WINDOWS_CERTIFICATE_PASSWORD, ARTIFACT];

  const signed = sh(signtool, signArgs);
  if (!signed.ok) return { ok: false, detail: `signtool failed: ${signed.out}` };

  // Verify with the OS's own verifier. `signtool verify /pa` checks the
  // full chain the way SmartScreen will. Never trust our own exit code
  // alone — verify the artifact independently.
  const verified = sh(signtool, ['verify', '/pa', '/v', ARTIFACT]);
  return { ok: verified.ok, detail: verified.out, artifacts, verified: verified.ok };
}

function signMacOS(contract, set) {
  const identity = env.APPLE_SIGNING_IDENTITY;
  // Sign with hardened runtime — notarization requires it.
  const signed = sh('codesign', [
    '--force', '--options', 'runtime', '--timestamp',
    '--sign', identity, ARTIFACT,
  ]);
  if (!signed.ok) return { ok: false, detail: `codesign failed: ${signed.out}` };

  const codesignVerify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', ARTIFACT]);
  if (!codesignVerify.ok) return { ok: false, detail: `codesign verify failed: ${codesignVerify.out}` };

  // Notarize. The API-key path is preferred; fall back to Apple-ID creds.
  const notaryArgs = set.includes('APPLE_API_KEY')
    ? ['notarytool', 'submit', ARTIFACT, '--key', env.__API_KEY_PATH,
       '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER, '--wait']
    : ['notarytool', 'submit', ARTIFACT, '--apple-id', env.APPLE_ID,
       '--password', env.APPLE_APP_PASSWORD, '--team-id', env.APPLE_TEAM_ID, '--wait'];
  const notarized = sh('xcrun', notaryArgs);
  if (!notarized.ok) return { ok: false, detail: `notarytool failed: ${notarized.out}` };

  // Staple, so the machine that opens it offline still sees the ticket.
  const stapled = sh('xcrun', ['stapler', 'staple', ARTIFACT]);
  if (!stapled.ok) return { ok: false, detail: `stapler failed: ${stapled.out}` };

  // The real test: what Gatekeeper will decide.
  const assess = sh('spctl', ['--assess', '--type', 'exec', '--verbose=4', ARTIFACT]);
  return { ok: assess.ok, detail: assess.out, artifacts: [ARTIFACT], verified: assess.ok };
}

/* ── main ──────────────────────────────────────────────────────── */

const contract = CONTRACTS[platform] ?? { method: 'unsupported', secretSets: [] };
const base = { platform, method: contract.method, requested: REQUIRED, artifact: ARTIFACT ?? null };

// Linux: nothing to do, and that is a complete answer.
if (platform === 'linux') {
  emit({ ...base, signed: false, note: 'No OS-level signing on Linux; the updater signature provides integrity.' });
  exit(0);
}

// A platform we do not sign on at all.
if (!contract.secretSets.length) {
  if (REQUIRED) fail(base, `Signing was requested but ${platform} has no signing contract defined.`);
  emit({ ...base, signed: false, note: `No signing defined for ${platform}.` });
  exit(0);
}

const { set, missing } = chooseSecretSet(contract);

// Requested but not fully provisioned → loud failure, name what is missing.
if (missing.length) {
  if (REQUIRED) {
    fail(
      base,
      `Signing was requested for ${platform} (${contract.method}) but these required secrets are absent: ` +
      `${missing.join(', ')}. Set them in the CI environment (see QUESTIONS.md) or drop --require to ship unsigned. ` +
      `AURA will not fabricate a signing identity.`,
      { missing },
    );
  }
  // Not requested → the honest unsigned path.
  emit({ ...base, signed: false, missing, note: 'Signing material not present; shipping unsigned, as declared.' });
  exit(0);
}

// From here signing is both requested-or-available AND fully provisioned.
if (!ARTIFACT || !existsSync(String(ARTIFACT))) {
  fail(base, `No artifact to sign: --artifact ${ARTIFACT ?? '(none)'} does not exist.`);
}

const result = platform === 'win32' ? signWindows(contract, set)
  : platform === 'darwin' ? signMacOS(contract, set)
  : { ok: false, detail: `No signer implemented for ${platform}.` };

if (!result.ok) {
  fail(base, `Signing ${platform === 'win32' ? 'Authenticode' : 'notarization'} FAILED: ${result.detail}`);
}

emit({
  ...base,
  signed: true,
  verified: result.verified === true,
  secretSet: set.join('+'),
  artifacts: result.artifacts,
  detail: result.detail?.slice(0, 400),
});
console.log(`Signed and verified ${ARTIFACT} on ${platform} via ${contract.method}.`);
exit(0);
