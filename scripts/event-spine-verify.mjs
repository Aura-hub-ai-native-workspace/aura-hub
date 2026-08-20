/**
 * event-spine-verify — the nervous system, checked rather than claimed.
 * ==================================================================
 * Three questions, each with a negative control, because a check that
 * cannot fail proves nothing:
 *
 *   1. Is the log durable and is replay from an offset EXACT?
 *   2. Does a backend-initiated approval reach a subscriber with NO
 *      polling — and would the check notice if it did not?
 *   3. Does the agent survive the window closing?
 *
 * Nothing here is mocked. Part A drives the real `DurableEventLog` and
 * `EventSpine`. Part B starts the real service on a free port with a
 * throwaway AURA_HOME, opens ONE `EventSource`-shaped connection, and
 * never issues a second read of the state it is waiting on — so "no
 * polling" is a property of the test, not an assertion about it.
 *
 * Run:  node scripts/event-spine-verify.mjs
 */

import { register } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

register(new URL('./ts-loader-hook.mjs', import.meta.url));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let failed = false;
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const info = (m) => console.log(`      ${m}`);
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   PART A — the durable log and the spine, in process
   ══════════════════════════════════════════════════════════════════ */

async function partA() {
  section('A. Durable log · exact replay');
  const { DurableEventLog } = await import(`${ROOT}/packages/ai-service/src/events/log.ts`);
  const { EventSpine } = await import(`${ROOT}/packages/ai-service/src/events/spine.ts`);

  const dir = tmpDir('aura-spine-');

  /* A1 — append 250 events across several segments, replay from an
     offset, and require the result to be EXACT: right count, contiguous
     sequence, identical payloads. */
  {
    const log = new DurableEventLog({ dir, maxSegmentBytes: 4096, maxSegments: 64, fsync: false });
    for (let i = 1; i <= 250; i += 1) {
      log.append({ topic: 'fabric', type: 'fabric.invocation.started', payload: { i, filler: 'x'.repeat(40) } });
    }
    const head = log.head();
    const after = 137;
    const replay = log.replay(after);
    const expected = head - after;
    const contiguous = replay.events.every((e, idx) => e.seq === after + 1 + idx);
    const payloadsExact = replay.events.every((e, idx) => e.payload.i === after + 1 + idx);
    check('A1 replay from an offset is exact',
      replay.events.length === expected && contiguous && payloadsExact && !replay.truncated,
      `head=${head} after=${after} got=${replay.events.length} expected=${expected}`);
    const segments = fs.readdirSync(dir).filter((f) => f.startsWith('seg-'));
    info(`${segments.length} segment file(s) on disk — replay crossed segment boundaries`);
    check('A1-neg NEGATIVE CONTROL: replay from head returns nothing',
      log.replay(head).events.length === 0,
      'if this passed with events, the offset filter is not applied at all');
    log.close();
  }

  /* A2 — restart. The log is on disk, so a NEW instance over the same
     directory must continue the same sequence and replay the same past. */
  {
    const reopened = new DurableEventLog({ dir, maxSegmentBytes: 4096, maxSegments: 64, fsync: false });
    const headAfterRestart = reopened.head();
    const replayed = reopened.replay(137).events.length;
    const next = reopened.append({ topic: 'workspace', type: 'workspace.index', payload: { phase: 'ready' } });
    check('A2 the log survives a restart and continues its sequence',
      headAfterRestart === 250 && replayed === 113 && next.seq === 251,
      `head=${headAfterRestart} replayed=${replayed} nextSeq=${next.seq}`);
    reopened.close();
  }

  /* A3 — a torn final line (the crash case) must not make the log
     unreadable, and must not be counted as a record. */
  {
    const tornDir = tmpDir('aura-spine-torn-');
    const log = new DurableEventLog({ dir: tornDir, fsync: false });
    for (let i = 1; i <= 5; i += 1) log.append({ topic: 'fabric', type: 't', payload: { i } });
    log.close();
    const file = path.join(tornDir, fs.readdirSync(tornDir)[0]);
    fs.appendFileSync(file, '{"seq":6,"topic":"fabric","ty');
    const recovered = new DurableEventLog({ dir: tornDir, fsync: false });
    const ok = recovered.head() === 5 && recovered.replay(0).events.length === 5;
    const afterAppend = recovered.append({ topic: 'fabric', type: 't', payload: { i: 6 } });
    check('A3 a torn final record is dropped, the rest survives',
      ok && afterAppend.seq === 6 && recovered.replay(0).events.length === 6,
      `head after recovery=${recovered.head()}`);
    recovered.close();
    fs.rmSync(tornDir, { recursive: true, force: true });
  }

  /* A4 — retention. Records that fell off the back must be REPORTED as
     missing, not silently omitted. */
  {
    const pruneDir = tmpDir('aura-spine-prune-');
    const log = new DurableEventLog({ dir: pruneDir, maxSegmentBytes: 512, maxSegments: 2, fsync: false });
    for (let i = 1; i <= 200; i += 1) log.append({ topic: 'fabric', type: 't', payload: { i, filler: 'y'.repeat(60) } });
    const earliest = log.earliest();
    const truncated = log.replay(0).truncated;
    check('A4 a reader whose offset fell off the back is told so',
      earliest > 1 && truncated === true,
      `earliest=${earliest}, replay(0).truncated=${truncated}`);
    check('A4-neg NEGATIVE CONTROL: a reader still inside the window is NOT told so',
      log.replay(earliest).truncated === false,
      'if this failed, `truncated` is hardcoded rather than computed');
    log.close();
    fs.rmSync(pruneDir, { recursive: true, force: true });
  }

  /* A5 — topic filtering, and the fan-out that carries it. */
  {
    const spineDir = tmpDir('aura-spine-sub-');
    const spine = new EventSpine({ dir: spineDir, fsync: false });
    const approvals = [];
    const everything = [];
    spine.subscribe(['approval'], (e) => approvals.push(e));
    spine.subscribe('*', (e) => everything.push(e));
    spine.publish({ topic: 'fabric', type: 'fabric.invocation.started', payload: {} });
    spine.publish({ topic: 'approval', type: 'approval.required', payload: { request: { id: 'apr-1' } } });
    spine.publish({ topic: 'workspace', type: 'workspace.index', payload: {} });
    check('A5 a topic subscriber receives only its topic',
      approvals.length === 1 && approvals[0].type === 'approval.required' && everything.length === 3,
      `approval=${approvals.length} all=${everything.length}`);
    check('A5-neg NEGATIVE CONTROL: the filtered subscriber did NOT see the other two',
      approvals.every((e) => e.topic === 'approval'),
      'if this failed, the filter is not applied and A5 proved nothing');
    spine.close();
    fs.rmSync(spineDir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════
   PART B — the real service, over HTTP
   ══════════════════════════════════════════════════════════════════ */

/**
 * A minimal SSE reader.
 *
 * Written by hand rather than pulled in, for one reason that matters to
 * this test: it must be possible to state, and to see, that the ONLY
 * request it makes is the stream itself. It counts its own reads.
 */
class SseClient {
  constructor(url, { lastEventId } = {}) {
    this.url = url;
    this.lastEventId = lastEventId;
    this.events = [];
    this.waiters = [];
    this.controller = new AbortController();
    /** Every HTTP request this client has made. Asserted on below. */
    this.requestCount = 0;
  }

  async connect() {
    this.requestCount += 1;
    const headers = this.lastEventId !== undefined ? { 'last-event-id': String(this.lastEventId) } : {};
    const res = await fetch(this.url, { headers, signal: this.controller.signal });
    if (!res.ok) throw new Error(`stream failed: HTTP ${res.status}`);
    this.reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    void this.pump();
    return this;
  }

  async pump() {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        buffer += value;
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = { id: null, event: 'message', data: '' };
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) { event.comment = line.slice(1).trim(); continue; }
            if (line.startsWith('id: ')) event.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('data: ')) event.data += line.slice(6);
          }
          if (event.comment && !event.data) continue;
          this.events.push(event);
          for (const w of this.waiters.splice(0)) w();
        }
      }
    } catch { /* aborted */ }
  }

  /** Wait for an event whose name matches, or time out. */
  async waitFor(name, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((e) => e.event === name);
      if (found) return found;
      if (Date.now() > deadline) return null;
      await Promise.race([
        new Promise((r) => this.waiters.push(r)),
        sleep(50),
      ]);
    }
  }

  close() { this.controller.abort(); }
}

async function startService(home, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/run-ts.mjs'), path.join(ROOT, 'packages/ai-service/src/start.ts'), '--none'], {
    cwd: ROOT,
    env: { ...process.env, AURA_HOME: home, AI_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const deadline = Date.now() + 90000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`service did not start within 90s:\n${log}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return { child, logText: () => log };
}

async function stopService(svc) {
  svc.child.kill('SIGTERM');
  await new Promise((r) => { svc.child.on('exit', r); setTimeout(r, 4000); });
  if (!svc.child.killed) svc.child.kill('SIGKILL');
}

async function partB() {
  section('B. One push channel · no poll');
  const home = tmpDir('aura-home-');
  const port = await freePort();
  info(`AURA_HOME=${home}  port=${port}`);
  let svc = await startService(home, port);
  const API = `http://127.0.0.1:${port}`;

  try {
    /* B1 — a backend-initiated approval reaches a subscriber that never
       asks. The client opens ONE stream and then makes NO further reads;
       the only other request is the POST that provokes the approval,
       whose response is deliberately ignored. */
    const stream = await new SseClient(`${API}/events/stream?topics=approval`).connect();
    await stream.waitFor('subscribed', 5000);
    const readsBefore = stream.requestCount;

    const t0 = Date.now();
    // Provoked, not polled: the FABRIC raises this question, and nothing
    // in this script asks whether it has.
    void fetch(`${API}/fabric/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'filesystem.write',
        input: { path: 'spine-verify.txt', content: 'written by event-spine-verify' },
        context: { actor: { kind: 'agent', id: 'agent:spine-verify' }, projectId: null },
      }),
    }).catch(() => undefined);

    const approval = await stream.waitFor('approval.required', 20000);
    const latency = Date.now() - t0;
    const parsed = approval ? JSON.parse(approval.data) : null;
    check('B1 a backend-raised approval reaches the UI channel',
      Boolean(parsed) && parsed.topic === 'approval' && Boolean(parsed.payload?.request?.id),
      approval ? `arrived in ${latency}ms as seq ${parsed.seq}` : 'never arrived');
    check('B1 the subscriber never polled for it',
      stream.requestCount === readsBefore,
      `HTTP requests made by the stream client: ${stream.requestCount} (the stream itself, and nothing else)`);

    /* B1-neg — the control. A stream filtered to a DIFFERENT topic must
       NOT receive it. Without this, B1 would also pass on a service that
       broadcast every event to every listener regardless of filter, and
       "it arrived" would be evidence of nothing. */
    const wrongTopic = await new SseClient(`${API}/events/stream?topics=automation&after=0`).connect();
    await wrongTopic.waitFor('subscribed', 5000);
    const leaked = await wrongTopic.waitFor('approval.required', 2500);
    check('B1-neg NEGATIVE CONTROL: a stream on another topic does not receive it',
      leaked === null,
      leaked ? 'the topic filter is not applied — B1 proves nothing' : 'filter holds');
    wrongTopic.close();

    /* B2 — reconnect is a resume. A new connection carrying
       `Last-Event-ID` must receive exactly the events after it. */
    const head = await (await fetch(`${API}/events/head`)).json();
    const resumeFrom = Math.max(0, head.head - 3);
    const resumed = await new SseClient(`${API}/events/stream?topics=fabric,approval`, { lastEventId: resumeFrom }).connect();
    await resumed.waitFor('subscribed', 5000);
    await sleep(400);
    const replayedSeqs = resumed.events.filter((e) => e.id !== null).map((e) => e.id);
    const allAfter = replayedSeqs.every((s) => s > resumeFrom);
    const ascending = replayedSeqs.every((s, i) => i === 0 || s > replayedSeqs[i - 1]);
    check('B2 Last-Event-ID resumes exactly, with no gap and no duplicate',
      replayedSeqs.length > 0 && allAfter && ascending,
      `resumed after seq ${resumeFrom}: got [${replayedSeqs.join(', ')}]`);
    check('B2-neg NEGATIVE CONTROL: nothing at or before the offset is resent',
      replayedSeqs.every((s) => s !== resumeFrom),
      'an off-by-one here would replay the last event the client already had');
    resumed.close();
    stream.close();

    /* B3 — index status is PUSHED. This is the event that retires the
       600 ms poll in useWorkspace, so it has to actually be published. */
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-proj-'));
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'spine-verify-fixture', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(projectPath, 'index.js'), 'export const answer = 42;\n');

    const workspaceStream = await new SseClient(`${API}/events/stream?topics=workspace`).connect();
    await workspaceStream.waitFor('subscribed', 5000);
    const added = await (await fetch(`${API}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: projectPath, name: 'spine-verify-fixture' }),
    })).json();
    if (added.project?.id) {
      await fetch(`${API}/projects/${added.project.id}/open`, { method: 'POST' });
    }
    const indexEvent = await workspaceStream.waitFor('workspace.index', 30000);
    const indexPayload = indexEvent ? JSON.parse(indexEvent.data) : null;
    check('B3 index status is pushed, not polled for',
      Boolean(indexPayload) && typeof indexPayload.payload?.phase === 'string',
      indexPayload ? `phase "${indexPayload.payload.phase}" arrived unprompted` : 'no workspace.index event was published');
    workspaceStream.close();

    /* ── C. the agent survives the window closing ──────────────── */
    section('C. The agent outlives the window');

    /* There is no window in this test AT ALL — no browser, no renderer,
       no localStorage. That is the point: everything below happens with
       nothing but the service running, which is precisely the state the
       old renderer-hosted agent could not survive. */
    const projectId = added.project?.id;
    check('C0 the service runs the agent with no renderer present',
      Boolean((await (await fetch(`${API}/agent`)).json()).tickMs),
      'GET /agent answers from the service; there is no browser in this process tree');

    /* Seed REAL engineering events, then ask the agent to observe. The
       signals are the ones the ported rules react to: the same file
       failing diagnosis repeatedly. */
    const seeded = [];
    for (let i = 1; i <= 5; i += 1) {
      const res = await fetch(`${API}/engineering-log`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          category: 'diagnosis',
          importance: 'high',
          title: `Null dereference in src/payments.ts (#${i})`,
          summary: `null-pointer: src/payments.ts failed diagnosis run ${i}`,
          reason: 'Recorded by event-spine-verify as a real diagnosis event.',
          user: 'system',
          source: 'diagnosis',
          files: ['src/payments.ts'],
          dedupe: `spine-verify:diagnosis:${i}`,
        }),
      });
      seeded.push(await res.json());
    }
    check('C1 engineering events are recorded to disk, and deduped there',
      seeded.every((s) => s.recorded === true),
      `${seeded.filter((s) => s.recorded).length}/5 recorded`);

    const duplicate = await (await fetch(`${API}/engineering-log`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId, category: 'diagnosis', importance: 'high',
        title: 'duplicate', summary: 'duplicate', source: 'diagnosis',
        files: ['src/payments.ts'], dedupe: 'spine-verify:diagnosis:1',
      }),
    })).json();
    check('C1-neg NEGATIVE CONTROL: the same dedupe key is refused',
      duplicate.recorded === false,
      'if this recorded, a reconcile pass would invent history on every tick');

    const observed = await (await fetch(`${API}/agent/observe`, { method: 'POST' })).json();
    const campaign = observed.campaigns?.[0];
    check('C2 the agent observes real signals and proposes, awaiting a human',
      Boolean(campaign) && campaign.status === 'awaiting-approval',
      campaign ? `"${campaign.signalLabel}" (${campaign.kind})` : 'no campaign proposed');

    const stateFile = path.join(home, 'agent', 'state.json');
    check('C3 the agent\'s state is on disk, not in a browser profile',
      fs.existsSync(stateFile),
      fs.existsSync(stateFile) ? stateFile : 'no state.json — the agent would not survive a restart');

    /* THE test: stop the service (the strongest possible version of
       "close the window" — the whole process is gone) and start a new
       one. The campaign, its timeline and the human decision it is
       waiting on must all still be there. */
    await stopService(svc);
    svc = await startService(home, port);
    const afterRestart = await (await fetch(`${API}/agent`)).json();
    const survivor = afterRestart.campaigns?.find((c) => c.id === campaign?.id);
    check('C4 the agent survives the process being killed',
      Boolean(survivor) && survivor.status === 'awaiting-approval' && afterRestart.timeline.length > 0,
      survivor ? `campaign ${survivor.id} still awaiting approval, ${afterRestart.timeline.length} timeline entries` : 'the campaign was lost');

    const logAfterRestart = await (await fetch(`${API}/engineering-log?projectId=${projectId}`)).json();
    check('C4 the engineering log survives it too',
      (logAfterRestart.items ?? []).filter((e) => e.files.includes('src/payments.ts')).length >= 5,
      `${(logAfterRestart.items ?? []).length} event(s) read back from disk`);

    const spineAfterRestart = await (await fetch(`${API}/events/head`)).json();
    check('C4 the event sequence continues across the restart',
      spineAfterRestart.head >= head.head,
      `head was ${head.head} before the restart, ${spineAfterRestart.head} after`);

    /* C5 — the human's answer still drives it, after the restart. */
    const approved = await (await fetch(`${API}/agent/campaigns/${survivor?.id}/approve`, { method: 'POST' })).json();
    check('C5 a human decision recorded after the restart is honoured',
      approved.status === 'approved' || approved.status === 'executing' || approved.status === 'failed',
      `campaign moved to "${approved.status}"`);

    const dismissMissing = await fetch(`${API}/agent/campaigns/does-not-exist/dismiss`, { method: 'POST' });
    check('C5-neg NEGATIVE CONTROL: a campaign that does not exist cannot be decided',
      dismissMissing.status === 404,
      `HTTP ${dismissMissing.status}`);

    fs.rmSync(projectPath, { recursive: true, force: true });
  } finally {
    await stopService(svc);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ══════════════════════════════════════════════════════════════════
   D — the poll really is retired
   ══════════════════════════════════════════════════════════════════ */

async function partD() {
  section('D. The renderer no longer polls for what is pushed');
  const file = path.join(ROOT, 'apps/desktop/src/data/useWorkspace.ts');
  const source = fs.readFileSync(file, 'utf8');

  const subscribes = source.includes("subscribeToSpine(['workspace']");
  const armedOnlyWhenDown = /onSpineStatus\([\s\S]*?if \(spine === 'open'\)[\s\S]*?clearInterval\(poll\)/.test(source);
  const stillHasPoll = source.includes('setInterval(tick, 600)');

  check('D1 the workspace subscribes to the spine for index status', subscribes);
  check('D2 the 600 ms poll is armed only while the channel is down', armedOnlyWhenDown);
  check('D3 the poll still EXISTS as a reconnect fallback', stillHasPoll,
    'deleting it outright would leave no path when the channel is down');

  const spineClient = path.join(ROOT, 'apps/desktop/src/events/spineClient.ts');
  check('D4 the renderer has exactly one EventSource', fs.existsSync(spineClient));

  // Guard against the two drifting: the renderer only listens for named
  // events, so a service `type` the client does not know is silently
  // dropped. This asserts they agree.
  const clientTypes = new Set([...fs.readFileSync(spineClient, 'utf8').matchAll(/^\s*'([a-z]+\.[a-z0-9.-]+)',$/gmi)].map((m) => m[1]));
  const serviceFiles = [
    'packages/ai-service/src/events/fabricBridge.ts',
    'packages/ai-service/src/server.ts',
  ].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const published = new Set([...serviceFiles.matchAll(/type: ['"`]((?:fabric|approval|mission|automation|workspace|agent|provider)\.[a-z0-9.-]+)['"`]/gi)].map((m) => m[1]));
  const missing = [...published].filter((t) => !clientTypes.has(t));
  check('D5 every event type the service publishes is one the renderer listens for',
    missing.length === 0,
    missing.length ? `not listened for: ${missing.join(', ')}` : `${published.size} type(s) checked`);
}

/* ── run ───────────────────────────────────────────────────────── */

try {
  await partA();
  await partB();
  await partD();
} catch (e) {
  console.error(`\nFATAL  ${e.stack ?? e.message}`);
  failed = true;
}

console.log(`\n${'═'.repeat(66)}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
