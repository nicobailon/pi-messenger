import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: (data: string, key: string) => {
    if (key === "enter") return data === "\r" || data === "\n";
    if (key === "up") return data === "up";
    if (key === "down") return data === "down";
    if (key === "left") return data === "left";
    if (key === "right") return data === "right";
    if (key === "home") return data === "home";
    if (key === "end") return data === "end";
    if (key === "escape") return data === "escape";
    if (key === "=") return data === "=";
    if (key === "shift+=") return data === "+";
    return data === key;
  },
  visibleWidth: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length,
  truncateToWidth: (s: string, width: number) => s.slice(0, width),
}));
import { MessengerOverlay } from "../../../overlay.js";
import { renderMonitorView } from "../../../overlay-render.js";
import type { Dirs, MessengerState } from "../../../lib.js";
import { MonitorRegistry } from "../../../src/monitor/registry.js";

function makeRegistry(): MonitorRegistry {
  return new MonitorRegistry({ healthConfig: {} });
}

function makeState(): MessengerState {
  return {
    agentName: "Dyson",
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "anthropic/claude-sonnet-4",
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };
}

function makeDirs(): Dirs {
  return {
    base: "/tmp/pi-messenger-test",
    registry: "/tmp/pi-messenger-test/registry",
    inbox: "/tmp/pi-messenger-test/inbox",
  };
}

function makeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
}

function makeTui() {
  return {
    requestRender() {},
  };
}

describe("overlay monitor attention wiring", () => {
  it("renders the attention queue panel above the session list when actionable items exist", () => {
    const registry = makeRegistry();

    registry.lifecycle.start({
      id: "sess-running",
      name: "Running Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "WorkerA",
    });

    const pausedId = registry.lifecycle.start({
      id: "sess-paused",
      name: "Paused Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "WorkerB",
    });
    registry.lifecycle.pause(pausedId, "waiting for operator input");

    const viewState = {
      scrollOffset: 0,
      selectedTaskIndex: 0,
      mode: "monitor",
      detailScroll: 0,
      detailAutoScroll: true,
      confirmAction: null,
      blockReasonInput: "",
      messageInput: "",
      inputMode: "normal",
      reviseScope: "single",
      revisePromptInput: "",
      lastSeenEventTs: null,
      notification: null,
      notificationTimer: null,
      feedFocus: false,
      mentionCandidates: [],
      mentionIndex: -1,
      scrollLocked: false,
      monitorSelectedIndex: 0,
      monitorDetailScroll: 0,
    } as const;

    const lines = renderMonitorView(registry, 100, 30, { ...viewState });
    const text = lines.join("\n");

    expect(text).toContain("Attention");
    expect(text).toContain("sess-paused");
    expect(text.indexOf("Attention")).toBeLessThan(text.indexOf("Running"));

    registry.dispose();
  });

  it("selecting an attention item opens the matching session detail view", () => {
    const registry = makeRegistry();

    registry.lifecycle.start({
      id: "sess-running",
      name: "Running Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "WorkerA",
    });

    const pausedId = registry.lifecycle.start({
      id: "sess-paused",
      name: "Paused Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "WorkerB",
    });
    registry.lifecycle.pause(pausedId, "waiting for operator input");

    const overlay = new MessengerOverlay(
      makeTui() as any,
      makeTheme() as any,
      makeState(),
      makeDirs(),
      () => {},
      {},
      registry,
    );

    (overlay as any).crewViewState.mode = "monitor";
    overlay.render(100);
    overlay.handleInput("\r");

    const crewViewState = (overlay as any).crewViewState;
    expect(crewViewState.mode).toBe("monitor-detail");
    expect(crewViewState.monitorSelectedIndex).toBe(1);

    overlay.dispose();
    registry.dispose();
  });
});
