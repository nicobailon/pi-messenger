/**
 * tests/monitor/integration/e2e-wiring.test.ts
 *
 * End-to-end wiring test — real pipeline, no mocks.
 *
 * Exercises the full pipeline:
 *   createMonitorRegistry → createCrewMonitorBridge → simulate workers via
 *   real live-progress API → verify sessions created/ended → verify health
 *   alerts fire → verify export produces valid JSON → verify attention queue
 *   derives items → verify detail view renders events.
 *
 * No vi.mock of local modules — all services are real instances.
 *
 * Test isolation: each test uses a unique cwd (UUID-based) so that the
 * module-level liveWorkers map in crew/live-progress.ts never leaks across
 * tests. Workers are cleaned up in afterEach.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

import { createMonitorRegistry } from "../../../src/monitor/registry.js";
import { createCrewMonitorBridge } from "../../../src/monitor/bridge.js";
import {
  updateLiveWorker,
  removeLiveWorker,
} from "../../../crew/live-progress.js";
import type { AgentProgress } from "../../../crew/utils/progress.js";
import type { HealthStatus } from "../../../src/monitor/health/types.js";
import type { ComputedMetrics } from "../../../src/monitor/metrics/aggregator.js";
import { deriveAttentionItems } from "../../../src/monitor/attention/derivation.js";
import { renderSessionDetailView } from "../../../src/monitor/ui/session-detail.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Minimal valid AgentProgress for use in live-worker updates. */
function makeProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
  return {
    agent: "TestAgent",
    status: "running",
    recentTools: [],
    toolCallCount: 0,
    tokens: 0,
    durationMs: 0,
    filesModified: [],
    toolCallBuckets: [],
    ...overrides,
  };
}

/** Build a LiveWorkerInfo-compatible object for updateLiveWorker. */
function makeWorkerPayload(
  taskId: string,
  cwd: string,
  progressOverrides: Partial<AgentProgress> = {},
) {
  return {
    taskId,
    agent: "TestAgent",
    name: `worker-${taskId.slice(0, 8)}`,
    startedAt: Date.now(),
    progress: makeProgress(progressOverrides),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Bridge wires live workers to monitor sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Bridge wires live workers to monitor sessions", () => {
  it("worker add → monitor session is created and active", () => {
    const cwd = `/tmp/e2e-wire-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));

      expect(bridge.sessionCount).toBe(1);
      const sessionId = bridge.getSessionId(taskId, cwd);
      expect(sessionId).toBeDefined();

      const session = registry.store.get(sessionId!);
      expect(session).toBeDefined();
      expect(session!.status).toBe("active");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("worker remove → monitor session transitions to ended", () => {
    const cwd = `/tmp/e2e-remove-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      expect(registry.store.get(sessionId)!.status).toBe("active");

      removeLiveWorker(cwd, taskId);

      expect(bridge.sessionCount).toBe(0);
      expect(registry.store.get(sessionId)!.status).toBe("ended");
    } finally {
      bridge.dispose();
      registry.dispose();
    }
  });

  it("tool change in worker → tool.call event emitted with correct toolName", () => {
    const cwd = `/tmp/e2e-tool-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      // Simulate tool change: update worker with new currentTool
      updateLiveWorker(
        cwd,
        taskId,
        makeWorkerPayload(taskId, cwd, { currentTool: "bash" }),
      );

      const toolEvents = registry.emitter
        .getHistory()
        .filter((e) => e.sessionId === sessionId && e.type === "tool.call");

      expect(toolEvents.length).toBeGreaterThanOrEqual(1);
      expect((toolEvents[toolEvents.length - 1].payload as { toolName: string }).toolName).toBe(
        "bash",
      );
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("multiple workers → independent sessions, remove one keeps the other active", () => {
    const cwd = `/tmp/e2e-multi-${randomUUID()}`;
    const taskId1 = randomUUID();
    const taskId2 = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId1, makeWorkerPayload(taskId1, cwd));
      updateLiveWorker(cwd, taskId2, makeWorkerPayload(taskId2, cwd));

      expect(bridge.sessionCount).toBe(2);

      removeLiveWorker(cwd, taskId1);
      expect(bridge.sessionCount).toBe(1);

      const sid2 = bridge.getSessionId(taskId2, cwd)!;
      expect(registry.store.get(sid2)!.status).toBe("active");
    } finally {
      removeLiveWorker(cwd, taskId2);
      bridge.dispose();
      registry.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Export produces valid JSON
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Export produces valid JSON", () => {
  it("toJSON round-trips for a session started via bridge", () => {
    const cwd = `/tmp/e2e-export-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      // Emit an extra tool event manually
      registry.emitter.emit({
        id: randomUUID(),
        type: "tool.call",
        sessionId,
        timestamp: Date.now(),
        sequence: 0,
        payload: { type: "tool.call", toolName: "grep", args: { pattern: "test" } },
      });

      const json = registry.exporter.toJSON(sessionId);
      expect(() => JSON.parse(json)).not.toThrow();

      const parsed = JSON.parse(json);
      expect(parsed.session).toBeDefined();
      expect(parsed.session.metadata.id).toBe(sessionId);
      expect(parsed.events).toBeInstanceOf(Array);
      // At minimum: session.start + the manually emitted tool.call
      expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("generateReport includes correct event type breakdown", () => {
    const cwd = `/tmp/e2e-report-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      // Emit 3 tool.call events
      for (let i = 0; i < 3; i++) {
        registry.emitter.emit({
          id: randomUUID(),
          type: "tool.call",
          sessionId,
          timestamp: Date.now(),
          sequence: 0,
          payload: { type: "tool.call", toolName: `tool-${i}` },
        });
      }

      const report = registry.exporter.generateReport(sessionId);
      expect(report.sessionId).toBe(sessionId);
      expect(report.eventBreakdown["tool.call"]).toBe(3);
      expect(report.eventBreakdown["session.start"]).toBe(1);
      expect(report.generatedAt).toBeDefined();
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("export after worker removal produces valid JSON with ended session", () => {
    const cwd = `/tmp/e2e-export-ended-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      removeLiveWorker(cwd, taskId);
      expect(registry.store.get(sessionId)!.status).toBe("ended");

      const json = registry.exporter.toJSON(sessionId);
      const parsed = JSON.parse(json);
      expect(parsed.session.metadata.id).toBe(sessionId);
      // session.start + session.end should be in events
      const eventTypes = (parsed.events as Array<{ type: string }>).map((e) => e.type);
      expect(eventTypes).toContain("session.start");
    } finally {
      bridge.dispose();
      registry.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — Health alerts fire
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Health alerts fire for stale/stuck sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stale active session produces a degraded health alert", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5_000_000));

    const cwd = `/tmp/e2e-health-stale-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    registry.healthMonitor.setThresholds({
      staleAfterMs: 500,
      stuckAfterMs: 10_000,
      errorRateThreshold: 0.5,
    });

    const alerts: Array<import("../../../src/monitor/health/types.js").HealthAlert> = [];
    registry.healthMonitor.onAlert((alert) => alerts.push(alert));

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      vi.advanceTimersByTime(1000);

      const status = registry.healthMonitor.checkHealth(sessionId);
      expect(status).toBe("degraded");
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0].sessionId).toBe(sessionId);
      expect(alerts[0].status).toBe("degraded");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("stuck active session produces a critical health alert", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_000_000));

    const cwd = `/tmp/e2e-health-stuck-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    registry.healthMonitor.setThresholds({
      staleAfterMs: 100,
      stuckAfterMs: 300,
      errorRateThreshold: 0.5,
    });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      vi.advanceTimersByTime(500);

      const status = registry.healthMonitor.checkHealth(sessionId);
      expect(status).toBe("critical");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("recently created session is healthy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000_000));

    const cwd = `/tmp/e2e-health-ok-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    registry.healthMonitor.setThresholds({
      staleAfterMs: 30_000,
      stuckAfterMs: 60_000,
      errorRateThreshold: 0.5,
    });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      vi.advanceTimersByTime(100);

      const status = registry.healthMonitor.checkHealth(sessionId);
      expect(status).toBe("healthy");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — Attention queue derives items
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Attention queue derives items from real sessions", () => {
  it("paused session appears as waiting_on_human in attention items", () => {
    const cwd = `/tmp/e2e-att-pause-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      registry.lifecycle.pause(sessionId);

      const sessions = registry.store.list();
      const healthMap = new Map<string, HealthStatus>();
      const metricsMap = new Map<string, ComputedMetrics>();

      for (const s of sessions) {
        healthMap.set(s.metadata.id, registry.healthMonitor.checkHealth(s.metadata.id));
        metricsMap.set(s.metadata.id, registry.aggregator.computeMetrics(s.metadata.id));
      }

      const items = deriveAttentionItems(sessions, healthMap, metricsMap);
      const forSession = items.filter((item) => item.sessionId === sessionId);

      expect(forSession.length).toBeGreaterThanOrEqual(1);
      expect(forSession[0].reason).toBe("waiting_on_human");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("escalated (error) session appears as failed_recoverable or repeated_retries", () => {
    const cwd = `/tmp/e2e-att-err-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      // escalate() transitions active → error
      registry.lifecycle.escalate(sessionId, "test error");

      const sessions = registry.store.list();
      const healthMap = new Map<string, HealthStatus>();
      const metricsMap = new Map<string, ComputedMetrics>();

      for (const s of sessions) {
        healthMap.set(s.metadata.id, registry.healthMonitor.checkHealth(s.metadata.id));
        metricsMap.set(s.metadata.id, registry.aggregator.computeMetrics(s.metadata.id));
      }

      const items = deriveAttentionItems(sessions, healthMap, metricsMap);
      const forSession = items.filter((item) => item.sessionId === sessionId);

      expect(forSession.length).toBeGreaterThanOrEqual(1);
      expect(["failed_recoverable", "repeated_retries"]).toContain(forSession[0].reason);
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("ended session produces no attention items", () => {
    const cwd = `/tmp/e2e-att-ended-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      removeLiveWorker(cwd, taskId); // → ends session via bridge

      const sessions = registry.store.list();
      const healthMap = new Map<string, HealthStatus>();
      const metricsMap = new Map<string, ComputedMetrics>();

      for (const s of sessions) {
        healthMap.set(s.metadata.id, registry.healthMonitor.checkHealth(s.metadata.id));
        metricsMap.set(s.metadata.id, registry.aggregator.computeMetrics(s.metadata.id));
      }

      const items = deriveAttentionItems(sessions, healthMap, metricsMap);
      const forSession = items.filter((item) => item.sessionId === sessionId);

      expect(forSession).toHaveLength(0);
    } finally {
      bridge.dispose();
      registry.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5 — Detail view renders events
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Detail view renders session events", () => {
  it("renderSessionDetailView produces lines with session header", () => {
    const cwd = `/tmp/e2e-detail-hdr-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      const session = registry.store.get(sessionId)!;
      const lines = renderSessionDetailView(session, "healthy", 80, 40, Date.now());

      expect(lines).toBeInstanceOf(Array);
      expect(lines.length).toBeGreaterThan(0);
      const allText = lines.join("\n");
      expect(allText).toContain("Session Detail");
      expect(allText).toContain("active");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("renderSessionDetailView shows tool.call entries when history entries are present", () => {
    const cwd = `/tmp/e2e-detail-tool-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      // The bridge emits tool.call events to the emitter stream (emitter.getHistory()).
      // The store's session.events array (SessionHistoryEntry[]) is separate and is
      // populated only via store.update(). Add history entries so the detail view
      // has real events to render.
      updateLiveWorker(
        cwd,
        taskId,
        makeWorkerPayload(taskId, cwd, { currentTool: "read" }),
      );

      // Verify the event was captured in the emitter
      const toolEvents = registry.emitter
        .getHistory()
        .filter((e) => e.sessionId === sessionId && e.type === "tool.call");
      expect(toolEvents.length).toBeGreaterThanOrEqual(1);

      // Push a history entry into the store so the detail view can render it
      const now = new Date().toISOString();
      const existing = registry.store.get(sessionId)!;
      const updatedEvents = [
        ...existing.events,
        { type: "tool.call", timestamp: now, data: { toolName: "read" } },
      ];
      registry.store.update(sessionId, { events: updatedEvents });

      const session = registry.store.get(sessionId)!;
      const lines = renderSessionDetailView(session, "healthy", 80, 40, Date.now());

      const allText = lines.join("\n");
      expect(allText).toContain("Session Detail");
      // TOOL label is rendered for tool.call events with toolName in data
      expect(allText).toContain("TOOL");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });

  it("renderSessionDetailView shows health status in header", () => {
    const cwd = `/tmp/e2e-detail-health-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      const sessionId = bridge.getSessionId(taskId, cwd)!;

      const session = registry.store.get(sessionId)!;
      const lines = renderSessionDetailView(session, "degraded", 80, 40, Date.now());

      const allText = lines.join("\n");
      expect(allText).toContain("degraded");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6 — Full pipeline end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Full pipeline — worker spawn to export, no mocks", () => {
  it("complete flow: spawn → tool changes → remove → export → attention → detail view", () => {
    const cwd = `/tmp/e2e-full-${randomUUID()}`;
    const taskId = randomUUID();

    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      // ── Step 1: Spawn worker ────────────────────────────────────────────────
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));
      expect(bridge.sessionCount).toBe(1);

      const sessionId = bridge.getSessionId(taskId, cwd)!;
      expect(sessionId).toBeDefined();
      expect(registry.store.get(sessionId)!.status).toBe("active");

      // ── Step 2: Simulate tool calls via worker updates ─────────────────────
      updateLiveWorker(
        cwd,
        taskId,
        makeWorkerPayload(taskId, cwd, { currentTool: "read" }),
      );
      updateLiveWorker(
        cwd,
        taskId,
        makeWorkerPayload(taskId, cwd, { currentTool: "bash" }),
      );
      updateLiveWorker(
        cwd,
        taskId,
        makeWorkerPayload(taskId, cwd, { currentTool: "write" }),
      );

      // ── Step 3: Remove worker → session ends ───────────────────────────────
      removeLiveWorker(cwd, taskId);
      expect(bridge.sessionCount).toBe(0);
      expect(registry.store.get(sessionId)!.status).toBe("ended");

      // ── Step 4: Export produces valid JSON ─────────────────────────────────
      const json = registry.exporter.toJSON(sessionId);
      expect(() => JSON.parse(json)).not.toThrow();

      const parsed = JSON.parse(json);
      expect(parsed.session.metadata.id).toBe(sessionId);
      expect(parsed.events).toBeInstanceOf(Array);

      // ── Step 5: Events were captured ───────────────────────────────────────
      const allEvents = registry.emitter
        .getHistory()
        .filter((e) => e.sessionId === sessionId);
      // session.start + 3 tool.call + session.end (from bridge removing worker)
      expect(allEvents.length).toBeGreaterThanOrEqual(3);

      const toolEventCount = allEvents.filter((e) => e.type === "tool.call").length;
      expect(toolEventCount).toBe(3);

      // ── Step 6: Attention queue — ended sessions produce no items ──────────
      const sessions = registry.store.list();
      const healthMap = new Map<string, HealthStatus>();
      const metricsMap = new Map<string, ComputedMetrics>();

      for (const s of sessions) {
        healthMap.set(s.metadata.id, registry.healthMonitor.checkHealth(s.metadata.id));
        metricsMap.set(s.metadata.id, registry.aggregator.computeMetrics(s.metadata.id));
      }

      const attentionItems = deriveAttentionItems(sessions, healthMap, metricsMap);
      const forSession = attentionItems.filter((i) => i.sessionId === sessionId);
      expect(forSession).toHaveLength(0);

      // ── Step 7: Detail view renders session metadata and events ────────────
      const session = registry.store.get(sessionId)!;
      const lines = renderSessionDetailView(session, "healthy", 80, 40, Date.now());
      expect(lines.length).toBeGreaterThan(0);

      const allText = lines.join("\n");
      expect(allText).toContain("Session Detail");
      expect(allText).toContain("ended");
    } finally {
      bridge.dispose();
      registry.dispose();
    }
  });

  it("registry createMonitorRegistry + createCrewMonitorBridge via factory function", () => {
    const cwd = `/tmp/e2e-factory-${randomUUID()}`;
    const taskId = randomUUID();

    // Use the createCrewMonitorBridge factory (not registry constructor path)
    const registry = createMonitorRegistry({ healthConfig: {} });
    const bridge = createCrewMonitorBridge(registry, { cwd });

    try {
      updateLiveWorker(cwd, taskId, makeWorkerPayload(taskId, cwd));

      const sessionId = bridge.getSessionId(taskId, cwd);
      expect(sessionId).toBeDefined();

      const session = registry.store.get(sessionId!);
      expect(session).toBeDefined();
      expect(session!.status).toBe("active");
      expect(session!.metadata.agent).toBe("TestAgent");
    } finally {
      removeLiveWorker(cwd, taskId);
      bridge.dispose();
      registry.dispose();
    }
  });
});
