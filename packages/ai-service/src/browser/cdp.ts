/**
 * CDP - a minimal Chrome DevTools Protocol client.
 * ==================================================================
 * Written directly against the protocol rather than through a driver
 * library, for one reason that matters and one that is merely true.
 *
 * The one that matters: the whole point of this tier is that AURA drives
 * a browser profile IT OWNS. A driver library's job is to make launching
 * a browser easy, and the easy path it makes is "launch with a fresh
 * profile in a temp directory" or "attach to whatever is running" -
 * neither of which is "attach to exactly this profile, and never the
 * user's". Owning the launch means owning that argument.
 *
 * The one that is merely true: this needs `Page.navigate`,
 * `Runtime.evaluate`, `Input.dispatchMouseEvent` and
 * `Page.captureScreenshot`. That is a few hundred lines over a
 * WebSocket, against a stable protocol.
 *
 * -- Everything read here is untrusted --------------------------------
 * No exception, no threshold, no "but it is our own docs site". Every
 * DOM node, page title and response body that leaves this module is
 * turned into a `ContextItem` with `trust: 'untrusted'` by
 * `browser/driver.ts`, and the composer fences it. A page that can
 * instruct the agent is a page that owns the agent.
 */

import { ProcessSession } from '../exec/session';
import { resolveExecutable } from '../exec/which';
import { auraProfileDir } from './profile';

/* -- Finding a browser ------------------------------------------------- */

/**
 * Executables that speak CDP, in preference order.
 *
 * This is a DISCOVERY list, not an execution allow-list: it answers
 * "which browser is installed", and every entry is the same kind of
 * program doing the same job. It is deliberately not merged with
 * `SAFE_BINARIES`, `AGENT_BINARIES` or `INSTALLER_BINARIES`, which
 * govern what arbitrary commands AURA will run at all.
 */
const BROWSER_CANDIDATES = [
  'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  'chrome', 'msedge', 'microsoft-edge',
];

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const WINDOWS_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export interface BrowserBinary {
  path: string;
  name: string;
}

/** The browser AURA would drive, or null. Probed, never assumed. */
export function findBrowser(): BrowserBinary | null {
  for (const name of BROWSER_CANDIDATES) {
    const resolved = resolveExecutable(name);
    if (resolved) return { path: resolved, name };
  }
  const extra = process.platform === 'darwin' ? MAC_PATHS : process.platform === 'win32' ? WINDOWS_PATHS : [];
  for (const p of extra) {
    if (resolveExecutable(p)) return { path: p, name: p.split(/[/\\]/).pop() ?? 'browser' };
  }
  return null;
}

/* -- The protocol ------------------------------------------------------ */

export class CdpError extends Error {
  readonly code = 'CDP_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

/**
 * "Not executed" is a first-class outcome.
 *
 * The tier must never guess. If no browser is installed, or the debug
 * endpoint never came up, the answer is "this did not run, and here is
 * why" - not an empty page, not a plausible title, not a screenshot of
 * nothing.
 */
export class BrowserUnavailableError extends Error {
  readonly code = 'BROWSER_NOT_EXECUTED' as const;
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BrowserUnavailableError';
  }
}

interface CdpTargetInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * One browser, launched by AURA, on AURA's own profile.
 *
 * The launch arguments are the security boundary, so they are written
 * out in full rather than assembled from a helper:
 *
 *   --user-data-dir  AURA's profile. Not the user's. This is the line
 *                    that keeps the user's live sessions out of reach.
 *   --remote-debugging-port=0  Ephemeral port, written to a file by the
 *                    browser so nothing has to guess or scan.
 *   --no-first-run, --no-default-browser-check  A profile AURA owns
 *                    should never ask the user to adopt it.
 *   --disable-extensions  The user's extensions belong to the user's
 *                    profile and are not part of this agent's authority.
 */
export class BrowserSession {
  private session: ProcessSession | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private endpoint: string | null = null;
  private targetId: string | null = null;

  constructor(private readonly binary: BrowserBinary, private readonly headless = true) {}

  get running(): boolean {
    return this.ws !== null && this.session?.running === true;
  }

  get profileDir(): string {
    return auraProfileDir();
  }

  async launch(): Promise<void> {
    const args = [
      `--user-data-dir=${auraProfileDir()}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      ...(this.headless ? ['--headless=new'] : []),
      'about:blank',
    ];
    const session = new ProcessSession(this.binary.path, args, {
      authority: `AURA is launching the browser profile it owns at ${auraProfileDir()} — never the user's daily profile`,
      idleTimeoutMs: 10 * 60_000,
    });
    session.start();
    this.session = session;

    /* Chrome announces its DevTools endpoint on stderr. Reading it is the
       only way to learn an ephemeral port without scanning, and scanning
       for a debug port is how you attach to the wrong browser. */
    this.endpoint = await this.awaitEndpoint(session);
    const target = await this.openPage();
    if (!target.webSocketDebuggerUrl) {
      throw new CdpError('The browser opened a page but published no debugger URL for it.');
    }
    this.targetId = target.id;
    await this.connectWs(target.webSocketDebuggerUrl);
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  private awaitEndpoint(session: ProcessSession): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const match = session.stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearInterval(poll);
          /* The stderr line is the page-less browser endpoint; the HTTP
             sibling on the same host:port is what lists targets. */
          const url = new URL(match[1].replace(/^ws:/, 'http:'));
          resolve(`http://${url.host}`);
          return;
        }
        if (!session.running) {
          clearInterval(poll);
          reject(new BrowserUnavailableError(
            `${this.binary.name} exited before publishing a debugging endpoint. ${session.stderr.trim().split('\n').slice(-3).join(' | ') || 'It printed nothing.'}`,
          ));
          return;
        }
        if (Date.now() - started > CONNECT_TIMEOUT_MS) {
          clearInterval(poll);
          reject(new BrowserUnavailableError(
            `${this.binary.name} did not publish a debugging endpoint within ${CONNECT_TIMEOUT_MS}ms. Nothing was navigated to.`,
          ));
        }
      }, 100);
    });
  }

  private async openPage(): Promise<CdpTargetInfo> {
    const res = await fetch(`${this.endpoint}/json/new?about:blank`, { method: 'PUT' })
      .catch(() => fetch(`${this.endpoint}/json/new?about:blank`, { method: 'GET' }));
    if (res.ok) return await res.json() as CdpTargetInfo;
    /* Some builds refuse /json/new. Fall back to an existing page rather
       than failing: the browser is up, and a page it already has is a
       real page. */
    const list = await fetch(`${this.endpoint}/json/list`);
    const targets = await list.json() as CdpTargetInfo[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new CdpError('The browser is running but has no page target to drive.');
    return page;
  }

  private connectWs(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      /* Node 22 ships a global WebSocket. It is checked rather than
         assumed: on a runtime without one this tier reports not-executed,
         which is the honest answer, instead of throwing a ReferenceError
         from inside a capability. */
      if (typeof WebSocket === 'undefined') {
        reject(new BrowserUnavailableError('This Node runtime has no WebSocket, so CDP cannot be spoken. Nothing was run.'));
        return;
      }
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new BrowserUnavailableError(`The debugger socket did not open within ${CONNECT_TIMEOUT_MS}ms.`)), CONNECT_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new BrowserUnavailableError('The debugger socket failed to open.'));
      });
      ws.addEventListener('message', (ev: MessageEvent) => this.receive(String(ev.data)));
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new CdpError('The debugger socket closed before the command replied.'));
        }
        this.pending.clear();
        this.ws = null;
      });
    });
  }

  private receive(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // a protocol event, not a reply
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new CdpError(msg.error.message ?? 'the browser refused the command'));
    else p.resolve(msg.result);
  }

  /** One CDP command. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    if (!this.ws) return Promise.reject(new BrowserUnavailableError('No browser session is open, so nothing was run.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} did not reply within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page and return a JSON-serialisable
   * value.
   *
   * `returnByValue` is what keeps this honest: the result crosses the
   * boundary as data, never as a remote object handle the caller could
   * keep poking at. Whatever comes back is page-controlled and is
   * labelled untrusted by the caller.
   */
  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (res.exceptionDetails) {
      throw new CdpError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'the page threw');
    }
    return res.result?.value as T;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
    const info = await this.evaluate<{ url: string; title: string }>(
      '({ url: String(location.href), title: String(document.title || "") })',
    );
    return info;
  }

  /**
   * Wait for the page to settle.
   *
   * Polls `document.readyState` rather than listening for
   * `Page.loadEventFired`, because a load event that already fired before
   * the listener attached never arrives, and a capability that hangs is
   * worse than one that reports a slow page.
   */
  private async waitForLoad(timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await this.evaluate<string>('String(document.readyState)').catch(() => 'unknown');
      if (state === 'complete' || state === 'interactive') return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async screenshot(): Promise<string> {
    const res = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return res.data;
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    try {
      this.ws?.close();
    } catch { /* already closed */ }
    this.ws = null;
    if (this.targetId && this.endpoint) {
      await fetch(`${this.endpoint}/json/close/${this.targetId}`).catch(() => { /* browser is going away anyway */ });
    }
    await this.session?.stop();
    this.session = null;
  }
}
