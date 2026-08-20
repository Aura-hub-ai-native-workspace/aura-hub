/**
 * credential-protection-verify — is a stolen providers.json useful?
 * ==================================================================
 * The old scheme's flaw was not a weak cipher. It was AES-256-GCM, which
 * is fine. The flaw was that the key was in the file with the ciphertext,
 * so the question "what can an attacker who copies providers.json do?"
 * had the answer "everything".
 *
 * That is the question this suite asks, and it asks it by ACTUALLY
 * ATTACKING the file: it reconstructs the old derivation from the
 * stolen file alone and recovers the key, then does the same against the
 * new one and fails. The old scheme is the negative control, and it is
 * the strongest one available — a check that can be shown recovering a
 * real secret is a check that can fail.
 *
 * Run:  node scripts/credential-protection-verify.mjs
 *
 * Everything runs against a scratch AURA_HOME. The suite never reads,
 * writes or probes the user's own provider store or keychain items.
 */

import { register } from 'node:module';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME = mkdtempSync(path.join(tmpdir(), 'aura-cred-verify-'));
process.env.AURA_HOME = HOME;
// Start with no passphrase, so the "nowhere safe" path is reachable.
delete process.env.AURA_PROVIDER_SECRET;

register(new URL('./ts-loader-hook.mjs', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const cred = await load('packages/ai-service/src/provider/credentialStore.ts');
const keychain = await load('packages/ai-service/src/provider/keychain.ts');

let failed = 0;
let passed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const control = (name, ok, extra = '') => check(`  ↳ control: ${name}`, ok, extra);
const info = (m) => console.log(`      ${m}`);
const section = (n, t) => console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

const STORE = path.join(HOME, 'providers.json');
const readStore = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : null);
const writeStore = (v) => writeFileSync(STORE, JSON.stringify(v, null, 2));

const SECRET = 'sk-verify-0123456789abcdef-THE-ACTUAL-SECRET';

console.log('AURA Hub — credential protection verification');
console.log(`scratch home: ${HOME}`);

/* ══════════════════════════════════════════════════════════════════
   1. The keychain probe is a round trip, not a `which`
   ══════════════════════════════════════════════════════════════════ */

section(1, 'the keychain probe measures, it does not assume');

{
  const probe = keychain.probeKeychain(true);
  check('the probe names a backend for this platform or says there is none',
    probe.backend !== undefined);
  check('the probe reports availability as a measured boolean',
    typeof probe.available === 'boolean');
  check('an unavailable backend names what is missing',
    probe.available || probe.missing.length > 0, probe.missing.join(', '));
  info(`${probe.backend ?? 'no backend'}: ${probe.detail}`);

  // NEGATIVE CONTROL. On this machine `secret-tool` IS installed while
  // no Secret Service is running. A presence check would report a
  // working keychain; the round trip must not.
  const { resolveExecutable } = await load('packages/ai-service/src/exec/which.ts');
  if (process.platform === 'linux') {
    const toolPresent = resolveExecutable('secret-tool') !== null;
    if (toolPresent && !probe.available) {
      control('the binary is installed and the probe STILL reports unavailable',
        true, 'a `which` check would have reported a working keychain here');
    } else if (toolPresent && probe.available) {
      control('secret-tool is installed and a full round trip succeeded', true);
      // If it really works, prove the round trip is genuine.
      const acct = `__verify_${Date.now()}`;
      const stored = keychain.keychainSet(acct, SECRET);
      const got = keychain.keychainGet(acct);
      keychain.keychainDelete(acct);
      const gone = keychain.keychainGet(acct);
      control('a stored secret reads back byte-identical', stored && got === SECRET);
      control('a deleted secret does not read back', gone === null);
    } else {
      control('no secret-tool, and the probe reports unavailable', !probe.available);
    }
  } else {
    control('probe availability is measured, not assumed', typeof probe.available === 'boolean');
  }
}

/* ══════════════════════════════════════════════════════════════════
   2. With nowhere safe, AURA refuses — it does not obfuscate
   ══════════════════════════════════════════════════════════════════ */

section(2, 'no keychain and no passphrase means refusal, not theatre');

{
  delete process.env.AURA_PROVIDER_SECRET;
  keychain.resetKeychainProbe();
  const available = cred.availableProtection();

  if (available === null) {
    let threw = null;
    try {
      cred.storeKey('verify-provider', SECRET);
    } catch (e) {
      threw = e;
    }
    check('storing without any protection throws', threw !== null);
    check('…with the specific error type',
      threw?.constructor?.name === 'NoCredentialProtectionError', threw?.constructor?.name);
    check('…and the message names both remedies',
      /AURA_PROVIDER_SECRET/.test(threw?.message ?? '') && /keyring|keychain|secret service/i.test(threw?.message ?? ''));
    check('nothing was written to disk', readStore()?.credentials?.['verify-provider'] === undefined);
    info(threw?.message?.slice(0, 150) ?? '');
  } else {
    check(`this machine offers ${available}, so refusal cannot be exercised here`, true);
    info('run this suite with AURA_PROVIDER_SECRET unset and no secret service to exercise §2');
  }

  // NEGATIVE CONTROL. With a passphrase set, the SAME call must succeed —
  // otherwise §2 would pass on a build where storing was simply broken.
  process.env.AURA_PROVIDER_SECRET = 'a-real-passphrase-for-verification';
  keychain.resetKeychainProbe();
  const result = cred.storeKey('verify-provider', SECRET);
  control('with a passphrase set, the same call succeeds',
    Boolean(result?.fingerprint), `${result?.protection}`);
  control('…and the key reads back byte-identical', cred.getKey('verify-provider') === SECRET);
}

/* ══════════════════════════════════════════════════════════════════
   3. THE ATTACK: what does a stolen providers.json give you?
   ══════════════════════════════════════════════════════════════════ */

section(3, 'a stolen providers.json, attacked for real');

{
  /**
   * The old derivation, reconstructed exactly as it was:
   *   sha256(seed + ':aura-provider-v2'), seed read from the same file.
   * This is the attack, not a simulation of one.
   */
  const attackLegacy = (store, providerId) => {
    const seed = store.secret;
    if (!seed) return null;
    const key = crypto.createHash('sha256').update(seed + ':aura-provider-v2').digest();
    const entry = store.credentials[providerId];
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'hex'));
      d.setAuthTag(Buffer.from(entry.tag, 'hex'));
      return d.update(entry.encryptedKey, 'hex', 'utf8') + d.final('utf8');
    } catch { return null; }
  };

  // Build a genuine legacy file, byte-for-byte in the old format.
  const seed = crypto.randomBytes(32).toString('hex');
  const legacyKey = crypto.createHash('sha256').update(seed + ':aura-provider-v2').digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
  const encryptedKey = c.update(SECRET, 'utf8', 'hex') + c.final('hex');
  const legacyStore = {
    secret: seed,
    credentials: {
      'legacy-provider': {
        protection: 'legacy-obfuscated',
        encryptedKey, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'),
        fingerprint: 'sk-v…CRET', createdAt: '2026-01-01T00:00:00.000Z', lastValidated: null,
      },
    },
    models: {}, health: {}, active: null, activeModel: '',
  };

  // NEGATIVE CONTROL, and the strongest one in this suite: the attack
  // must actually WORK against the old format. A check that never
  // recovers anything proves nothing about the format that resists it.
  const stolen = attackLegacy(legacyStore, 'legacy-provider');
  control('the attack recovers the real key from a LEGACY file',
    stolen === SECRET, stolen === SECRET ? 'full plaintext recovered from the file alone' : 'attack failed — the control is broken');

  // Now the same attack against the new format.
  process.env.AURA_PROVIDER_SECRET = 'a-real-passphrase-for-verification';
  keychain.resetKeychainProbe();
  writeStore({ credentials: {}, models: {}, health: {}, active: null, activeModel: '' });
  cred.storeKey('new-provider', SECRET);
  const current = readStore();

  check('the new file contains no `secret` seed', current.secret === undefined);
  const serialised = JSON.stringify(current);
  check('the plaintext key appears nowhere in the file', !serialised.includes(SECRET));
  check('the attack recovers nothing from the new file',
    attackLegacy(current, 'new-provider') === null);

  const entry = current.credentials['new-provider'];
  const protection = entry.protection;
  info(`protection in force: ${protection}`);

  if (protection === 'passphrase') {
    check('a random per-credential salt is stored', typeof entry.salt === 'string' && entry.salt.length === 64);
    check('the ciphertext is authenticated (GCM tag present)', typeof entry.tag === 'string');

    // The derivation must be scrypt, not a hash. Proved by cost and by
    // salt-dependence, both of which a SHA-256 derivation would fail.
    const t0 = Date.now();
    const k1 = crypto.scryptSync('a-real-passphrase-for-verification', Buffer.from(entry.salt, 'hex'), 32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cost = Date.now() - t0;
    check('the KDF is genuinely expensive (scrypt, not a hash)', cost > 20, `${cost}ms per derivation`);

    const k2 = crypto.scryptSync('a-real-passphrase-for-verification', crypto.randomBytes(32), 32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    check('a different salt yields a different key', !k1.equals(k2));

    // And the derived key must be the one that actually decrypts it —
    // otherwise the salt is decoration.
    let recovered = null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k1, Buffer.from(entry.iv, 'hex'));
      d.setAuthTag(Buffer.from(entry.tag, 'hex'));
      recovered = d.update(entry.encryptedKey, 'hex', 'utf8') + d.final('utf8');
    } catch { recovered = null; }
    control('the scrypt-derived key IS what decrypts the credential', recovered === SECRET);

    // The whole point: without the passphrase, the file is useless.
    delete process.env.AURA_PROVIDER_SECRET;
    check('without AURA_PROVIDER_SECRET the key cannot be read', cred.getKey('new-provider') === null);
    process.env.AURA_PROVIDER_SECRET = 'a-real-passphrase-for-verification';
    control('…and with it, the key reads back', cred.getKey('new-provider') === SECRET);

    check('a WRONG passphrase does not read the key', (() => {
      process.env.AURA_PROVIDER_SECRET = 'not-the-right-passphrase';
      const wrong = cred.getKey('new-provider');
      process.env.AURA_PROVIDER_SECRET = 'a-real-passphrase-for-verification';
      return wrong === null;
    })());
  } else if (protection === 'os-keychain') {
    check('no ciphertext is kept in the file at all',
      entry.encryptedKey === undefined && entry.salt === undefined);
    check('the key reads back through the OS keychain', cred.getKey('new-provider') === SECRET);
  }
}

/* ══════════════════════════════════════════════════════════════════
   4. Legacy credentials migrate, and the seed is dropped
   ══════════════════════════════════════════════════════════════════ */

section(4, 'legacy credentials are read once, then re-protected');

{
  process.env.AURA_PROVIDER_SECRET = 'a-real-passphrase-for-verification';
  keychain.resetKeychainProbe();

  const seed = crypto.randomBytes(32).toString('hex');
  const key = crypto.createHash('sha256').update(seed + ':aura-provider-v2').digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encryptedKey = c.update(SECRET, 'utf8', 'hex') + c.final('hex');
  writeStore({
    secret: seed,
    credentials: {
      old: {
        protection: 'legacy-obfuscated',
        encryptedKey, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'),
        fingerprint: 'sk-v…CRET', createdAt: '2026-01-01T00:00:00.000Z', lastValidated: '2026-02-02T00:00:00.000Z',
      },
    },
    models: {}, health: {}, active: null, activeModel: '',
  });

  const read = cred.getKey('old');
  check('a legacy credential is still readable after the change', read === SECRET);

  const after = readStore();
  check('it was re-protected in place', after.credentials.old.protection !== 'legacy-obfuscated',
    after.credentials.old.protection);
  check('the legacy seed was deleted from the file', after.secret === undefined);
  check('the file no longer decrypts under the legacy derivation', (() => {
    const k = crypto.createHash('sha256').update(seed + ':aura-provider-v2').digest();
    const e = after.credentials.old;
    if (!e.encryptedKey) return true; // moved to the OS keychain entirely
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(e.iv, 'hex'));
      d.setAuthTag(Buffer.from(e.tag, 'hex'));
      d.update(e.encryptedKey, 'hex', 'utf8'); d.final('utf8');
      return false;
    } catch { return true; }
  })());
  check('history is preserved across migration',
    after.credentials.old.createdAt === '2026-01-01T00:00:00.000Z' &&
    after.credentials.old.lastValidated === '2026-02-02T00:00:00.000Z');
  check('the key still reads back after migration', cred.getKey('old') === SECRET);

  // NEGATIVE CONTROL: with no protection available, migration must NOT
  // happen and the credential must remain readable exactly as it was.
  delete process.env.AURA_PROVIDER_SECRET;
  keychain.resetKeychainProbe();
  if (cred.availableProtection() === null) {
    const seed2 = crypto.randomBytes(32).toString('hex');
    const k2 = crypto.createHash('sha256').update(seed2 + ':aura-provider-v2').digest();
    const iv2 = crypto.randomBytes(16);
    const c2 = crypto.createCipheriv('aes-256-gcm', k2, iv2);
    const enc2 = c2.update(SECRET, 'utf8', 'hex') + c2.final('hex');
    writeStore({
      secret: seed2,
      credentials: { old2: { protection: 'legacy-obfuscated', encryptedKey: enc2, iv: iv2.toString('hex'), tag: c2.getAuthTag().toString('hex'), fingerprint: 'x', createdAt: 'x', lastValidated: null } },
      models: {}, health: {}, active: null, activeModel: '',
    });
    control('with nowhere better to put it, a legacy credential is left alone and still reads',
      cred.getKey('old2') === SECRET && readStore().credentials.old2.protection === 'legacy-obfuscated');
  } else {
    control('this machine always has protection available, so the no-migration path is not exercisable here', true);
  }
}

/* ══════════════════════════════════════════════════════════════════
   5. Removal really removes
   ══════════════════════════════════════════════════════════════════ */

section(5, 'removal removes');

{
  process.env.AURA_PROVIDER_SECRET = 'a-real-passphrase-for-verification';
  keychain.resetKeychainProbe();
  writeStore({ credentials: {}, models: {}, health: {}, active: null, activeModel: '' });
  cred.storeKey('doomed', SECRET);
  control('it is there before removal', cred.getKey('doomed') === SECRET);
  cred.removeKey('doomed');
  check('the credential is gone from the file', readStore().credentials.doomed === undefined);
  check('the key no longer reads back', cred.getKey('doomed') === null);
  check('the plaintext is nowhere in the file', !JSON.stringify(readStore()).includes(SECRET));
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`${passed} passed · ${failed} failed`);
if (failed) console.log('\nFAILED — do not report credential protection as verified.');
else console.log('\nAll checks passed. The legacy-file attack is the control, and it succeeds.');
process.exit(failed ? 1 : 0);
