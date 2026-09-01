/**
 * secrets — named values a workflow may use but never see.
 * ==================================================================
 * A workflow definition stores `{{secret:GITHUB_TOKEN}}`. The value lives
 * here, encrypted, and is substituted at the last possible moment — while
 * building a Capability Fabric invocation's arguments — and nowhere else.
 *
 * Four properties, in the order they matter:
 *
 *   1. **A definition never contains a value.** Exporting, importing,
 *      version-controlling, AI-generating or emailing a workflow moves
 *      references, not credentials. This closes the research's
 *      "credential theft from workflow state" threat at the source rather
 *      than trying to scrub it downstream.
 *
 *   2. **Resolution is one-way and terminal.** `resolve()` produces a
 *      string that goes straight into `fabric.invoke` arguments. Nothing
 *      resolved is written to a run record, a log, an SSE event or a node
 *      output — those paths all take `redact()`ed text.
 *
 *   3. **Redaction is proven, not promised.** `redact()` replaces known
 *      values wherever they appear, including where a subprocess echoed
 *      one back in its stdout. A user must be able to SEE that redaction
 *      happened, so the marker is visible rather than a silent deletion.
 *
 *   4. **A missing secret fails loudly.** An unresolved reference throws
 *      rather than sending the literal `{{secret:NAME}}` to an API, which
 *      would leak the fact of the reference and fail confusingly.
 *
 * ── On the crypto, honestly ────────────────────────────────────────
 * This uses AES-256-GCM with a key derived from a locally-stored seed,
 * the same construction `provider/credentialStore.ts` already uses for
 * API keys. Where the seed is on the same disk as the ciphertext this is
 * obfuscation at rest, not protection from someone who already has the
 * file — and saying so plainly is the point. `AURA_SECRET_SEED` moves the
 * seed out of the file. The OS keychain is the correct end state and is
 * named as remaining work rather than implied to exist.
 *
 * This is not a second secrets system. Provider API keys keep their own
 * pre-existing store, which is bound to provider identity, model discovery
 * and health; this store holds workflow-referenced values, which have a
 * different lifecycle. They share one encryption construction and one
 * config home.
 */

import crypto from 'node:crypto';
import { homePath, readJsonFile, writeJsonFile } from './persist';

const ALGORITHM = 'aes-256-gcm';
const FILE = () => homePath('secrets.json');

/** `{{secret:NAME}}` — names are conservative on purpose. */
const REFERENCE = /\{\{\s*secret:([A-Za-z0-9_.-]{1,64})\s*\}\}/g;
export const REDACTION = '••••';

interface StoredSecret {
  encrypted: string;
  iv: string;
  tag: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Never the value, and never a prefix of it — only its shape. */
  length: number;
  note?: string;
}

interface SecretFile {
  seed?: string;
  secrets: Record<string, StoredSecret>;
}

const EMPTY: SecretFile = { secrets: {} };

function load(): SecretFile {
  const raw = readJsonFile<Partial<SecretFile>>(FILE(), EMPTY);
  return { seed: raw.seed, secrets: raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {} };
}

function save(file: SecretFile): void {
  writeJsonFile(FILE(), file);
}

function deriveKey(): Buffer {
  const env = process.env.AURA_SECRET_SEED;
  if (env) return crypto.createHash('sha256').update(`${env}:aura-workflow-secrets-v1`).digest();
  const file = load();
  let seed = file.seed;
  if (!seed) {
    seed = crypto.randomBytes(32).toString('hex');
    file.seed = seed;
    save(file);
  }
  return crypto.createHash('sha256').update(`${seed}:aura-workflow-secrets-v1`).digest();
}

/** Metadata a UI may show. Deliberately contains nothing derived from the value. */
export interface SecretInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  length: number;
  note?: string;
}

export class SecretStore {
  list(): SecretInfo[] {
    const { secrets } = load();
    return Object.entries(secrets)
      .map(([name, s]) => ({ name, createdAt: s.createdAt, updatedAt: s.updatedAt, lastUsedAt: s.lastUsedAt, length: s.length, note: s.note }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return Boolean(load().secrets[name]);
  }

  set(name: string, value: string, note?: string): SecretInfo {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new Error('A secret name may only contain letters, numbers, dot, dash and underscore.');
    }
    if (!value) throw new Error('A secret needs a value.');
    const key = deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = cipher.update(value, 'utf8', 'hex') + cipher.final('hex');
    const file = load();
    const now = new Date().toISOString();
    const existing = file.secrets[name];
    file.secrets[name] = {
      encrypted,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      length: value.length,
      note: note ?? existing?.note,
    };
    save(file);
    const s = file.secrets[name];
    return { name, createdAt: s.createdAt, updatedAt: s.updatedAt, lastUsedAt: s.lastUsedAt, length: s.length, note: s.note };
  }

  remove(name: string): boolean {
    const file = load();
    if (!file.secrets[name]) return false;
    delete file.secrets[name];
    save(file);
    return true;
  }

  /**
   * Decrypt one value.
   *
   * Private by convention and by call site: only `resolve()` and
   * `redactor()` in this file use it, and neither returns a value to a
   * caller that could persist it. Exposing this as a route or a public
   * method would defeat the whole file.
   */
  private reveal(name: string): string | null {
    const file = load();
    const s = file.secrets[name];
    if (!s) return null;
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(s.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(s.tag, 'hex'));
      return decipher.update(s.encrypted, 'hex', 'utf8') + decipher.final('utf8');
    } catch {
      // A wrong seed or a tampered file fails the GCM tag. Returning null
      // makes it a missing secret — loud at the call site — rather than
      // garbage that would be sent somewhere.
      return null;
    }
  }

  private touch(names: string[]): void {
    if (!names.length) return;
    const file = load();
    const now = new Date().toISOString();
    let changed = false;
    for (const n of names) {
      if (!file.secrets[n]) continue;
      file.secrets[n].lastUsedAt = now;
      changed = true;
    }
    if (changed) save(file);
  }

  /** Secret names a piece of text refers to. Reads nothing. */
  referencesIn(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(REFERENCE)) out.add(m[1]);
    return [...out];
  }

  /** Every reference in a workflow's configs, for the envelope and the UI. */
  referencesInConfigs(configs: Record<string, unknown>[]): string[] {
    const out = new Set<string>();
    for (const config of configs) {
      for (const value of Object.values(config ?? {})) {
        if (typeof value !== 'string') continue;
        for (const n of this.referencesIn(value)) out.add(n);
      }
    }
    return [...out].sort();
  }

  /**
   * Substitute real values. The result must go straight into a capability
   * invocation and must never be stored, logged or streamed.
   */
  resolve(text: string): { text: string; used: string[] } {
    const used: string[] = [];
    const missing: string[] = [];
    const resolved = text.replace(REFERENCE, (_, name: string) => {
      const value = this.reveal(name);
      if (value === null) { missing.push(name); return ''; }
      used.push(name);
      return value;
    });
    if (missing.length) {
      throw new Error(
        `This node references ${missing.length === 1 ? 'a secret' : 'secrets'} that ${missing.length === 1 ? 'is' : 'are'} not stored: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} in Settings → Secrets and run again.`,
      );
    }
    this.touch(used);
    return { text: resolved, used };
  }

  /**
   * A function that scrubs known secret values out of arbitrary text.
   *
   * Built once per run rather than per call: it decrypts the values it
   * needs a single time, holds them only for the life of the run, and is
   * applied to every node output, summary, log line and error before any
   * of them reaches a record or a stream. Longest-first so a secret that
   * is a prefix of another cannot leave the tail of the longer one behind.
   *
   * Returns identity when nothing is stored, so the common case costs
   * nothing.
   */
  redactor(names?: string[]): (text: string) => string {
    const wanted = names ?? Object.keys(load().secrets);
    const values: string[] = [];
    for (const name of wanted) {
      const v = this.reveal(name);
      // A one- or two-character "secret" would redact half the output. It
      // is also not a credential. Ignoring it is safer than mangling every
      // log line in the product.
      if (v && v.length >= 4) values.push(v);
    }
    if (!values.length) return (text) => text;
    values.sort((a, b) => b.length - a.length);
    return (text) => {
      let out = text;
      for (const v of values) out = out.split(v).join(REDACTION);
      return out;
    };
  }
}

export const secrets = new SecretStore();
