import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: (data: string, key: string) => {
    if (key === "escape") return data === "\x1b";
    if (key === "enter") return data === "\r";
    if (key === "backspace") return data === "\x7f" || data === "\b";
    if (key === "tab") return data === "\t";
    if (key === "shift+tab") return data === "\x1b[Z";
    return false;
  },
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));

import { createCrewViewState, handleMessageInput, type CrewViewState } from "../overlay-actions.js";
import type { MessengerState, Dirs } from "../lib.js";
import type { TUI } from "@mariozechner/pi-tui";

vi.mock("../store.js", () => ({
  getActiveAgents: () => [
    { name: "coral-fox" },
    { name: "amber-wolf" },
    { name: "crimson-bear" },
  ],
  sendMessageToAgent: vi.fn(),
  getClaims: () => ({}),
}));

vi.mock("../crew/live-progress.js", () => ({
  getLiveWorkers: () => new Map([
    ["task-1", { name: "jade-elk", taskId: "task-1" }],
  ]),
  hasLiveWorkers: () => false,
  onLiveWorkersChanged: () => () => {},
}));

vi.mock("../feed.js", () => ({
  logFeedEvent: vi.fn(),
  readFeedEvents: () => [],
}));

vi.mock("../crew/registry.js", () => ({
  hasActiveWorker: () => false,
}));

function makeState(): MessengerState {
  return { agentName: "me", scopeToFolder: false } as MessengerState;
}

function makeDirs(): Dirs {
  return { base: "/tmp", registry: "/tmp/reg", inbox: "/tmp/inbox" } as Dirs;
}

function makeTui(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}

function sendTab(vs: CrewViewState, state: MessengerState, dirs: Dirs, tui: TUI) {
  handleMessageInput("\t", vs, state, dirs, "/tmp/cwd", tui);
}

function sendShiftTab(vs: CrewViewState, state: MessengerState, dirs: Dirs, tui: TUI) {
  handleMessageInput("\x1b[Z", vs, state, dirs, "/tmp/cwd", tui);
}

function type(char: string, vs: CrewViewState, state: MessengerState, dirs: Dirs, tui: TUI) {
  handleMessageInput(char, vs, state, dirs, "/tmp/cwd", tui);
}

describe("mention autocomplete", () => {
  let vs: CrewViewState;
  let state: MessengerState;
  let dirs: Dirs;
  let tui: TUI;

  beforeEach(() => {
    vs = createCrewViewState();
    vs.inputMode = "message";
    state = makeState();
    dirs = makeDirs();
    tui = makeTui();
  });

  it("tab completes first matching agent after @", () => {
    vs.messageInput = "@";
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toMatch(/^@\S+ $/);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    expect(vs.mentionIndex).toBe(0);
  });

  it("cycles through candidates on repeated tab", () => {
    vs.messageInput = "@";
    sendTab(vs, state, dirs, tui);
    const first = vs.messageInput;
    sendTab(vs, state, dirs, tui);
    const second = vs.messageInput;
    expect(second).not.toBe(first);
    expect(vs.mentionIndex).toBe(1);
  });

  it("shift+tab cycles backwards", () => {
    vs.messageInput = "@";
    sendTab(vs, state, dirs, tui);
    sendTab(vs, state, dirs, tui);
    const atTwo = vs.messageInput;
    sendShiftTab(vs, state, dirs, tui);
    const backOne = vs.messageInput;
    expect(vs.mentionIndex).toBe(0);
    expect(backOne).not.toBe(atTwo);
  });

  it("filters candidates by typed prefix", () => {
    vs.messageInput = "@cor";
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe("@coral-fox ");
  });

  it("includes live workers in candidates", () => {
    vs.messageInput = "@jade";
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe("@jade-elk ");
  });

  it("includes @all in candidates", () => {
    vs.messageInput = "@al";
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe("@all ");
  });

  it("does not complete when input has a space (message already started)", () => {
    vs.messageInput = "@coral-fox hey";
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe("@coral-fox hey");
  });

  it("resets candidates on backspace", () => {
    vs.messageInput = "@cor";
    sendTab(vs, state, dirs, tui);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    type("\b", vs, state, dirs, tui);
    expect(vs.mentionCandidates).toEqual([]);
    expect(vs.mentionIndex).toBe(-1);
  });

  it("resets candidates on new character typed", () => {
    vs.messageInput = "@";
    sendTab(vs, state, dirs, tui);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    type("x", vs, state, dirs, tui);
    expect(vs.mentionCandidates).toEqual([]);
  });

  it("wraps around at end of candidates list", () => {
    vs.messageInput = "@";
    sendTab(vs, state, dirs, tui);
    const count = vs.mentionCandidates.length;
    for (let i = 0; i < count; i++) sendTab(vs, state, dirs, tui);
    expect(vs.mentionIndex).toBe(0);
  });
});
