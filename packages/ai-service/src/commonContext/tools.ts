/**
 * The common-context tool layer: the operations agents use on the shared store
 * (load, save, search, failures, area claims, summaries, handoffs, broadcasts), run directly
 * on the built-in store so nothing has to be installed and no other tool's configuration changes.
 *
 * Every call is on behalf of one agent id and one project folder; the store is that folder's
 * `common-context.json`.
 */
import * as path from "node:path";
import { ContextStore, StoreError } from "./store.js";
import type { ContextData, SessionEntry } from "./store.js";
import { loadConfig } from "./config.js";

const MAX_VALUE = 20_000;
const MAX_KEY = 200;

const now = () => new Date().toISOString();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export interface SummaryInput {
  title: string;
  accomplished: string;
  learned?: string;
  decisions?: string;
  next_steps?: string;
}

export class ContextTools {
  private readonly store: ContextStore;
  private readonly agent: string;
  private readonly cfg: ReturnType<typeof loadConfig>;

  constructor(projectDir: string, agent: string, env: NodeJS.ProcessEnv = process.env) {
    this.cfg = loadConfig({ ...env, CONTEXT_MCP_PROJECT_DIR: path.resolve(projectDir), CONTEXT_MCP_FILE: "" });
    this.agent = clip(agent.trim() || "agent", 80);
    this.store = new ContextStore(this.cfg);
  }

  get file(): string {
    return this.store.file;
  }

  /** The brief a new session starts from: open session, recent checkpoints, failures, claims, handoffs. */
  loadContext(): { sessionId: string; brief: string } {
    return this.store.write((d) => {
      const session = this.openSession(d);
      const lines: string[] = [];
      const done = d.sessions.filter((s) => s.status === "completed").slice(-3);
      for (const s of done) lines.push(`Session "${s.title}": ${clip(s.accomplished, 300)}${s.next_steps ? ` Next: ${clip(s.next_steps, 200)}` : ""}`);
      const recent = Object.entries(d.contexts).sort((a, b) => b[1].updated.localeCompare(a[1].updated)).slice(0, 10);
      for (const [k, c] of recent) lines.push(`${k} (${c.agent}): ${clip(c.value, 300)}`);
      for (const f of d.failures.slice(-5)) lines.push(`Failed approach: ${clip(f.approach, 150)} — ${clip(f.why_failed, 200)}`);
      for (const [area, c] of Object.entries(d.claims)) {
        if (Date.parse(c.expires) > Date.now()) lines.push(`Claimed: ${area} by ${c.agent}`);
      }
      for (const b of d.broadcasts.slice(-3)) lines.push(`Broadcast from ${b.agent}: ${clip(b.message, 200)}`);
      return { sessionId: session.id, brief: clip(lines.join("\n"), this.cfg.loadBudgetChars) || "No saved context yet." };
    });
  }

  saveContext(key: string, value: string, tags: string[] = []): void {
    const k = key.trim();
    if (!k || k.length > MAX_KEY) throw new StoreError("key must be 1-200 characters");
    if (value.length > MAX_VALUE) throw new StoreError(`value is over ${MAX_VALUE} characters`);
    this.store.write((d) => {
      const prior = d.contexts[k];
      const history = prior ? [...prior.history, { value: prior.value, agent: prior.agent, updated: prior.updated }].slice(-20) : [];
      d.contexts[k] = { value, tags: tags.slice(0, 20).map((t) => clip(t, 50)), agent: this.agent, updated: now(), history };
      const s = this.openSession(d);
      s.checkpoint = clip(`${k}: ${value}`, 500);
      s.status = "checkpointed";
      s.heartbeat = now();
    });
  }

  searchContext(query: string, limit = 8): Array<{ key: string; agent: string; excerpt: string }> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return this.store.read((d) => {
      const hits: Array<{ key: string; agent: string; excerpt: string; score: number }> = [];
      for (const [key, c] of Object.entries(d.contexts)) {
        const hay = `${key} ${c.value} ${c.tags.join(" ")}`.toLowerCase();
        const score = words.filter((w) => hay.includes(w)).length;
        if (score) hits.push({ key, agent: c.agent, excerpt: clip(c.value, 240), score });
      }
      for (const f of d.failures) {
        const hay = `${f.approach} ${f.why_failed}`.toLowerCase();
        const score = words.filter((w) => hay.includes(w)).length;
        if (score) hits.push({ key: "failure", agent: f.agent, excerpt: clip(`${f.approach} — ${f.why_failed}`, 240), score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 25)).map(({ score: _s, ...h }) => h);
    });
  }

  saveFailure(approach: string, whyFailed: string): void {
    this.store.write((d) => {
      d.failures.push({ approach: clip(approach, 1000), why_failed: clip(whyFailed, 2000), agent: this.agent, timestamp: now() });
      d.patterns.fails = [...d.patterns.fails, clip(approach, 200)].slice(-50);
    });
  }

  /** Takes an area for this agent, or reports who holds it. Another agent's live claim is never overwritten. */
  claimArea(area: string): { claimed: boolean; heldBy?: string } {
    const a = area.trim();
    if (!a) throw new StoreError("area is empty");
    return this.store.write((d) => {
      const held = d.claims[a];
      if (held && held.agent !== this.agent && Date.parse(held.expires) > Date.now()) {
        return { claimed: false, heldBy: held.agent };
      }
      d.claims[a] = { agent: this.agent, since: now(), expires: new Date(Date.now() + this.cfg.claimMs).toISOString() };
      return { claimed: true };
    });
  }

  releaseArea(area: string): boolean {
    return this.store.write((d) => {
      const held = d.claims[area.trim()];
      if (!held || held.agent !== this.agent) return false;
      delete d.claims[area.trim()];
      return true;
    });
  }

  /** Ends the agent's session with a summary other agents read next. */
  saveSummary(input: SummaryInput): void {
    this.store.write((d) => {
      const s = this.openSession(d);
      s.title = clip(input.title, 200);
      s.accomplished = clip(input.accomplished, MAX_VALUE);
      s.learned = clip(input.learned ?? "", MAX_VALUE);
      s.decisions = clip(input.decisions ?? "", MAX_VALUE);
      s.next_steps = clip(input.next_steps ?? "", MAX_VALUE);
      s.status = "completed";
      s.ended_at = now();
      for (const [area, c] of Object.entries(d.claims)) if (c.agent === this.agent) delete d.claims[area];
    });
  }

  /** Passes unfinished work to the next agent: a checkpoint other agents see first in their brief. */
  handoff(to: string, note: string): void {
    this.saveContext(`handoff:${clip(to.trim() || "next-agent", 60)}`, note, ["handoff"]);
  }

  broadcast(message: string): void {
    this.store.write((d) => {
      d.broadcasts.push({ message: clip(message, 1000), agent: this.agent, timestamp: now() });
      d.broadcasts = d.broadcasts.slice(-50);
    });
  }

  /** Everything the store holds, for the hub to show. */
  snapshot(): ContextData {
    return this.store.read((d) => JSON.parse(JSON.stringify(d)) as ContextData);
  }

  private openSession(d: ContextData): SessionEntry {
    const stale = this.cfg.staleMs;
    for (const s of d.sessions) {
      if ((s.status === "active" || s.status === "checkpointed") && s.agent !== this.agent && Date.now() - Date.parse(s.heartbeat) > stale) {
        s.status = "interrupted";
        s.interrupted_at = now();
      }
    }
    const mine = [...d.sessions].reverse().find((s) => s.agent === this.agent && (s.status === "active" || s.status === "checkpointed"));
    if (mine) {
      mine.heartbeat = now();
      return mine;
    }
    const s: SessionEntry = {
      id: `${this.agent}-${Date.now().toString(36)}`,
      title: "", status: "active", accomplished: "", learned: "", decisions: "", next_steps: "",
      checkpoint: "", agent: this.agent, timestamp: now(), heartbeat: now(),
    };
    d.sessions.push(s);
    return s;
  }
}
