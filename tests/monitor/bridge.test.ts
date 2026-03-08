/**
 * tests/monitor/bridge.test.ts
 *
 * Tests for CrewMonitorBridge — verifies that the bridge correctly maps
 * live-worker events to monitor session lifecycle calls and event emissions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ─── Mock crew/live-progress module ──────────────────────────────────────────
// We intercept the module to control live-worker state in tests.

let mockListeners = new Set<() => void>();
let mockWorkers = new Map<string, import("../../crew/live-progress.js").LiveWorkerInfo>();

vi.mock("../../crew/live-progress.js", () => ({
  getLiveWorkers: vi.fn((cwd?: string) => {
    if (!cwd) return new Map(mockWorkers);
    const filtered = new Map<string, import("../../crew/live-progress.js").LiveWorkerInfo>();
    for (const [key, info] of mockWorkers) {
      if (info.cwd === cwd) {
        // filtered map keyed by taskId (matching the real implementation)
        filtered.set(info.taskId, info);
      }
    }
    return filtered;
  }),
  onLiveWorkersChanged: vi.fn((fn: () => void) => {
    mockListeners.add(fn);
    return () => mockListeners.delete(fn);
  }),
}));

// ─── Import after mock setup ──────────────────────────────────────────────────

import { CrewMonitorBridge, createCrewMonitorBridge } from "../../src/monitor/bridge.js";
import { SessionLifecycleManager } from "../../src/monitor/lifecycle/manager.js";
import { SessionEventEmitter } from "../../src/monitor/events/emitter.js";
import { SessionStore } from "../../src/monitor/store/session-store.js";
import { createMonitorRegistry } from "../../src/monitor/index.js";
import type { SessionEvent } from "../../src/monitor/events/types.js";
import type { LiveWorkerInfo } from "../../crew/live-progress.js";
import { getLiveWorkers, onLiveWorkersChanged } from "../../crew/live-progress.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorker(
  taskId: string,
  overrides: Partial<LiveWorkerInfo> = {},
): LiveWorkerInfo {
  return {
    cwd: "/tmp/test",
    taskId,
    agent: "TestAgent",
    name: `worker-${taskId}`,
    startedAt: Date.now(),
    progress: {
      agent: "TestAgent",
      status: "running",
      currentTool: undefined,
      recentTools: [],
      toolCallCount: 0,
      tokens: 0,
      durationMs: 0,
      filesModified: [],
      toolCallBuckets: [],
    },
    ...overrides,
  };
}

function workerKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

/** Trigger all registered listeners (simulates updateLiveWorker / removeLiveWorker) */
function notifyListeners(): void {
  for (const fn of mockListeners) fn();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CrewMonitorBridge", () => {
  let lifecycle: SessionLifecycleManager;
  let emitter: SessionEventEmitter;
  let store: SessionStore;
  let emittedEvents: SessionEvent[];

  beforeEach(() => {
    mockWorkers.clear();
    mockListeners.clear();
    vi.clearAllMocks();

    store = new SessionStore();
    emitter = new SessionEventEmitter();
    lifecycle = new SessionLifecycleManager(store, emitter);
    emittedEvents = [];
    emitter.subscribe((e) => emittedEvents.push(e));
  });

  afterEach(() => {
    mockWorkers.clear();
    mockListeners.clear();
  });

  // ─── Construction ────────────────────────────────────────────────────────

  it("subscribes to onLiveWorkersChanged on construction", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);
    expect(onLiveWorkersChanged).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("performs initial sync on construction — picks up pre-existing workers", () => {
    const worker = makeWorker("task-1");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);

    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    expect(bridge.sessionCount).toBe(1);
    const sessionId = bridge.getSessionId("task-1");
    expect(sessionId).toBeDefined();
    expect(store.get(sessionId!)?.status).toBe("active");

    bridge.dispose();
  });

  // ─── Worker Added ─────────────────────────────────────────────────────────

  it("creates a monitor session when a worker is added", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);
    expect(bridge.sessionCount).toBe(0);

    const worker = makeWorker("task-2");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    expect(bridge.sessionCount).toBe(1);
    const sessionId = bridge.getSessionId("task-2");
    expect(sessionId).toBeDefined();
    expect(store.get(sessionId!)?.status).toBe("active");

    bridge.dispose();
  });

  it("emits session.start event when a worker is added", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);
    emittedEvents = [];

    const worker = makeWorker("task-start");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    const startEvents = emittedEvents.filter((e) => e.type === "session.start");
    expect(startEvents).toHaveLength(1);

    bridge.dispose();
  });

  it("handles multiple workers being added", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const w1 = makeWorker("task-a");
    const w2 = makeWorker("task-b");
    mockWorkers.set(workerKey(w1.cwd, w1.taskId), w1);
    mockWorkers.set(workerKey(w2.cwd, w2.taskId), w2);
    notifyListeners();

    expect(bridge.sessionCount).toBe(2);

    bridge.dispose();
  });

  // ─── Worker Removed ───────────────────────────────────────────────────────

  it("ends monitor session when worker is removed", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-remove");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    const sessionId = bridge.getSessionId("task-remove")!;
    expect(store.get(sessionId)?.status).toBe("active");

    // Remove worker
    mockWorkers.delete(workerKey(worker.cwd, worker.taskId));
    notifyListeners();

    expect(store.get(sessionId)?.status).toBe("ended");
    expect(bridge.sessionCount).toBe(0);

    bridge.dispose();
  });

  it("emits session.end event when worker is removed", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-end-event");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();
    emittedEvents = []; // reset

    mockWorkers.delete(workerKey(worker.cwd, worker.taskId));
    notifyListeners();

    const endEvents = emittedEvents.filter((e) => e.type === "session.end");
    expect(endEvents).toHaveLength(1);

    bridge.dispose();
  });

  it("does not double-end a session if called twice for same worker removal", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-double-end");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    mockWorkers.delete(workerKey(worker.cwd, worker.taskId));
    notifyListeners();
    notifyListeners(); // second fire with same state — should be no-op

    const endEvents = emittedEvents.filter((e) => e.type === "session.end");
    expect(endEvents).toHaveLength(1);

    bridge.dispose();
  });

  // ─── Tool Change ──────────────────────────────────────────────────────────

  it("emits tool.call event when a worker's currentTool changes", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-tool");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();
    emittedEvents = []; // reset after session.start

    // Simulate tool execution starting
    worker.progress.currentTool = "bash";
    notifyListeners();

    const toolCallEvents = emittedEvents.filter((e) => e.type === "tool.call");
    expect(toolCallEvents).toHaveLength(1);
    expect((toolCallEvents[0].payload as { toolName: string }).toolName).toBe("bash");

    bridge.dispose();
  });

  it("emits multiple tool.call events for successive tool changes", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-multi-tool");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();
    emittedEvents = [];

    worker.progress.currentTool = "read";
    notifyListeners();

    worker.progress.currentTool = undefined;
    notifyListeners();

    worker.progress.currentTool = "write";
    notifyListeners();

    worker.progress.currentTool = "bash";
    notifyListeners();

    const toolCallEvents = emittedEvents.filter((e) => e.type === "tool.call");
    expect(toolCallEvents).toHaveLength(3); // read, write, bash
    const toolNames = toolCallEvents.map((e) => (e.payload as { toolName: string }).toolName);
    expect(toolNames).toEqual(["read", "write", "bash"]);

    bridge.dispose();
  });

  it("does NOT emit tool.call if currentTool remains the same", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-same-tool");
    worker.progress.currentTool = "bash";
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();
    emittedEvents = [];

    // Fire again with same tool — no new tool.call
    notifyListeners();
    notifyListeners();

    const toolCallEvents = emittedEvents.filter((e) => e.type === "tool.call");
    expect(toolCallEvents).toHaveLength(0);

    bridge.dispose();
  });

  it("emits tool.call immediately for a worker that already has an active tool on discovery", () => {
    const worker = makeWorker("task-pre-tool");
    worker.progress.currentTool = "grep";
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);

    emittedEvents = [];
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const toolCallEvents = emittedEvents.filter((e) => e.type === "tool.call");
    expect(toolCallEvents).toHaveLength(1);
    expect((toolCallEvents[0].payload as { toolName: string }).toolName).toBe("grep");

    bridge.dispose();
  });

  // ─── taskId → sessionId mapping ──────────────────────────────────────────

  it("getSessionId returns undefined for unknown taskId", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);
    expect(bridge.getSessionId("nonexistent")).toBeUndefined();
    bridge.dispose();
  });

  it("getSessionId resolves by cwd+taskId when cwd is provided", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    const worker = makeWorker("task-lookup");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    const sessionId = bridge.getSessionId("task-lookup", worker.cwd);
    expect(sessionId).toBeDefined();

    bridge.dispose();
  });

  // ─── dispose() ────────────────────────────────────────────────────────────

  it("dispose() prevents further syncs after being called", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);

    bridge.dispose();

    // Adding workers after disposal should have no effect
    const worker = makeWorker("task-after-dispose");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    expect(bridge.sessionCount).toBe(0);
  });

  it("dispose() removes listener from onLiveWorkersChanged", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);
    expect(mockListeners.size).toBe(1);

    bridge.dispose();
    expect(mockListeners.size).toBe(0);
  });

  it("dispose() is idempotent", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter);
    bridge.dispose();
    expect(() => bridge.dispose()).not.toThrow();
  });

  // ─── MonitorRegistry integration ──────────────────────────────────────────

  it("accepts a MonitorRegistry and wires lifecycle+emitter from it", () => {
    const registry = createMonitorRegistry();
    const bridge = createCrewMonitorBridge(registry);

    const worker = makeWorker("task-registry");
    mockWorkers.set(workerKey(worker.cwd, worker.taskId), worker);
    notifyListeners();

    expect(bridge.sessionCount).toBe(1);
    const sessionId = bridge.getSessionId("task-registry");
    expect(sessionId).toBeDefined();
    expect(registry.store.get(sessionId!)?.status).toBe("active");

    bridge.dispose();
    registry.dispose();
  });

  // ─── cwd filtering ────────────────────────────────────────────────────────

  it("filters workers by cwd when cwd option is provided", () => {
    const bridge = new CrewMonitorBridge(lifecycle, emitter, { cwd: "/tmp/project-a" });

    const wA = makeWorker("task-cwd-a", { cwd: "/tmp/project-a" });
    const wB = makeWorker("task-cwd-b", { cwd: "/tmp/project-b" });
    mockWorkers.set(workerKey(wA.cwd, wA.taskId), wA);
    mockWorkers.set(workerKey(wB.cwd, wB.taskId), wB);
    notifyListeners();

    // Only task-cwd-a should be tracked
    expect(bridge.sessionCount).toBe(1);
    expect(bridge.getSessionId("task-cwd-a", "/tmp/project-a")).toBeDefined();

    bridge.dispose();
  });
});
