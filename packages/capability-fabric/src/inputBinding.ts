/**
 * inputBinding — what an approval is an approval OF.
 * ==================================================================
 * An approval used to authorise a CAPABILITY. It now authorises an
 * ACTION: a capability together with the exact input the human was shown.
 *
 * The defect this closes, in full. `approvalKey()` identifies a question
 * as `mission:task:capability`, or `inv:<id>` when there is no mission to
 * anchor to. Neither that key nor the stored `ApprovalRequest` kept any
 * trace of the input. So the resume path checked only that the grant
 * mentioned the same capability id:
 *
 *     items.some((i) => i.capabilityId === capabilityId)
 *
 * A human approving `terminal.execute` for `node --version` was, in
 * substance, approving `terminal.execute` for anything. Present the same
 * approval id with a different command and it was spent on the new one —
 * and `terminal.execute` runs arbitrary code as the user, so this was not
 * a narrow escalation. `filesystem.write`, `http.request` and
 * `agent.delegate` are affected identically: every capability whose INPUT
 * determines its EFFECT, which is most of them.
 *
 * This is a confused deputy, not a race. Nothing has to be timed. The
 * grant is used exactly once, by the caller it was issued to, for the
 * capability it named — and still does something the human did not agree
 * to. Single-use was never the property under attack.
 *
 * -- Why a hash and not the input itself -------------------------------
 * The stored request is shown to a human and written to the journal, so
 * it holds a REDACTED summary of the input. Redacted text cannot be
 * compared for equality without comparing redactions, and two different
 * secrets redact to the same marker — an equality test over summaries
 * would accept a substituted credential. The binding therefore fingerprints
 * the RAW input while the display keeps the redacted summary. Different
 * concerns, deliberately not sharing a value.
 *
 * -- Why the digest is implemented here --------------------------------
 * `@aura/capability-fabric` imports nothing from `node:` today, and the
 * renderer stays off it deliberately (`ai/fabricClient.ts` reads the
 * Fabric over HTTP and says why). Reaching for `node:crypto` here would
 * spend that property on one function. Injecting a hasher through
 * `FabricHost` would spend it differently — every construction site in
 * the repo would have to supply one, and a host that forgot would lose
 * the binding silently.
 *
 * So SHA-256 is implemented here, in about sixty lines of a
 * fully-specified algorithm, and `approval-binding-verify` asserts it
 * matches `node:crypto` byte for byte across a set of vectors including
 * empty input, multi-block input and non-ASCII. If it ever diverges from
 * the reference, that check fails. A hand-written digest with no test
 * against a reference would be the bad idea; this one has the test.
 */

/* ── canonical JSON ──────────────────────────────────────────────── */

/**
 * A value's canonical text, with object keys sorted at every depth.
 *
 * Key order is why `JSON.stringify` alone will not do: `{a:1,b:2}` and
 * `{b:2,a:1}` describe the same action and must not produce different
 * fingerprints, or an approval would refuse a resume that changed
 * nothing. Arrays keep their order, because order is meaning there —
 * `['add','.']` and `['.','add']` are different git commands.
 *
 * `undefined` is dropped from objects and becomes `null` in arrays,
 * matching `JSON.stringify`, so a field that is absent and a field that
 * is explicitly undefined fingerprint alike — they execute alike.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(String(value));
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/* ── SHA-256, FIPS 180-4 ─────────────────────────────────────────── */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of a string's UTF-8 bytes, lowercase hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;

  /* Pad to a multiple of 64 bytes: one 0x80 byte, then zeros, then the
     message length as a 64-bit big-endian integer in the final 8 bytes. */
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
  return out;
}

/* ── the binding itself ──────────────────────────────────────────── */

/**
 * The fingerprint of an ACTION: this capability, with this input.
 *
 * The capability id is inside the hash as well as being checked
 * separately. Belt and braces on purpose — if the id check were ever
 * refactored away, two capabilities that happen to take the same input
 * shape would still not share a grant.
 */
export function actionFingerprint(capabilityId: string, input: Record<string, unknown>): string {
  return sha256Hex(`aura-approval-binding-v1\n${capabilityId}\n${canonicalJson(input)}`);
}
