/**
 * groupTimeline — the Workspace as a group chat.
 * ==================================================================
 * One ordered list of what happened, built from two real sources: the
 * conversation's messages (you, and the CEO's replies) and the session's
 * event frames (each worker's task, its state, and its live output). Pure:
 * no React, no network, so the rules are tested directly.
 *
 * Each run is grouped under the user message that started it, so a worker's
 * card appears between your message and the CEO's reply, the way a group
 * chat shows members talking in between.
 */

import type { AgentEventFrame } from "./centralAgentClient";
import type { AgentChatMessage } from "./useAgentConversations";

/** A worker's output line is kept only this long; older lines are dropped. */
export const MAX_TERMINAL_LINES = 400;

export interface TerminalLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface TaskCard {
  kind: "task";
  id: string;
  taskId: string;
  sessionId: string;
  worker: string | null;
  /** What the step is (`agent.delegate`, `web.research`, …). Only a coding agent is a group member. */
  capability: string | null;
  /** The brief the worker was given (the task's own description). */
  brief: string | null;
  state: string;
  verified: boolean | null;
  detail: string | null;
  lines: TerminalLine[];
  at: string;
}

export type TimelineItem =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "ceo"; id: string; text: string; status: AgentChatMessage["status"]; error: string | null; at: string }
  | { kind: "status"; id: string; text: string; at: string }
  | TaskCard;

/** States that mean a worker is still doing something. */
const ACTIVE_STATES = new Set(["running", "queued", "pending", "dispatched"]);

export function isWorking(items: TimelineItem[]): boolean {
  return items.some((i) => i.kind === "task" && ACTIVE_STATES.has(i.state));
}

/** A human line for the status bar that is always on screen while work runs. */
export function statusLine(items: TimelineItem[], streaming: boolean): string {
  const tasks = items.filter((i): i is TaskCard => i.kind === "task");
  if (tasks.length === 0) return streaming ? "The CEO is thinking…" : "";
  const active = tasks.filter((t) => ACTIVE_STATES.has(t.state));
  if (active.length > 0) {
    const names = [...new Set(active.map((t) => t.worker ?? "a worker"))].join(", ");
    return `${names} ${active.length === 1 ? "is" : "are"} working · ${tasks.length} task${tasks.length === 1 ? "" : "s"} in this request`;
  }
  return streaming ? "The CEO is reviewing the result…" : "";
}

/** Terminal colour codes mean nothing in the chat. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

const WORKER_NAMES: Record<string, string> = {
  opencode: "OpenCode", "kilo-code": "Kilo Code", kilo: "Kilo Code", "claude-code": "Claude Code",
  "codex-cli": "Codex CLI", codex: "Codex CLI", "qwen-cli": "Qwen Code", qwen: "Qwen Code", "gemini-cli": "Gemini CLI",
};

/** A worker's name as a person says it (`kilo-code` is Kilo Code). Unknown ids pass through. */
export function workerName(id: string | null): string | null {
  return id ? (WORKER_NAMES[id.toLowerCase()] ?? id) : null;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Build the timeline. `frames` are every event frame seen so far (any
 * session); only frames of a session that a message refers to are used.
 */
export function buildGroupTimeline(messages: AgentChatMessage[], frames: AgentEventFrame[]): TimelineItem[] {
  // Each session's events in the order they arrived: a worker card appears at
  // its first event, and the CEO's lines and status lines are placed as they happen.
  let sayCount = 0;
  const cards = new Map<string, TaskCard>();          // key: sessionId|taskId
  const bySession = new Map<string, TimelineItem[]>();
  const pushTo = (sessionId: string, item: TimelineItem) => {
    const list = bySession.get(sessionId) ?? [];
    list.push(item);
    bySession.set(sessionId, list);
  };

  const cardFor = (sessionId: string, taskId: string, at: string): TaskCard => {
    const key = `${sessionId}|${taskId}`;
    let card = cards.get(key);
    if (!card) {
      card = {
        kind: "task", id: `task:${key}`, taskId, sessionId, worker: null, capability: null, brief: null,
        state: "queued", verified: null, detail: null, lines: [], at,
      };
      cards.set(key, card);
      pushTo(sessionId, card);
    }
    return card;
  };

  for (const f of frames) {
    const p = f.payload ?? {};
    const taskId = asText(p.taskId);
    if (f.type === "task.state" && taskId) {
      const card = cardFor(f.sessionId, taskId, f.at);
      card.state = asText(p.state) ?? card.state;
      card.worker = workerName(asText(p.worker)) ?? card.worker;
      card.capability = asText(p.capability) ?? card.capability;
      card.brief = asText(p.description) ?? card.brief;
      if (typeof p.verified === "boolean") card.verified = p.verified;
      card.detail = asText(p.detail) ?? card.detail;
    } else if (f.type === "task.output" && taskId) {
      const card = cardFor(f.sessionId, taskId, f.at);
      if (p.stream === "prompt") {
        // The exact prompt the worker was given replaces the one-line label as the card's brief.
        card.brief = asText(p.line) ?? card.brief;
        continue;
      }
      const stream = p.stream === "stderr" ? "stderr" : "stdout";
      card.lines.push({ stream, text: stripAnsi(String(p.line ?? "")) });
      if (card.lines.length > MAX_TERMINAL_LINES) card.lines.splice(0, card.lines.length - MAX_TERMINAL_LINES);
    } else if (f.type === "ceo.say") {
      const text = asText(p.text);
      if (text) {
        const say: TimelineItem = {
          kind: "ceo", id: `say:${f.sessionId}:${f.seq ?? f.at}:${sayCount++}`, text,
          status: "done", error: null, at: f.at,
        };
        // The CEO announces a step before the worker's card: an assignment or a choice lands just
        // ahead of the card it is about, even though the card's first event arrived a moment sooner.
        const about = taskId ? cards.get(`${f.sessionId}|${taskId}`) : undefined;
        const kind = asText(p.kind);
        const list = bySession.get(f.sessionId);
        const at = about && list && (kind === "assignment" || kind === "selection") ? list.indexOf(about) : -1;
        if (at >= 0 && list) list.splice(at, 0, say);
        else pushTo(f.sessionId, say);
      }
    } else if (f.type === "verification.started" || f.type === "verification.completed") {
      pushTo(f.sessionId, {
        kind: "status", id: `status:${f.sessionId}:${f.at}:${f.type}`, at: f.at,
        text: f.type === "verification.started" ? "The CEO is checking the work" : "The CEO finished checking the work",
      });
    }
  }

  const out: TimelineItem[] = [];
  const placed = new Set<string>();
  const placeSession = (sessionId: string) => {
    if (placed.has(sessionId)) return;
    placed.add(sessionId);
    for (const item of bySession.get(sessionId) ?? []) out.push(item);
  };

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ kind: "user", id: `user:${m.id}`, text: m.content, at: "" });
      continue;
    }
    const sid = m.agent?.sessionId ?? null;
    if (sid) placeSession(sid);
    out.push({
      kind: "ceo", id: `ceo:${m.id}`, text: m.content, status: m.status,
      error: m.error ?? null, at: "",
    });
  }
  // Work whose reply has not arrived yet (still running) goes at the end.
  for (const sid of bySession.keys()) placeSession(sid);
  return out;
}
