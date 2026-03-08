// Tests for handleMonitorDetailKeyBinding, handleConfirmInput (end-session), and renderLegend monitor-detail mode

// ─── Mocks for overlay-actions.ts / overlay-render.ts dependencies ───────────
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
  matchesKey: (data: string, key: string) => data === key,
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
  cancelPlanningRun: () => {},
}));

vi.mock("../../../crew/live-progress.js", () => ({
  getLiveWorkers: () => new Map(),
  hasLiveWorkers: () => false,
}));

vi.mock("../../../feed.js", () => ({
  formatFeedLine: () => "",
  logFeedEvent: () => {},
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
  restoreCheckpoint: () => false,
}));

vi.mock("../../../crew/lobby.js", () => ({
  getLobbyWorkerCount: () => 0,
}));

vi.mock("../../../crew/registry.js", () => ({
  hasActiveWorker: () => false,
}));

vi.mock("../../../crew/task-actions.js", () => ({
  executeTaskAction: () => ({ success: true, message: "ok" }),
}));

// ─── Actual test imports ──────────────────────────────────────────────────────

import { handleMonitorDetailKeyBinding, handleConfirmInput, type CrewViewState } from "../../../overlay-actions.js";
import { renderLegend } from "../../../overlay-render.js";
import { MonitorRegistry } from "../../../src/monitor/registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeViewState(overrides?: Partial<CrewViewState>): CrewViewState {
  return {
    scrollOffset: 0,
    selectedTaskIndex: 0,
    mode: "monitor-detail",
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

function makeTUI() {
  return {
    requestRender: vi.fn(),
  } as any;
}

function makeRegistry() {
  const registry = new MonitorRegistry({ healthConfig: {} });
  return registry;
}

function makeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  } as any;
}

function startSession(registry: MonitorRegistry, id: string, name: string) {
  registry.lifecycle.start({
    id,
    name,
    cwd: "/tmp",
    model: "claude-3",
    startedAt: new Date().toISOString(),
    agent: "TestAgent",
  });
  return id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleMonitorDetailKeyBinding", () => {
  let registry: MonitorRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("1. 'p' on active session → calls pause", () => {
    const sessionId = startSession(registry, "sess-active", "Active Session");
    // session starts as "active"
    const viewState = makeViewState({ monitorSelectedIndex: 0 });
    const tui = makeTUI();

    // spy on commandHandler.execute
    const executeSpy = vi.spyOn(registry.commandHandler, "execute");
    executeSpy.mockReturnValue({ success: true });

    handleMonitorDetailKeyBinding("p", viewState, registry, tui);

    expect(executeSpy).toHaveBeenCalledWith({ action: "pause", sessionId });
    expect(tui.requestRender).toHaveBeenCalled();
    expect(viewState.notification?.message).toContain("paused");

    registry.dispose();
  });

  it("2. 'p' on paused session → calls resume", () => {
    const sessionId = startSession(registry, "sess-paused", "Paused Session");
    // Pause it first
    registry.commandHandler.execute({ action: "pause", sessionId });

    const viewState = makeViewState({ monitorSelectedIndex: 0 });
    const tui = makeTUI();

    const executeSpy = vi.spyOn(registry.commandHandler, "execute");
    executeSpy.mockReturnValue({ success: true });

    handleMonitorDetailKeyBinding("p", viewState, registry, tui);

    expect(executeSpy).toHaveBeenCalledWith({ action: "resume", sessionId });
    expect(viewState.notification?.message).toContain("resumed");

    registry.dispose();
  });

  it("3. 'p' on ended session → shows error notification", () => {
    const sessionId = startSession(registry, "sess-ended", "Ended Session");
    registry.commandHandler.execute({ action: "end", sessionId });

    const viewState = makeViewState({ monitorSelectedIndex: 0 });
    const tui = makeTUI();

    handleMonitorDetailKeyBinding("p", viewState, registry, tui);

    expect(viewState.notification?.message).toContain("ended");
    expect(tui.requestRender).toHaveBeenCalled();

    registry.dispose();
  });

  it("4. 'e' on active session → sets confirmAction to 'end-session'", () => {
    startSession(registry, "sess-for-end", "End Me");
    const viewState = makeViewState({ monitorSelectedIndex: 0 });
    const tui = makeTUI();

    handleMonitorDetailKeyBinding("e", viewState, registry, tui);

    expect(viewState.confirmAction).not.toBeNull();
    expect(viewState.confirmAction?.type).toBe("end-session");
    expect(viewState.confirmAction?.taskId).toBe("sess-for-end");
    expect(viewState.confirmAction?.label).toBe("End Me");

    registry.dispose();
  });

  it("5. 'e' on ended session → shows 'already ended' notification", () => {
    const sessionId = startSession(registry, "sess-already-ended", "Already Ended");
    registry.commandHandler.execute({ action: "end", sessionId });

    const viewState = makeViewState({ monitorSelectedIndex: 0 });
    const tui = makeTUI();

    handleMonitorDetailKeyBinding("e", viewState, registry, tui);

    expect(viewState.confirmAction).toBeNull();
    expect(viewState.notification?.message).toContain("already ended");

    registry.dispose();
  });

  it("6. 'i' → calls inspect and shows notification", () => {
    const sessionId = startSession(registry, "sess-inspect", "Inspect Me");
    const viewState = makeViewState({ monitorSelectedIndex: 0 });
    const tui = makeTUI();

    const executeSpy = vi.spyOn(registry.commandHandler, "execute");
    executeSpy.mockReturnValue({ success: true });

    handleMonitorDetailKeyBinding("i", viewState, registry, tui);

    expect(executeSpy).toHaveBeenCalledWith({ action: "inspect", sessionId });
    expect(viewState.notification?.message).toContain("Inspect:");
    expect(tui.requestRender).toHaveBeenCalled();

    registry.dispose();
  });
});

describe("handleConfirmInput (end-session)", () => {
  let registry: MonitorRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("7. 'y' with end-session confirmAction → calls registry.commandHandler.execute end", () => {
    startSession(registry, "sess-confirm-end", "Confirm End");
    const viewState = makeViewState({
      confirmAction: {
        type: "end-session",
        taskId: "sess-confirm-end",
        label: "Confirm End",
      },
    });
    const tui = makeTUI();

    const executeSpy = vi.spyOn(registry.commandHandler, "execute");
    executeSpy.mockReturnValue({ success: true });

    handleConfirmInput("y", viewState, "/tmp", "TestAgent", tui, registry);

    expect(executeSpy).toHaveBeenCalledWith({ action: "end", sessionId: "sess-confirm-end" });
    expect(viewState.confirmAction).toBeNull();
    expect(viewState.notification?.message).toContain("ended");

    registry.dispose();
  });

  it("8. 'n' with end-session confirmAction → clears confirmAction", () => {
    const viewState = makeViewState({
      confirmAction: {
        type: "end-session",
        taskId: "sess-cancel",
        label: "Cancel End",
      },
    });
    const tui = makeTUI();

    handleConfirmInput("n", viewState, "/tmp", "TestAgent", tui, registry);

    expect(viewState.confirmAction).toBeNull();
    expect(tui.requestRender).toHaveBeenCalled();

    registry.dispose();
  });
});

describe("renderLegend in monitor-detail mode", () => {
  let registry: MonitorRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("9. without confirmAction → shows p/e/i hints", () => {
    startSession(registry, "sess-legend", "Legend Session");
    const viewState = makeViewState({
      mode: "monitor-detail",
      monitorSelectedIndex: 0,
      confirmAction: null,
    });
    const theme = makeTheme();

    const result = renderLegend(theme, "/tmp", 200, viewState, null, false, registry);

    expect(result).toContain("p:Pause");
    expect(result).toContain("e:End");
    expect(result).toContain("i:Inspect");
    expect(result).toContain("Esc:Back");

    registry.dispose();
  });

  it("10. with end-session confirmAction → shows confirm bar", () => {
    startSession(registry, "sess-legend-confirm", "Legend Confirm");
    const viewState = makeViewState({
      mode: "monitor-detail",
      monitorSelectedIndex: 0,
      confirmAction: {
        type: "end-session",
        taskId: "sess-legend-confirm",
        label: "Legend Confirm",
      },
    });
    const theme = makeTheme();

    const result = renderLegend(theme, "/tmp", 200, viewState, null, false, registry);

    expect(result).toContain("End session");
    expect(result).toContain("[y] Confirm");
    expect(result).toContain("[n] Cancel");

    registry.dispose();
  });
});
