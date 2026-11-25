/**
 * fabric/serverIdentity — bind every connection to the private runtime server
 * to the process AURA started.
 * ==================================================================
 * The readiness gate (`opencodeMcp`) must never send the server's one-time
 * password, a status request or a task to a listener other than the private
 * server it launched. Neither runtime can receive an inherited socket, listen
 * on a Unix socket or speak over a parent-owned pipe (OpenCode 2.3.2
 * `serve --stdio` only prints a TCP URL; Kilo 7.5.14 has no such option), so
 * the connection is TCP on loopback, and text on stdout is not evidence of
 * who listens: the server's children share that pipe.
 *
 * So this module relies on what the operating system says:
 *
 *   1. Server identity — the spawned process, or, when that process is a
 *      known launcher (the npm `node` wrapper; `cmd.exe`) with exactly one
 *      child, that child. Pinned as (pid, start time): a reused PID never
 *      matches.
 *   2. Per-connection ownership — an AURA-owned loopback relay is what the
 *      runtime CLIs and the gate talk to. For every relayed connection AURA
 *      opens its own upstream connection and waits until the OS shows the
 *      server side of THAT connection (server port, remote = AURA's
 *      ephemeral port) held by the pinned process. Only then is one byte
 *      forwarded. There is no separate check to race: a listener that
 *      changes in between (port reuse, a child rebinding the port,
 *      SO_REUSEPORT) cannot receive anything.
 *
 * Linux reads /proc; macOS uses `lsof` and `ps`. Windows is reported as
 * unsupported and the gate refuses the run rather than degrade silently.
 *
 * NOT authentication of code: a plugin inside the server process, a
 * compromised runtime, or a same-user process that can ptrace the server or
 * read /proc/<pid>/environ is indistinguishable to the OS. See
 * docs/COMMON_CONTEXT_GATE_SECURITY.md.
 *
 * Mirrors backend/aura/workers/server_identity.py.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const LAUNCHER = /^(node|nodejs|node\d+)(\.exe)?$|^cmd\.exe$/i;
export const MAX_LAUNCHER_HOPS = 3;
export const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_POLL_MS = 10;

/** The OS cannot be asked (unsupported platform, missing tool, permission denied). */
export class IdentityUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'IdentityUnavailable'; }
}

/** The OS answered, and the answer does not identify the server AURA started. */
export class IdentityMismatch extends Error {
  constructor(message: string) { super(message); this.name = 'IdentityMismatch'; }
}

export interface ServerProcess { pid: number; start: string }

export interface IdentityBackend {
  readonly name: string;
  available(): Promise<{ ok: boolean; detail: string }>;
  exeName(pid: number): Promise<string | undefined>;
  children(pid: number): Promise<number[]>;
  startTime(pid: number): Promise<string | undefined>;
  listenPorts(proc: ServerProcess): Promise<Set<number>>;
  /** true: the server side of this connection is held by `proc`; false: by someone else; undefined: no owner yet. */
  connectionOwner(proc: ServerProcess, serverPort: number, clientPort: number): Promise<boolean | undefined>;
}

const errCode = (e: unknown) => (e as { code?: string })?.code;

// ── Linux: /proc ─────────────────────────────────────────────────────────────

const V4_LOOPBACK = '0100007F';                                // 127.0.0.1, little-endian
const V6_MAPPED_LOOPBACK = '0000000000000000FFFF00000100007F'; // ::ffff:127.0.0.1
const LOOPBACK = new Set([V4_LOOPBACK, V6_MAPPED_LOOPBACK]);
const WILDCARD = new Set(['00000000', '0'.repeat(32)]);
const LISTEN = '0A';
const ESTABLISHED = '01';

interface TcpRow { lip: string; lport: number; rip: string; rport: number; st: string; inode: string }

export class Procfs implements IdentityBackend {
  readonly name = 'procfs';
  constructor(private readonly root = '/proc') {}

  async available() {
    try {
      await fs.readdir(`${this.root}/self/fd`);
      await fs.readFile(`${this.root}/net/tcp`, 'utf8');
      return { ok: true, detail: 'Linux /proc socket ownership' };
    } catch (e) {
      return { ok: false, detail: `/proc cannot be read (${errCode(e) ?? 'error'})` };
    }
  }

  private async stat(pid: number): Promise<string[] | undefined> {
    let text: string;
    try {
      text = await fs.readFile(`${this.root}/${pid}/stat`, 'utf8');
    } catch (e) {
      if (errCode(e) === 'EACCES' || errCode(e) === 'EPERM') throw new IdentityUnavailable(`process ${pid} cannot be inspected`);
      return undefined;
    }
    // The command name is in parentheses and may itself contain spaces or ')'.
    return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  }

  async startTime(pid: number) {
    const fields = await this.stat(pid);
    return fields && fields.length > 19 ? fields[19] : undefined;   // field 22: starttime
  }

  async exeName(pid: number) {
    try {
      return path.basename(await fs.readlink(`${this.root}/${pid}/exe`));
    } catch (e) {
      if (errCode(e) === 'EACCES' || errCode(e) === 'EPERM') throw new IdentityUnavailable(`the executable of process ${pid} cannot be inspected`);
      return undefined;
    }
  }

  async children(pid: number) {
    const found: number[] = [];
    for (const entry of await fs.readdir(this.root)) {
      if (!/^\d+$/.test(entry)) continue;
      let fields: string[] | undefined;
      try { fields = await this.stat(Number(entry)); } catch { continue; }  // another user's process
      if (fields && fields[1] === String(pid)) found.push(Number(entry));
    }
    return found;
  }

  private async inodes(pid: number): Promise<Set<string>> {
    let names: string[];
    try {
      names = await fs.readdir(`${this.root}/${pid}/fd`);
    } catch (e) {
      if (errCode(e) === 'EACCES' || errCode(e) === 'EPERM') throw new IdentityUnavailable(`the sockets of process ${pid} cannot be inspected`);
      return new Set();
    }
    const out = new Set<string>();
    for (const name of names) {
      try {
        const target = await fs.readlink(`${this.root}/${pid}/fd/${name}`);
        if (target.startsWith('socket:[')) out.add(target.slice(8, -1));
      } catch { /* closed meanwhile */ }
    }
    return out;
  }

  private async rows(): Promise<TcpRow[]> {
    const rows: TcpRow[] = [];
    for (const table of ['tcp', 'tcp6']) {
      let text: string;
      try {
        text = await fs.readFile(`${this.root}/net/${table}`, 'utf8');
      } catch (e) {
        if (errCode(e) === 'EACCES' || errCode(e) === 'EPERM') throw new IdentityUnavailable('the TCP socket table cannot be read');
        continue;
      }
      for (const line of text.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length < 10) continue;
        const [lip, lport] = c[1].split(':');
        const [rip, rport] = c[2].split(':');
        rows.push({ lip, lport: parseInt(lport, 16), rip, rport: parseInt(rport, 16), st: c[3], inode: c[9] });
      }
    }
    return rows;
  }

  async listenPorts(proc: ServerProcess) {
    const inodes = await this.inodes(proc.pid);
    const ports = new Set<number>();
    for (const r of await this.rows()) {
      if (r.st === LISTEN && inodes.has(r.inode) && (LOOPBACK.has(r.lip) || WILDCARD.has(r.lip))) ports.add(r.lport);
    }
    return ports;
  }

  async connectionOwner(proc: ServerProcess, serverPort: number, clientPort: number) {
    for (const r of await this.rows()) {
      if (r.lport === serverPort && r.rport === clientPort && r.st === ESTABLISHED && LOOPBACK.has(r.lip) && LOOPBACK.has(r.rip)) {
        if (r.inode === '0') return undefined;                  // still in the accept queue
        return (await this.inodes(proc.pid)).has(r.inode);
      }
    }
    return undefined;
  }
}

// ── macOS (and any system with lsof + ps) ────────────────────────────────────

const LSOF_LOOPBACK = /^(?:127\.0\.0\.1|\[::ffff:127\.0\.0\.1\])$/;
const LSOF_ANY = /^(?:\*|0\.0\.0\.0|\[::\])$/;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // lsof and ps exit 1 when nothing matched: that is an answer, not a failure.
      if (error && typeof (error as { code?: unknown }).code !== 'number') {
        reject(new IdentityUnavailable(`${path.basename(file)} could not be run`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export class Lsof implements IdentityBackend {
  readonly name = 'lsof';
  constructor(public lsof: string | null = 'lsof', public ps: string | null = 'ps') {}

  async available() {
    if (!this.lsof || !this.ps) return { ok: false, detail: 'lsof and ps are required to inspect socket ownership' };
    try {
      await run(this.ps, ['-o', 'pid=', '-p', String(process.pid)]);
      await run(this.lsof, ['-v']);
    } catch {
      return { ok: false, detail: 'lsof and ps are required to inspect socket ownership' };
    }
    return { ok: true, detail: 'lsof socket ownership' };
  }

  async startTime(pid: number) {
    const out = (await run(this.ps!, ['-o', 'lstart=', '-p', String(pid)])).trim();
    return out || undefined;
  }

  async exeName(pid: number) {
    const out = (await run(this.ps!, ['-o', 'comm=', '-p', String(pid)])).trim();
    return out ? path.basename(out) : undefined;
  }

  async children(pid: number) {
    const found: number[] = [];
    for (const line of (await run(this.ps!, ['-A', '-o', 'pid=,ppid='])).split('\n')) {
      const c = line.trim().split(/\s+/);
      if (c.length === 2 && c[1] === String(pid) && /^\d+$/.test(c[0])) found.push(Number(c[0]));
    }
    return found;
  }

  private async names(pid: number, ...selector: string[]) {
    const out = await run(this.lsof!, ['-nP', '-a', '-p', String(pid), ...selector, '-Fn']);
    return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
  }

  async listenPorts(proc: ServerProcess) {
    const ports = new Set<number>();
    for (const name of await this.names(proc.pid, '-iTCP', '-sTCP:LISTEN')) {
      const at = name.lastIndexOf(':');
      const host = name.slice(0, at);
      const port = name.slice(at + 1);
      if (/^\d+$/.test(port) && (LSOF_LOOPBACK.test(host) || LSOF_ANY.test(host))) ports.add(Number(port));
    }
    return ports;
  }

  async connectionOwner(proc: ServerProcess, serverPort: number, clientPort: number) {
    // lsof cannot cheaply say who else holds a socket; "not seen under the
    // server" stays undefined and the caller's deadline makes it a refusal.
    for (const name of await this.names(proc.pid, `-iTCP:${serverPort}`, '-sTCP:ESTABLISHED')) {
      const [local, remote = ''] = name.split('->');
      const la = local.lastIndexOf(':');
      const ra = remote.lastIndexOf(':');
      if (local.slice(la + 1) === String(serverPort) && remote.slice(ra + 1) === String(clientPort)
        && LSOF_LOOPBACK.test(local.slice(0, la)) && LSOF_LOOPBACK.test(remote.slice(0, ra))) return true;
    }
    return undefined;
  }
}

export class Unsupported implements IdentityBackend {
  readonly name = 'unsupported';
  constructor(private readonly why: string) {}
  async available() { return { ok: false, detail: this.why }; }
  async exeName(): Promise<string | undefined> { throw new IdentityUnavailable(this.why); }
  async children(): Promise<number[]> { throw new IdentityUnavailable(this.why); }
  async startTime(): Promise<string | undefined> { throw new IdentityUnavailable(this.why); }
  async listenPorts(): Promise<Set<number>> { throw new IdentityUnavailable(this.why); }
  async connectionOwner(): Promise<boolean | undefined> { throw new IdentityUnavailable(this.why); }
}

/** The inspection method for this platform. Never a weaker fallback. */
export function defaultBackend(platform: NodeJS.Platform = process.platform): IdentityBackend {
  if (platform === 'linux') return new Procfs();
  if (platform === 'darwin') return new Lsof();
  return new Unsupported(`socket ownership verification is not implemented on ${platform}`);
}

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * The process that is the server, or undefined while it does not exist yet.
 * The spawned process is the server unless it is a known launcher; a launcher
 * must have exactly one child, which is followed. Several children are
 * ambiguous and refused, never guessed.
 */
export async function resolveServer(backend: IdentityBackend, spawnedPid: number): Promise<ServerProcess | undefined> {
  let pid = spawnedPid;
  for (let hop = 0; hop <= MAX_LAUNCHER_HOPS; hop++) {
    const name = await backend.exeName(pid);
    if (name === undefined) return undefined;
    if (!LAUNCHER.test(name)) {
      const start = await backend.startTime(pid);
      return start ? { pid, start } : undefined;
    }
    const kids = await backend.children(pid);
    if (kids.length === 0) return undefined;                 // the launcher has not started it yet
    if (kids.length > 1) throw new IdentityMismatch(`the launcher ${name} started ${kids.length} processes; the server cannot be identified unambiguously`);
    pid = kids[0];
  }
  throw new IdentityMismatch('the server is hidden behind too many launcher processes');
}

export async function stillRunning(backend: IdentityBackend, proc: ServerProcess): Promise<boolean> {
  return (await backend.startTime(proc.pid)) === proc.start;
}

export async function ownsConnection(backend: IdentityBackend, proc: ServerProcess, serverPort: number, clientPort: number): Promise<boolean | undefined> {
  if (!(await stillRunning(backend, proc))) return false;
  return backend.connectionOwner(proc, serverPort, clientPort);
}

// ── the relay ────────────────────────────────────────────────────────────────

export class Violation extends Error {
  constructor(readonly reason: 'unverified-server' | 'identity-unavailable', message: string) {
    super(message);
    this.name = 'Violation';
  }
}

/**
 * A loopback listener owned by AURA that forwards each connection to the
 * server only after the OS confirms the server side of that connection
 * belongs to `proc`. Nothing from the client is read before that
 * (`pauseOnConnect`). AURA holds this listener for the whole run (no
 * SO_REUSEPORT), so no other process can take its port meanwhile.
 */
export class VerifiedRelay {
  readonly violations: Violation[] = [];
  url = '';
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly backend: IdentityBackend,
    readonly proc: ServerProcess,
    readonly serverPort: number,
    private readonly verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  ) {}

  async start(): Promise<string> {
    const server = net.createServer({ pauseOnConnect: true }, (client) => { void this.relay(client); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve());
    });
    this.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    return this.url;
  }

  private track(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
  }

  private async verify(clientPort: number): Promise<void> {
    const deadline = Date.now() + this.verifyTimeoutMs;
    for (;;) {
      let owned: boolean | undefined;
      try {
        owned = await ownsConnection(this.backend, this.proc, this.serverPort, clientPort);
      } catch (e) {
        if (e instanceof IdentityUnavailable) throw new Violation('identity-unavailable', `the server's socket ownership could not be checked (${e.message})`);
        throw e;
      }
      if (owned === true) return;
      if (owned === false || Date.now() >= deadline) {
        throw new Violation('unverified-server', `a connection to port ${this.serverPort} was not accepted by the server process AURA started (pid ${this.proc.pid}); nothing was sent over it`);
      }
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
    }
  }

  private async relay(client: net.Socket): Promise<void> {
    this.track(client);
    const upstream = net.connect({ host: '127.0.0.1', port: this.serverPort });
    upstream.pause();
    this.track(upstream);
    try {
      await new Promise<void>((resolve, reject) => {
        upstream.once('connect', () => resolve());
        upstream.once('error', reject);
      });
    } catch {
      client.destroy();                 // nothing listens: the client sees a closed connection
      return;
    }
    try {
      await this.verify(upstream.localPort!);
    } catch (e) {
      if (e instanceof Violation) this.violations.push(e);
      client.destroy();
      upstream.destroy();
      if (!(e instanceof Violation)) throw e;
      return;
    }
    if (client.destroyed || upstream.destroyed) return;
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
    upstream.resume();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
