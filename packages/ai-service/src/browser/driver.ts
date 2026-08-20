/**
 * The browser tier - five capabilities that had no implementation.
 * ==================================================================
 * `browser.navigate`, `browser.read`, `browser.click`, `browser.type`
 * and `browser.screenshot` were declared in the manifest and backed by
 * nothing. A capability with no executor reports `unsupported`, which was
 * honest; this makes them real.
 *
 * Tier 4. A driven browser is less direct than an API, a CLI or a local
 * protocol: the page is a moving target, a selector is a guess about
 * someone else's markup, and everything it returns is attacker-shaped.
 * That tier raises effective risk through the existing policy engine
 * (`TIER_RISK_FLOOR[4] = 'medium'`), which is why these executors declare
 * it rather than describing it in prose.
 *
 * -- The three rules this file exists to keep --------------------------
 *
 *   1. AURA's profile, never the user's. See `profile.ts`. The user's
 *      live sessions are not the agent's ambient authority.
 *
 *   2. Everything read is untrusted. Every DOM node, page title and
 *      response body becomes a `ContextItem` with `trust: 'untrusted'`
 *      HERE, at the boundary, once. Downstream reads that field and never
 *      re-derives it.
 *
 *   3. An unavailable tier reports NOT EXECUTED. No browser installed, no
 *      debugging endpoint, no WebSocket in the runtime - each of those is
 *      a sentence saying what did not happen and why. None of them is an
 *      empty page, a plausible title, or a screenshot of nothing.
 */

import type { Executor, ExecutorResult, CapabilityDriver } from '@aura/capability-fabric';
import type { ContextItem } from '../context/item';
import { fromWeb } from '../context/item';
import { BrowserSession, BrowserUnavailableError, findBrowser } from './cdp';
import { BrowserGrants, auraProfileDir, normalizeOrigin } from './profile';

/** How much page text one read may return. */
const MAX_PAGE_TEXT = 40_000;

const ok = (detail: string, output?: unknown): ExecutorResult => ({ ok: true, detail, output });

/**
 * Not executed: the tier could not run, and said so.
 *
 * `effectStarted: false` is claimed deliberately and only here - these
 * are the paths where AURA is certain nothing touched the outside world,
 * because no browser process was ever spoken to.
 */
const notExecuted = (detail: string): ExecutorResult => ({ ok: false, detail, effectStarted: false });

/**
 * One browser, shared across invocations within a run.
 *
 * A browser per capability call would lose the page between
 * `browser.navigate` and `browser.read`, which is not an optimisation
 * question - it is the difference between the capabilities working and
 * not.
 */
export class BrowserTier {
  private session: BrowserSession | null = null;
  private lastUrl: string | null = null;
  readonly grants = new BrowserGrants();

  /** Why the tier cannot run, or null when it can. Probed, never assumed. */
  unavailableReason(): string | null {
    if (typeof WebSocket === 'undefined') {
      return 'this Node runtime has no WebSocket, so the DevTools Protocol cannot be spoken';
    }
    if (!findBrowser()) {
      return 'no Chromium-based browser was found on this machine (looked for chromium, google-chrome and msedge)';
    }
    return null;
  }

  async ensure(): Promise<BrowserSession> {
    if (this.session?.running) return this.session;
    const reason = this.unavailableReason();
    if (reason) throw new BrowserUnavailableError(reason);
    const binary = findBrowser()!;
    const session = new BrowserSession(binary);
    await session.launch();
    this.session = session;
    return session;
  }

  get current(): BrowserSession | null {
    return this.session?.running ? this.session : null;
  }

  get currentUrl(): string | null {
    return this.lastUrl;
  }

  setUrl(url: string): void {
    this.lastUrl = url;
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = null;
    this.lastUrl = null;
  }
}

/**
 * Page content, at the boundary.
 *
 * The one place browser output becomes context, and therefore the one
 * place its trust is decided. `fromWeb` fixes `trust: 'untrusted'`; the
 * composer fences it and neutralises any structural tag it contains, so
 * a page that writes `<AURA_SYSTEM>` gets quoted, not obeyed.
 */
export function pageAsContextItem(url: string, content: string): ContextItem<string> {
  return fromWeb({ url, content, driver: 'cdp' });
}

/* -- Executors --------------------------------------------------------- */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Nodes AURA can genuinely drive over CDP.
 *
 * Several catalogue entries declare `browser-automation`; AURA has a
 * verified way to drive exactly these. Playwright and Puppeteer also
 * declare it and are refused here rather than attempted — a node AURA
 * cannot drive is reported as such, never silently swapped for one it
 * can.
 */
const DRIVABLE_NODES = new Set(['chromium', 'chrome', 'edge']);
const supportsNode = (node: { id: string }): boolean => DRIVABLE_NODES.has(node.id);

/**
 * Read the page as text.
 *
 * Runs in the page, so it is page-controlled code returning
 * page-controlled data. That is fine and is the whole design: the result
 * is labelled untrusted on the way out. What it must NOT do is anything
 * with a side effect, which is why it reads `innerText` and console
 * errors and nothing else.
 */
const READ_EXPRESSION = `(() => {
  const text = (document.body && document.body.innerText) ? document.body.innerText : '';
  return JSON.stringify({
    url: String(location.href),
    title: String(document.title || ''),
    text: text.slice(0, ${MAX_PAGE_TEXT}),
    truncated: text.length > ${MAX_PAGE_TEXT},
  });
})()`;

const CLICK_EXPRESSION = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ found: false });
  el.scrollIntoView({ block: 'center' });
  el.click();
  return JSON.stringify({ found: true, tag: el.tagName, url: String(location.href) });
})()`;

const TYPE_EXPRESSION = (selector: string, text: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ found: false });
  if (!('value' in el)) return JSON.stringify({ found: true, typable: false, tag: el.tagName });
  el.focus();
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ found: true, typable: true, tag: el.tagName, value: String(el.value) });
})()`;

function unavailable(tier: BrowserTier, action: string): ExecutorResult | null {
  const reason = tier.unavailableReason();
  if (!reason) return null;
  return notExecuted(
    `${action} did not run: ${reason}. AURA does not substitute a different way of doing this — a lower-fidelity path is a different action with different failure modes.`,
  );
}

export function browserExecutors(tier: BrowserTier): Executor[] {
  return [
    {
      capabilityId: 'browser.navigate',
      tier: 4,
      supportsNode,
      async run(inv) {
        const url = str(inv.input.url);
        const blocked = unavailable(tier, 'Navigation');
        if (blocked) return blocked;
        const origin = normalizeOrigin(url);
        if (!origin) return notExecuted(`"${url}" is not an http(s) URL, so nothing was opened.`);
        try {
          const session = await tier.ensure();
          const info = await session.navigate(url);
          tier.setUrl(info.url);
          const grant = tier.grants.find(info.url);
          /* The page TITLE is page-controlled text and enters as an
             untrusted item, exactly like the body would. A title is a
             string an attacker picks. */
          const item = pageAsContextItem(info.url, `Page title: ${info.title}`);
          return ok(
            `Opened ${info.url}${grant ? ` (AURA holds a session grant for ${grant.origin} until ${grant.expiresAt})` : ' (AURA has no session grant for this origin; it is browsing signed out, in its own profile)'}.`,
            { nodeId: 'aura-browser', tier: 4, url: info.url, title: info.title, item, profile: auraProfileDir() },
          );
        } catch (err) {
          if (err instanceof BrowserUnavailableError) return notExecuted(`Navigation did not run: ${err.reason}`);
          return { ok: false, detail: `Navigation failed: ${(err as Error).message}` };
        }
      },
    },

    {
      capabilityId: 'browser.read',
      tier: 4,
      supportsNode,
      async run() {
        const blocked = unavailable(tier, 'Reading the page');
        if (blocked) return blocked;
        const session = tier.current;
        if (!session) return notExecuted('No page is open, so there was nothing to read. Navigate first.');
        try {
          const raw = await session.evaluate<string>(READ_EXPRESSION);
          const page = JSON.parse(raw) as { url: string; title: string; text: string; truncated: boolean };
          const item = pageAsContextItem(page.url, `Page title: ${page.title}\n\n${page.text}`);
          return ok(
            `Read ${page.text.length} characters from ${page.url}${page.truncated ? ` (truncated at ${MAX_PAGE_TEXT})` : ''}. All of it is untrusted data.`,
            { nodeId: 'aura-browser', tier: 4, url: page.url, title: page.title, truncated: page.truncated, item },
          );
        } catch (err) {
          return { ok: false, detail: `Reading the page failed: ${(err as Error).message}` };
        }
      },
    },

    {
      capabilityId: 'browser.click',
      tier: 4,
      supportsNode,
      async run(inv) {
        const selector = str(inv.input.selector);
        const blocked = unavailable(tier, 'Clicking');
        if (blocked) return blocked;
        const session = tier.current;
        if (!session) return notExecuted('No page is open, so nothing was clicked. Navigate first.');
        try {
          const raw = await session.evaluate<string>(CLICK_EXPRESSION(selector));
          const res = JSON.parse(raw) as { found: boolean; tag?: string; url?: string };
          if (!res.found) {
            /* Nothing matched. Reported as a fact, not worked around: a
               click at coordinates because the selector missed is tier 6
               behaviour wearing a tier 4 label. */
            return { ok: false, detail: `No element matches ${selector}, so nothing was clicked. AURA did not try a different way of reaching it.`, effectStarted: false };
          }
          if (res.url) tier.setUrl(res.url);
          return ok(`Clicked ${res.tag ?? 'the element'} matching ${selector}. The page is now at ${res.url}.`, { nodeId: 'aura-browser', tier: 4, url: res.url });
        } catch (err) {
          /* The click may have landed before the page threw, so
             `effectStarted` is left undefined - unknown, never claimed
             safe. */
          return { ok: false, detail: `Clicking ${selector} failed: ${(err as Error).message}` };
        }
      },
    },

    {
      capabilityId: 'browser.type',
      tier: 4,
      supportsNode,
      async run(inv) {
        const selector = str(inv.input.selector);
        const text = str(inv.input.text);
        const blocked = unavailable(tier, 'Typing');
        if (blocked) return blocked;
        const session = tier.current;
        if (!session) return notExecuted('No page is open, so nothing was typed. Navigate first.');
        try {
          const raw = await session.evaluate<string>(TYPE_EXPRESSION(selector, text));
          const res = JSON.parse(raw) as { found: boolean; typable?: boolean; tag?: string; value?: string };
          if (!res.found) return { ok: false, detail: `No element matches ${selector}, so nothing was typed.`, effectStarted: false };
          if (!res.typable) return { ok: false, detail: `${res.tag} matches ${selector} but has no value to set, so nothing was typed.`, effectStarted: false };
          /* The read-back is the page's own report of its field value,
             which makes it untrusted like everything else from here -
             but it is the only verification a browser can offer. */
          return ok(`Set ${res.tag} matching ${selector}. It now reports ${JSON.stringify(res.value ?? '')}.`, { nodeId: 'aura-browser', tier: 4, value: res.value });
        } catch (err) {
          return { ok: false, detail: `Typing into ${selector} failed: ${(err as Error).message}` };
        }
      },
    },

    {
      capabilityId: 'browser.screenshot',
      tier: 4,
      supportsNode,
      async run() {
        const blocked = unavailable(tier, 'Capturing the page');
        if (blocked) return blocked;
        const session = tier.current;
        if (!session) return notExecuted('No page is open, so nothing was captured. Navigate first.');
        try {
          const data = await session.screenshot();
          return ok(`Captured the page (${Math.round(data.length * 0.75 / 1024)} KB of PNG).`, {
            nodeId: 'aura-browser', tier: 4, encoding: 'base64-png', bytes: Math.round(data.length * 0.75), data,
          });
        } catch (err) {
          return { ok: false, detail: `Capturing the page failed: ${(err as Error).message}` };
        }
      },
    },
  ];
}

/** Tier 4 driver, for the registry. */
export function browserDriver(tier: BrowserTier): CapabilityDriver {
  return {
    id: 'cdp',
    tier: 4,
    nodes: ['*'],
    capabilities: ['browser.navigate', 'browser.read', 'browser.click', 'browser.type', 'browser.screenshot'],
    async available() {
      const reason = tier.unavailableReason();
      if (reason) return { ok: false, detail: `The browser tier cannot run: ${reason}.` };
      const binary = findBrowser()!;
      return {
        ok: true,
        detail: `${binary.name} is installed. AURA drives its own profile at ${auraProfileDir()}, never the user's, and holds ${tier.grants.live().length} live site grant(s).`,
      };
    },
  };
}
