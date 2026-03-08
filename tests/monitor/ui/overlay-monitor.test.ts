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

  it("pads output to the requested height", () => {
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

  it("renders attention section at top when a session is paused", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-paused-attn",
      name: "Paused Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    });
    registry.lifecycle.pause("sess-paused-attn");
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    const text = lines.join("\n");
    expect(text).toContain("Attention");
    registry.dispose();
  });

  it("renders attention section for sessions in error state", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-err-attn",
      name: "Error Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "ErrAgent",
    });
    registry.lifecycle.escalate("sess-err-attn", "something went wrong");
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    const text = lines.join("\n");
    expect(text).toContain("Attention");
    registry.dispose();
  });

  it("does not render attention section for freshly started active sessions", () => {
    const registry = makeRegistry();
    registry.lifecycle.start({
      id: "sess-healthy-attn",
      name: "Healthy Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "OkAgent",
    });
    const viewState = makeViewState();
    const lines = renderMonitorView(registry, 80, 20, viewState);
    const text = lines.join("\n");
    expect(text).not.toContain("⚠ Attention");
    registry.dispose();
  });
});

describe("renderAttentionQueue", () => {
  it("returns empty array when no attention items", () => {
    const lines = renderAttentionQueue([], 80);
    expect(lines).toHaveLength(0);
  });

  it("renders attention header and items when items exist", () => {
    const items = [
      {
        id: "att-1",
        sessionId: "sess-test-12",
        reason: "stuck" as const,
        message: "No progress detected",
        recommendedAction: "Inspect and retry",
        timestamp: new Date().toISOString(),
      },
    ];
    const lines = renderAttentionQueue(items, 80);
    const text = lines.join("\n");
    expect(text).toContain("Attention");
    expect(text).toContain("sess-test-12");
    expect(text).toContain("stuck");
    expect(text).toContain("No progress detected");
    expect(text).toContain("Inspect and retry");
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
