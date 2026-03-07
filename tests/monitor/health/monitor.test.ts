/**
 * SessionHealthMonitor tests
 *
 * Uses fake timers (vitest) for deterministic time-based testing.
 * Tests: stale detection, stuck detection, alert emission, configurable thresholds, start/stop lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionHealthMonitor } from "../../../src/monitor/health/monitor.js";
import { SessionStore } from "../../../src/monitor/store/session-store.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import { SessionMetricsAggregator } from "../../../src/monitor/metrics/aggregator.js";
import type { HealthAlert } from "../../../src/monitor/health/types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeStore() {
  return new SessionStore();
}

function makeEmitter() {
  return new SessionEventEmitter();
}

function createActiveSession(store: SessionStore, emitter: SessionEventEmitter, id = "sess-1") {
  store.create({
    id,
    name: "test-session",
    cwd: "/tmp",
    model: "test-model",
    agent: "test-agent",
    startedAt: new Date().toISOString(),
  });
  store.update(id, { status: "active" });

  // Emit a start event so the emitter tracks this session
  emitter.emit({
    id: `evt-${id}-start`,
    type: "session.start",
    sessionId: id,
    timestamp: Date.now(),
    sequence: 0,
    payload: {
      type: "session.start",
      agentName: "test-agent",
    },
  });

  return id;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("SessionHealthMonitor", () => {
  let store: SessionStore;
  let emitter: SessionEventEmitter;
  let monitor: SessionHealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    store = makeStore();
    emitter = makeEmitter();
    monitor = new SessionHealthMonitor(store, emitter);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  // ─── Type tests ─────────────────────────────────────────────────────────────

  it("exports HealthStatus, HealthThresholds, HealthAlert types", async () => {
    const types = await import("../../../src/monitor/health/types.js");
    // Type-only exports — just check the module imports cleanly
    expect(types).toBeDefined();
  });

  it("exports SessionHealthMonitor class from index", async () => {
    const mod = await import("../../../src/monitor/health/index.js");
    expect(mod.SessionHealthMonitor).toBeDefined();
  });

  // ─── checkHealth: healthy session ────────────────────────────────────────────

  it("returns healthy for a session with recent activity", () => {
    const id = createActiveSession(store, emitter);

    // Session just started — no idle time
    const status = monitor.checkHealth(id);
    expect(status).toBe("healthy");
  });

  it("returns healthy for non-existent session", () => {
    const status = monitor.checkHealth("nonexistent-session");
    expect(status).toBe("healthy");
  });

  it("returns healthy for ended sessions", () => {
    const id = createActiveSession(store, emitter);
    store.update(id, { status: "ended" });

    const status = monitor.checkHealth(id);
    expect(status).toBe("healthy");
  });

  // ─── Stale detection (degraded) ──────────────────────────────────────────────

  it("triggers degraded alert when session is stale", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    // Advance past stale threshold
    vi.advanceTimersByTime(6_000);

    const status = monitor.checkHealth(id);
    expect(status).toBe("degraded");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sessionId).toBe(id);
    expect(alerts[0].status).toBe("degraded");
  });

  it("degraded alert reason mentions stale duration", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);

    expect(alerts[0].reason).toMatch(/stale/i);
  });

  // ─── Stuck detection (critical) ──────────────────────────────────────────────

  it("triggers critical alert when session is stuck", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 15_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    // Advance past stuck threshold
    vi.advanceTimersByTime(20_000);

    const status = monitor.checkHealth(id);
    expect(status).toBe("critical");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("critical");
  });

  it("critical alert reason mentions stuck duration", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 15_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(20_000);
    monitor.checkHealth(id);

    expect(alerts[0].reason).toMatch(/stuck/i);
  });

  // ─── Alert emission via emitter ───────────────────────────────────────────────

  it("emits health.alert event to the emitter", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const emittedEvents: string[] = [];
    emitter.subscribe((e) => {
      if (e.type === "health.alert") emittedEvents.push(e.sessionId);
    });

    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);

    expect(emittedEvents).toContain(id);
  });

  it("health.alert event has correct severity for degraded", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alertEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    emitter.subscribe((e) => {
      if (e.type === "health.alert") {
        alertEvents.push({ type: e.type, payload: e.payload as Record<string, unknown> });
      }
    });

    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);

    expect(alertEvents[0].payload["severity"]).toBe("warning");
  });

  it("health.alert event has critical severity for stuck sessions", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 15_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alertEvents: Array<{ payload: Record<string, unknown> }> = [];
    emitter.subscribe((e) => {
      if (e.type === "health.alert") {
        alertEvents.push({ payload: e.payload as Record<string, unknown> });
      }
    });

    vi.advanceTimersByTime(20_000);
    monitor.checkHealth(id);

    expect(alertEvents[0].payload["severity"]).toBe("critical");
  });

  // ─── Configurable thresholds ──────────────────────────────────────────────────

  it("does not alert before stale threshold", () => {
    monitor.setThresholds({ staleAfterMs: 10_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(9_000); // Just under threshold
    const status = monitor.checkHealth(id);

    expect(status).toBe("healthy");
    expect(alerts).toHaveLength(0);
  });

  it("setThresholds merges with existing config", () => {
    monitor.setThresholds({ staleAfterMs: 5_000 }); // Only override stale
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);

    // Should trigger degraded (stale at 5s) not critical (stuck at default 120s)
    expect(alerts[0].status).toBe("degraded");
  });

  // ─── Start/Stop lifecycle ──────────────────────────────────────────────────────

  it("start() begins polling and triggers alerts automatically", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    monitor.start(3_000); // Poll every 3 seconds

    // Advance past stale threshold + one poll interval
    vi.advanceTimersByTime(9_000);

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].sessionId).toBe(id);
  });

  it("stop() clears interval and prevents further alerts", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    monitor.start(3_000);
    vi.advanceTimersByTime(4_000); // Just one poll — not stale yet

    monitor.stop();

    // Advance well past stale threshold
    vi.advanceTimersByTime(30_000);

    // No alerts — polling stopped
    expect(alerts).toHaveLength(0);
  });

  it("onAlert returns unsubscribe function that removes handler", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    const unsub = monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);
    expect(alerts).toHaveLength(1);

    // Unsubscribe then check again
    unsub();
    vi.advanceTimersByTime(6_000);
    monitor.checkHealth(id);
    expect(alerts).toHaveLength(1); // No new alerts
  });

  it("multiple sessions are all checked during polling", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });

    createActiveSession(store, emitter, "sess-A");
    createActiveSession(store, emitter, "sess-B");

    const alertedSessions = new Set<string>();
    monitor.onAlert((a) => alertedSessions.add(a.sessionId));

    monitor.start(3_000);
    vi.advanceTimersByTime(9_000);

    expect(alertedSessions.has("sess-A")).toBe(true);
    expect(alertedSessions.has("sess-B")).toBe(true);
  });

  it("alert has correct detectedAt timestamp", () => {
    monitor.setThresholds({ staleAfterMs: 5_000, stuckAfterMs: 30_000, errorRateThreshold: 0.5 });
    const id = createActiveSession(store, emitter);

    const alerts: HealthAlert[] = [];
    monitor.onAlert((a) => alerts.push(a));

    vi.advanceTimersByTime(6_000);
    const before = Date.now();
    monitor.checkHealth(id);
    const after = Date.now();

    expect(alerts[0].detectedAt).toBeGreaterThanOrEqual(before);
    expect(alerts[0].detectedAt).toBeLessThanOrEqual(after);
  });
});
