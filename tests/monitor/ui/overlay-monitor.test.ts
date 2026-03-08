// task-10: overlay monitor view render tests

// ─── Mocks for overlay-render.ts dependencies ────────────────────────────────
import { describe, it, expect, vi } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
  matchesKey: (_data: string, _key: string) => false,
}));

vi.mock("../../../lib.js", () => ({
  formatDuration: (ms: number) => `${ms}ms`,
  formatRelativeTime: (_t: string) => "just now",
  buildSelfRegistration: () => ({}),
  coloredAgentName: (name: string) => name,
  computeStatus: () => "idle",
  STATUS_INDICATORS: {},
  agentHasTask: () => false,
  estimateCost: () => 0,
  formatCost: () => "",
  renderProgressBar: () => "[]",
  getSpinnerFrame: () => "⠋",
  getToolIcon: () => "🔧",
  renderSparkline: () => "",
  renderFileTree: () => [],
  renderAgentPipeline: () => "",
  renderDiffStatsBar: () => "",
  extractFolder: (s: string) => s,
}));

vi.mock("../../../store.js", () => ({
  getActiveAgents: () => [],
  getClaims: () => ({}),
  getRegisteredAgents: () => [],
}));

vi.mock("../../../crew/store.js", () => ({
  getTasks: () => [],
  getTask: () => undefined,
  getPlan: () => null,
  getPlanLabel: () => "",
  getCrewDir: (cwd: string) => cwd,
  hasPlan: () => false,
  getReadyTasks: () => [],
}));

vi.mock("../../../crew/state.js", () => ({
  autonomousState: { concurrency: 1, waveNumber: 0, startedAt: null },
  getPlanningUpdateAgeMs: () => 0,
  isAutonomousForCwd: () => false,
  isPlanningForCwd: () => false,
  isPlanningStalled: () => false,
  planningState: { pass: 0, maxPasses: 5, phase: "idle", updatedAt: null },
  PLANNING_STALE_TIMEOUT_MS: 60000,
}));

vi.mock("../../../crew/live-progress.js", () => ({
  getLiveWorkers: () => new Map(),
  hasLiveWorkers: () => false,
}));

vi.mock("../../../feed.js", () => ({
  formatFeedLine: () => "",
}));

vi.mock("../../../crew/utils/discover.js", () => ({
  discoverCrewAgents: () => [],
}));

vi.mock("../../../config.js", () => ({
  loadConfig: () => ({ stuckThreshold: 300 }),
}));

vi.mock("../../../crew/utils/config.js", () => ({
  loadCrewConfig: () => ({
    coordination: "light",
    dependencies: "strict",
    concurrency: { max: 4 },
  }),
}));

vi.mock("../../../crew/utils/checkpoint.js", () => ({
  listCheckpoints: () => [],
  getCheckpointDiff: () => null,
}));

vi.mock("../../../crew/lobby.js", () => ({
  getLobbyWorkerCount: () => 0,
}));

// ─── Actual test imports ──────────────────────────────────────────────────────

import { renderAttentionQueue, renderMonitorView, renderMonitorDetailView } from "../../../overlay-render.js";
import type { CrewViewState } from "../../../overlay-actions.js";
import { MonitorRegistry } from "../../../src/monitor/registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeViewState(overrides?: Partial<CrewViewState>): CrewViewState {
  return {
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
    ...overrides,
  };
}

function makeRegistry(): MonitorRegistry {
  return new MonitorRegistry({ healthConfig: {} });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("renderMonitorView", () => {
  it("returns lines when registry is undefined", () => {
    const viewState = makeViewState();
    const lines = renderMonitorView(undefined, 80, 10, viewState);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("No monitor registry");
  });

  it("returns lines with empty sessions when registry has no sessions", () => {
    const registry = makeRegistry();
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 10, viewState);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("No active sessions");
  });

  it("renders session data when registry has sessions", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-test-1",
      name: "Test Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    });
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    expect(lines.length).toBeGreaterThan(0);
    // Should contain session info
    const combined = lines.join("\n");
    expect(combined).toBeTruthy();
    registry.dispose();
  });

  it("clamps monitorSelectedIndex to valid range", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-clamp",
      name: "Clamp Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    });
    const viewState = makeViewState({ monitorSelectedIndex: 999 });
    renderMonitorView(registry, 80, 10, viewState);
    // Should be clamped to 0 (only 1 session)
    expect(viewState.monitorSelectedIndex).toBe(0);
    registry.dispose();
  });

  it("paused session renders the attention queue panel", () => {
    const registry = makeRegistry();
    const startedAt = new Date().toISOString();
    const id = registry.lifecycle.start({
      id: "sess-paused",
      name: "Paused Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt,
      agent: "TestAgent",
    });
    registry.lifecycle.pause(id, "waiting for input");

    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    expect(lines.join("\n")).toContain("Attention Queue");
    registry.dispose();
  });

  it("error session renders the attention queue panel", () => {
    const registry = makeRegistry();
    const startedAt = new Date().toISOString();
    const id = registry.lifecycle.start({
      id: "sess-error",
      name: "Error Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt,
      agent: "TestAgent",
    });
    registry.lifecycle.escalate(id, "tool failure");

    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    expect(lines.join("\n")).toContain("Attention Queue");
    registry.dispose();
  });

  it("healthy session does not contain ⚠ Attention", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-healthy",
      name: "Healthy Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    });

    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    expect(lines.join("\n")).not.toContain("⚠ Attention");
    registry.dispose();
  });

  it("returns padded output for empty sessions", () => {
    const registry = makeRegistry();
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 15, viewState);

    expect(lines).toHaveLength(15);
    expect(lines.join("\n")).toContain("No active sessions");
    registry.dispose();
  });

  it("renders stable output height for one session", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-height",
      name: "Session Height",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    });

    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 15, viewState);

    expect(lines).toHaveLength(15);
    registry.dispose();
  });

  it("returns padded output with detail-like session rows", () => {
    const registry = makeRegistry();
    const id = registry.lifecycle.start({
      id: "sess-height-detail",
      name: "Session Detail",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    });

    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 15, viewState);

    expect(lines).toHaveLength(15);
    const text = lines.join("\n");
    expect(text).toContain("Session Detail");
    expect(text).toContain("Running");
    registry.dispose();
  });

  it("renders no sessions attention queue with exact padding", () => {
    const registry = makeRegistry();
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 15, viewState);

    expect(lines).toHaveLength(15);
    expect(lines.join("\n")).toContain("No active sessions");
    registry.dispose();
  });
});

describe("renderAttentionQueue", () => {
  it("returns no panel rows when no items are found", () => {
    const lines = renderAttentionQueue([], new Map(), 80, 10);

    expect(lines).toEqual([]);
  });

  it("renders a sample attention queue panel item", () => {
    const registry = makeRegistry();
    const startedAt = new Date().toISOString();
    const id = registry.lifecycle.start({
      id: "sess-attn-sample",
      name: "Sample Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt,
      agent: "TestAgent",
    });
    const session = registry.store.get(id);
    if (!session) {
      throw new Error("Session missing");
    }

    const sessions = [session];
    const healthMap = new Map<string, "healthy" | "degraded" | "critical">([
      [sessions[0].metadata.id, "degraded"],
    ]);

    const lines = renderAttentionQueue(sessions, healthMap, 100, 12, Date.parse(startedAt) + 35_000);
    const text = lines.join("\n");

    expect(text).toContain("Attention Queue");
    expect(text).toContain(sessions[0].metadata.id);
    registry.dispose();
  });
});

describe("renderMonitorDetailView", () => {
  it("returns lines when registry is undefined", () => {
    const viewState = makeViewState({ mode: "monitor-detail" });
    const lines = renderMonitorDetailView(undefined, 80, 10, viewState);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("No monitor registry");
  });

  it("returns fallback when session not found", () => {
    const registry = makeRegistry();
    const viewState = makeViewState({ mode: "monitor-detail", monitorSelectedIndex: 5 });
    const lines = renderMonitorDetailView(registry, 80, 10, viewState);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("Session not found");
    registry.dispose();
  });

  it("renders detail view for a real session", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-detail",
      name: "Detail Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "DetailAgent",
    });
    const viewState = makeViewState({ mode: "monitor-detail", monitorSelectedIndex: 0 });
    const lines = renderMonitorDetailView(registry, 80, 20, viewState);
    expect(lines.length).toBeGreaterThan(0);
    registry.dispose();
  });
});
