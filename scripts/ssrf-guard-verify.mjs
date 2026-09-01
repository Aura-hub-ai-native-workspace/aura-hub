/**
 * ssrf-guard-verify — the resolver-level deny list for outbound HTTP.
 * ==================================================================
 * This suite exists on its own, ahead of the rest of the browser/MCP
 * work, because the guard closes a live chain and should not wait for
 * them: `http.request` gated the URL's SCHEME and not its DESTINATION,
 * so loopback was reachable — including AURA's own unauthenticated
 * control plane at 127.0.0.1:4319, whose `/fabric/approvals/:id/decide`
 * route will grant an approval to whoever asks. One capability the human
 * approved for something benign was enough to answer the gate with
 * itself.
 *
 * -- Why there is a canary server in here -----------------------------
 * The audit that found this chain also found a FALSE PASS in its own
 * first attempt at checking it: a request to a link-local address was
 * recorded as "refused" when in fact nothing was listening and the
 * connection had simply failed. A refusal and an unreachable host look
 * identical from the outside.
 *
 * So the live section stands up a REAL HTTP server on loopback and
 * proves two things in order:
 *
 *   1. a bare `fetch` REACHES it            (the canary — the target is up)
 *   2. `guardedFetch` REFUSES it            (the guard — a decision, not a failure)
 *
 * Without (1), (2) is vacuous. That is the whole lesson.
 *
 * -- Honest scope -----------------------------------------------------
 * The redirect re-check is asserted STRUCTURALLY and reported as
 * NOT RUNTIME VERIFIED. Exercising it needs a public redirector that
 * answers 302 with a private-address Location: the first hop must
 * resolve public or the guard refuses at hop 0 and the redirect loop
 * never runs. That is an outbound-network dependency this suite does not
 * take. DNS rebinding is out of scope by the guard's own admission.
 *
 * Usage:  node scripts/ssrf-guard-verify.mjs
 */
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => pathToFileURL(path.join(ROOT, 'packages/ai-service/src', p)).href;
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const { blockedRange, assertResolvableAndAllowed, guardedFetch, BlockedAddressError } =
  await import(src('net/ssrfGuard.ts'));

let failed = false;
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const control = (name, fired, whenQuiet = '') =>
  check(`[negative control] ${name}`, fired, fired ? 'detector fired, as it must' : `detector stayed quiet — ${whenQuiet}`);

/* ══════════════════════════════════════════════════════════════════
   1. The deny list covers what it claims to
   ══════════════════════════════════════════════════════════════════ */

const MUST_BLOCK = [
  ['169.254.169.254', 'cloud metadata'],
  ['127.0.0.1', 'loopback'],
  ['127.1.2.3', 'loopback, not just .0.1'],
  ['10.1.2.3', 'RFC1918 /8'],
  ['172.16.0.1', 'RFC1918 /12'],
  ['172.31.255.254', 'RFC1918 /12 upper bound'],
  ['192.168.1.1', 'RFC1918 /16'],
  ['0.0.0.0', 'this-network'],
  ['100.64.0.1', 'carrier-grade NAT'],
  ['198.18.0.1', 'benchmarking'],
  ['224.0.0.1', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['::1', 'IPv6 loopback'],
  ['::', 'IPv6 unspecified'],
  ['fd00::1', 'IPv6 unique-local'],
  ['fe80::1', 'IPv6 link-local'],
  ['::ffff:169.254.169.254', 'IPv4-in-IPv6 metadata'],
  ['::ffff:127.0.0.1', 'IPv4-in-IPv6 loopback'],
];
for (const [address, label] of MUST_BLOCK) {
  check(`1a  ${address} (${label}) is on the deny list`,
    blockedRange(address) !== null, blockedRange(address) ?? 'NOT BLOCKED');
}

/* The boundaries matter as much as the middles: an off-by-one in a
   range check is how 172.32.0.0 ends up blocked and 172.15.0.0 does
   not. These are the addresses just OUTSIDE each private range. */
const PUBLIC = [
  '93.184.216.34', '8.8.8.8', '1.1.1.1',
  '172.15.0.1', '172.32.0.1', '192.167.1.1', '192.169.1.1',
  '11.0.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '169.255.0.1',
  '2606:4700:4700::1111',
];
control('the deny list does not block public addresses, including every range boundary',
  PUBLIC.every((a) => blockedRange(a) === null),
  `it blocked ${PUBLIC.filter((a) => blockedRange(a) !== null).join(', ')} — the guard is a blanket refusal, not a deny list`);

/* ══════════════════════════════════════════════════════════════════
   2. Refusal happens before a connection, by literal and by name
   ══════════════════════════════════════════════════════════════════ */

let literalBlocked = null;
try { await assertResolvableAndAllowed('http://169.254.169.254/latest/meta-data/'); }
catch (e) { literalBlocked = e; }
check('2a  a literal metadata URL is refused before any connection',
  literalBlocked instanceof BlockedAddressError && literalBlocked.range.includes('link-local'),
  literalBlocked?.message?.slice(0, 120));

let nameBlocked = null;
try { await assertResolvableAndAllowed('http://localhost:9/'); }
catch (e) { nameBlocked = e; }
check('2b  a NAME that resolves to loopback is refused too',
  nameBlocked instanceof BlockedAddressError, nameBlocked?.message?.slice(0, 110));

let schemeBlocked = null;
try { await assertResolvableAndAllowed('file:///etc/passwd'); }
catch (e) { schemeBlocked = e; }
check('2c  a non-http(s) scheme is refused',
  schemeBlocked instanceof Error && /Only http\(s\)/.test(schemeBlocked.message),
  schemeBlocked?.message?.slice(0, 90));

let publicAllowed = true;
try { await assertResolvableAndAllowed('http://93.184.216.34/'); }
catch { publicAllowed = false; }
control('a public literal address passes the guard',
  publicAllowed, 'the guard refused a public address — 2a/2b would pass vacuously');

/* ══════════════════════════════════════════════════════════════════
   3. Live: a real server, reachable, and refused anyway
   ══════════════════════════════════════════════════════════════════
   This is the section the audit's false pass is a warning about. The
   canary proves the target is UP before the guard is asked to refuse
   it, so "refused" cannot be confused with "nothing was listening". */

const CANARY_BODY = 'CANARY-REACHED';
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(CANARY_BODY); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const CANARY_URL = `http://127.0.0.1:${port}/`;

let canaryReached = false;
let canaryDetail = '';
try {
  const res = await fetch(CANARY_URL);
  const text = await res.text();
  canaryReached = res.status === 200 && text === CANARY_BODY;
  canaryDetail = `status ${res.status}, body ${JSON.stringify(text)}`;
} catch (e) { canaryDetail = `bare fetch threw: ${e.message}`; }
control('the canary server is genuinely reachable by a bare fetch',
  canaryReached,
  `${canaryDetail} — without this, "guardedFetch refused it" proves nothing, which is exactly the false pass this suite exists to prevent`);

let fetchBlocked = null;
try { await guardedFetch(CANARY_URL); }
catch (e) { fetchBlocked = e; }
check('3a  guardedFetch refuses a real, live, reachable loopback server',
  fetchBlocked instanceof BlockedAddressError && fetchBlocked.range.includes('loopback'),
  fetchBlocked ? fetchBlocked.message.slice(0, 110) : 'guardedFetch RETURNED — the request went through');

/* The specific chain this closes: AURA's own control plane. Same shape,
   named explicitly so a future reader knows which hole this is. */
let controlPlaneBlocked = null;
try { await guardedFetch('http://127.0.0.1:4319/fabric/approvals/apr-anything/decide', { method: 'POST', body: '{}' }); }
catch (e) { controlPlaneBlocked = e; }
check("3b  AURA's own control plane is unreachable through http.request",
  controlPlaneBlocked instanceof BlockedAddressError,
  controlPlaneBlocked ? 'refused at the resolver' : 'REACHABLE — the self-approval chain is open');

server.close();

/* ══════════════════════════════════════════════════════════════════
   4. Structure: what cannot be exercised here, asserted in source
   ══════════════════════════════════════════════════════════════════ */

const guardSource = read('packages/ai-service/src/net/ssrfGuard.ts');
check('4a  redirects are followed MANUALLY, so every hop is re-checked  [NOT RUNTIME VERIFIED]',
  guardSource.includes("redirect: 'manual'") &&
  /for \(let hop[\s\S]*assertResolvableAndAllowed\(current\)/.test(guardSource),
  'structural only — needs a public redirector answering 302 to a private Location');

const nodesSrc = read('packages/ai-service/src/workflow/nodes.ts');
const execSrc = read('packages/ai-service/src/fabric/executors.ts');
check('4b  both outbound fetch sites use the guard, not bare fetch',
  nodesSrc.includes('guardedFetch(url') && execSrc.includes('guardedFetch(url'));

/* Negative control for 4b: the detector must be able to say no. Run the
   same test against a copy of the file with the guard swapped back out
   for a bare fetch, and it must fail. */
const unguarded = execSrc.replace('guardedFetch(url', 'fetch(url');
control('the fetch-site detector fires when the guard is removed',
  !(unguarded.includes('guardedFetch(url')),
  '4b would pass on a file that had reverted to bare fetch');

check('4c  a blocked address is reported as a refusal, not a transient error',
  /BlockedAddressError\) return no\(/.test(execSrc),
  'otherwise the Fabric\'s retry classifier retries a request that will be refused identically every time');

/* ── report ───────────────────────────────────────────────────────── */

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
console.log('NOTE  4a is structural. The redirect re-check is BUILT and NOT RUNTIME VERIFIED.');
console.log('NOTE  DNS rebinding is out of scope by the guard\'s own documented admission.');
if (failed) {
  console.log('\nFAILED:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name} ${r.extra}`);
}
process.exit(failed ? 1 : 0);
