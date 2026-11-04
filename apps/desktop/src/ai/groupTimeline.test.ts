import { describe, expect, it } from "vitest";
import { buildGroupTimeline, isWorking, statusLine, MAX_TERMINAL_LINES } from "./groupTimeline";
import type { AgentEventFrame } from "./centralAgentClient";
import type { AgentChatMessage } from "./useAgentConversations";

const msg = (id: string, role: "user" | "assistant", content: string, sid?: string, status: AgentChatMessage["status"] = "done"): AgentChatMessage =>
  ({ id, role, content, status, ...(sid ? { agent: { sessionId: sid } } : {}) }) as unknown as AgentChatMessage;
const frame = (type: string, sessionId: string, payload: Record<string, unknown>, at = "t"): AgentEventFrame =>
  ({ type, sessionId, at, payload }) as AgentEventFrame;

describe("buildGroupTimeline", () => {
  it("puts a run's worker cards between the user's message and the CEO's reply", () => {
    const items = buildGroupTimeline(
      [msg("u1", "user", "make a dress shop site"), msg("a1", "assistant", "Done.", "s1")],
      [
        frame("task.state", "s1", { taskId: "t1", state: "running", worker: "OpenCode", description: "build the front end" }),
        frame("task.output", "s1", { taskId: "t1", stream: "stdout", line: "writing index.html" }),
      ],
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "task", "ceo"]);
    const card = items[1] as Extract<typeof items[number], { kind: "task" }>;
    expect(card.worker).toBe("OpenCode");
    expect(card.brief).toBe("build the front end");
    expect(card.lines).toEqual([{ stream: "stdout", text: "writing index.html" }]);
  });

  it("shows a running run's cards at the end while its reply is still pending", () => {
    const items = buildGroupTimeline(
      [msg("u1", "user", "go")],
      [frame("task.state", "s2", { taskId: "t9", state: "running", worker: "Kilo Code" })],
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "task"]);
    expect(isWorking(items)).toBe(true);
    expect(statusLine(items, true)).toContain("Kilo Code is working");
  });

  it("keeps only the newest terminal lines", () => {
    const frames = Array.from({ length: MAX_TERMINAL_LINES + 25 }, (_, i) =>
      frame("task.output", "s1", { taskId: "t1", stream: "stdout", line: `l${i}` }));
    const items = buildGroupTimeline([msg("a1", "assistant", "x", "s1")], frames);
    const card = items.find((i) => i.kind === "task") as Extract<typeof items[number], { kind: "task" }>;
    expect(card.lines.length).toBe(MAX_TERMINAL_LINES);
    expect(card.lines[card.lines.length - 1].text).toBe(`l${MAX_TERMINAL_LINES + 24}`);
  });

  it("ignores events for unknown kinds and malformed payloads without failing", () => {
    const items = buildGroupTimeline([msg("u1", "user", "hi")], [
      frame("something.else", "s1", {}),
      frame("task.state", "s1", { state: "running" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user"]);
  });
});

describe("CEO lines and order", () => {
  it("places the CEO's assignment and hand-off in arrival order around the worker card", () => {
    const items = buildGroupTimeline([msg("u1", "user", "build a shop")], [
      frame("ceo.say", "s1", { kind: "assignment", text: "Next step: build the front end" }),
      frame("task.state", "s1", { taskId: "t1", state: "running", worker: "OpenCode", description: "build the front end" }),
      frame("task.output", "s1", { taskId: "t1", stream: "stdout", line: "writing" }),
      frame("ceo.say", "s1", { kind: "handoff", text: "OpenCode finished the step." }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "ceo", "task", "ceo"]);
    expect((items[1] as { text: string }).text).toBe("Next step: build the front end");
    expect((items[3] as { text: string }).text).toBe("OpenCode finished the step.");
  });
});


describe("the worker's prompt", () => {
  it("replaces the one-line label as the card's brief and is not a terminal line", () => {
    const items = buildGroupTimeline([msg("u1", "user", "go")], [
      frame("task.state", "s1", { taskId: "t1", state: "running", worker: "OpenCode", description: "Carry out the requested change" }),
      frame("task.output", "s1", { taskId: "t1", stream: "prompt", line: "You are the implementer.\nTask: add a contact form" }),
      frame("task.output", "s1", { taskId: "t1", stream: "stdout", line: "writing index.html" }),
    ]);
    const card = items.find((i) => i.kind === "task") as Extract<typeof items[number], { kind: "task" }>;
    expect(card.brief).toBe("You are the implementer.\nTask: add a contact form");
    expect(card.lines).toEqual([{ stream: "stdout", text: "writing index.html" }]);
  });
});


describe("terminal lines", () => {
  it("drop terminal colour codes", () => {
    const items = buildGroupTimeline([msg("a1", "assistant", "x", "s1")], [
      frame("task.output", "s1", { taskId: "t1", stream: "stdout", line: "\u001b[0m> build \u00b7 beam-free\u001b[0m" }),
    ]);
    const card = items.find((i) => i.kind === "task") as Extract<typeof items[number], { kind: "task" }>;
    expect(card.lines[0].text).toBe("> build \u00b7 beam-free");
  });
});


describe("order and labels", () => {
  it("puts the CEO's assignment and choice just before the card they are about", () => {
    const items = buildGroupTimeline([msg("u1", "user", "go")], [
      frame("task.state", "s1", { taskId: "t1", state: "running", capability: "agent.delegate" }),
      frame("ceo.say", "s1", { taskId: "t1", kind: "assignment", text: "Next step: add a footer" }),
      frame("ceo.say", "s1", { taskId: "t1", kind: "selection", text: "This is a small edit, so OpenCode takes it by default." }),
      frame("task.state", "s1", { taskId: "t1", state: "verified", worker: "OpenCode" }),
      frame("ceo.say", "s1", { taskId: "t1", kind: "handoff", text: "OpenCode finished the step." }),
    ]);
    expect(items.map((i) => (i.kind === "ceo" ? i.text.slice(0, 12) : i.kind))).toEqual([
      "user", "Next step: a", "This is a sm", "task", "OpenCode fin",
    ]);
  });

  it("keeps the capability of a step so a search is not shown as an agent", () => {
    const items = buildGroupTimeline([msg("u1", "user", "go")], [
      frame("task.state", "s1", { taskId: "r", state: "running", capability: "web.research" }),
    ]);
    const card = items.find((i) => i.kind === "task") as Extract<typeof items[number], { kind: "task" }>;
    expect(card.capability).toBe("web.research");
    expect(card.worker).toBeNull();
  });
});
