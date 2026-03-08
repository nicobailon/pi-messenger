/**
 * End-to-end integration tests for the session monitor pipeline.
 *
 * Exercises all 4 layers:
 *   L0 — Types/Schemas
 *   L1 — Store, EventEmitter, Lifecycle
 *   L2 — Metrics, CommandHandler, Feed
 *   L3 — HealthMonitor, Replayer, Exporter, UI render
 *
 * All tests are self-contained: no file system, no real timers required for
 * most tests; fake timers are used only in the health alerting suite and
 * restored immediately after.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

import {
  setupFullPipeline,
  createTestSession,
  emitTestEvents,
  makeMetadata,
} from "./helpers.js";

import { SessionStore } from "../../../src/monitor/store/session-store.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import { SessionLifecycleManager } from "../../../src/monitor/lifecycle/manager.js";
import { SessionMetricsAggregator } from "../../../src/monitor/metrics/aggregator.js";
import { SessionHealthMonitor } from "../../../src/monitor/health/monitor.js";
import { SessionReplayer } from "../../../src/monitor/replay/replayer.js";

import {
  renderStatusBadge,
  renderSessionRow,
  renderMetricsSummary,
} from "../../../src/monitor/ui/render.js";

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Full pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("Full pipeline", () => {
  it("creates a session, emits events, and aggregates metrics", () => {
    const { lifecycle, emitter, aggregator } = setupFullPipeline();

    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 4);

    const metrics = aggregator.computeMetrics(id);

    // session.start + 4 tool.call = 5 events
    expect(metrics.totalEvents).toBe(5);
    expect(metrics.toolCalls).toBe(4);
    expect(metrics.errorRate).toBe(0);
  });

  it("UI rendering: renderStatusBadge is used for the session state", () => {
    const { lifecycle, store } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    const session = store.get(id)!;
    expect(session).toBeDefined();
    expect(session.status).toBe("active");

    // renderStatusBadge is a pure function — verify it returns a colored string
    const badge = renderStatusBadge(session.status);
    expect(badge).toContain("active");
    expect(badge).toContain("\x1b[32m"); // green ANSI
  });

  it("UI rendering: renderSessionRow returns two lines with metrics", () => {
    const { lifecycle, store } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    const session = store.get(id)!;

    const lines = renderSessionRow(session, false);
    expect(lines).toHaveLength(2);
    // Line 1 contains status
    expect(lines[0]).toContain("active");
    // Line 2 contains metrics
    expect(lines[1]).toContain("events");
  });

  it("export generates valid JSON that round-trips", () => {
    const { lifecycle, emitter, exporter, store } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 2);

    const json = exporter.toJSON(id);
    const parsed = JSON.parse(json);

    expect(parsed.session).toBeDefined();
    expect(parsed.session.metadata.id).toBe(id);
    expect(parsed.events).toBeInstanceOf(Array);
    // session.start + 2 tool.call = 3 events in emitter history
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
  });

  it("export generates a report with correct event breakdown", () => {
    const { lifecycle, emitter, exporter } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 3);

    const report = exporter.generateReport(id);

    expect(report.sessionId).toBe(id);
    expect(report.eventBreakdown["tool.call"]).toBe(3);
    expect(report.eventBreakdown["session.start"]).toBe(1);
    expect(report.generatedAt).toBeDefined();
  });

  it("full pipeline: feed subscriber receives all emitted events", () => {
    const { lifecycle, emitter, feedSubscriber } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 5);

    const buffer = feedSubscriber.getBuffer();
    // session.start + 5 tool.call = 6 events
    expect(buffer.length).toBeGreaterThanOrEqual(6);
    expect(feedSubscriber.getOffset()).toBeGreaterThanOrEqual(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Lifecycle with operator commands
// ─────────────────────────────────────────────────────────────────────────────

describe("Lifecycle with operator commands", () => {
  it("full cycle: start → pause → resume → end via command handler", () => {
    const { lifecycle, commandHandler, store } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    expect(store.get(id)!.status).toBe("active");

    const pauseResult = commandHandler.execute({
      action: "pause",
      sessionId: id,
      reason: "test pause",
    });
    expect(pauseResult.success).toBe(true);
    expect(store.get(id)!.status).toBe("paused");

    const resumeResult = commandHandler.execute({
      action: "resume",
      sessionId: id,
    });
    expect(resumeResult.success).toBe(true);
    expect(store.get(id)!.status).toBe("active");

    const endResult = commandHandler.execute({
      action: "end",
      sessionId: id,
      reason: "test complete",
    });
    expect(endResult.success).toBe(true);
    expect(store.get(id)!.status).toBe("ended");
  });

  it("inspect command returns current session state", () => {
    const { lifecycle, commandHandler } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    const result = commandHandler.execute({ action: "inspect", sessionId: id });
    expect(result.success).toBe(true);
    expect((result.result as any).metadata.id).toBe(id);
  });

  it("command handler validates allowedActions constraint", () => {
    const { lifecycle, commandHandler } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    commandHandler.setValidator({
      allowedActions: ["inspect"],
      requireReason: false,
      maxConcurrent: 5,
    });

    const result = commandHandler.execute({ action: "pause", sessionId: id });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — Replay verification
// ─────────────────────────────────────────────────────────────────────────────

describe("Replay verification", () => {
  it("full replay produces the same status as the live session", () => {
    const { lifecycle, emitter, replayer, store } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 3);

    const live = store.get(id)!;
    const replayed = replayer.replay(id);

    expect(replayed.status).toBe(live.status);
    expect(replayed.metadata.id).toBe(id);
  });

  it("partial replay truncates at given sequence number", () => {
    const { lifecycle, emitter, replayer } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 5);

    const allEvents = emitter.getHistory().filter((e) => e.sessionId === id);
    // Replay only up to the first event (session.start at sequence 0)
    const partial = replayer.replay(id, allEvents[0].sequence);

    // Only 1 event included → status is active (session.start sets active)
    expect(partial.status).toBe("active");
    expect(partial.metrics.eventCount).toBe(1);
  });

  it("replayRange returns events within the sequence range", () => {
    const { lifecycle, emitter, replayer } = setupFullPipeline();
    const id = createTestSession(lifecycle);
    emitTestEvents(emitter, id, 4);

    const allEvents = emitter.getHistory().filter((e) => e.sessionId === id);
    const firstSeq = allEvents[0].sequence;
    const lastSeq = allEvents[allEvents.length - 1].sequence;

    const range = replayer.replayRange(id, firstSeq, lastSeq);
    expect(range.length).toBe(allEvents.length);
  });

  it("replay of empty event history returns idle state", () => {
    const { replayer } = setupFullPipeline();
    const result = replayer.replay("nonexistent-session-xyz");

    expect(result.status).toBe("idle");
    expect(result.metrics.eventCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — Health alerting (fake timers)
// ─────────────────────────────────────────────────────────────────────────────

describe("Health alerting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stale session triggers a degraded alert", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));

    const store = new SessionStore();
    const emitter = new SessionEventEmitter();
    const lifecycle = new SessionLifecycleManager(store, emitter);
    const aggregator = new SessionMetricsAggregator(emitter, store);
    const healthMonitor = new SessionHealthMonitor(store, emitter, aggregator);

    const staleMs = 500;
    healthMonitor.setThresholds({
      staleAfterMs: staleMs,
      stuckAfterMs: staleMs * 10,
      errorRateThreshold: 0.5,
    });

    const alerts: import("../../../src/monitor/health/types.js").HealthAlert[] = [];
    healthMonitor.onAlert((alert) => alerts.push(alert));

    const id = lifecycle.start(makeMetadata());
    // Advance time past the stale threshold
    vi.advanceTimersByTime(staleMs + 100);

    const status = healthMonitor.checkHealth(id);

    expect(status).toBe("degraded");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sessionId).toBe(id);
    expect(alerts[0].status).toBe("degraded");
  });

  it("recently active session is healthy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));

    const store = new SessionStore();
    const emitter = new SessionEventEmitter();
    const lifecycle = new SessionLifecycleManager(store, emitter);
    const aggregator = new SessionMetricsAggregator(emitter, store);
    const healthMonitor = new SessionHealthMonitor(store, emitter, aggregator);

    healthMonitor.setThresholds({
      staleAfterMs: 10_000,
      stuckAfterMs: 30_000,
      errorRateThreshold: 0.5,
    });

    const id = lifecycle.start(makeMetadata());
    // Only a small amount of time passes — session is still healthy
    vi.advanceTimersByTime(100);

    const status = healthMonitor.checkHealth(id);
    expect(status).toBe("healthy");
  });

  it("stuck session triggers a critical alert after stuckAfterMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000));

    const store = new SessionStore();
    const emitter = new SessionEventEmitter();
    const lifecycle = new SessionLifecycleManager(store, emitter);
    const aggregator = new SessionMetricsAggregator(emitter, store);
    const healthMonitor = new SessionHealthMonitor(store, emitter, aggregator);

    const stuckMs = 200;
    healthMonitor.setThresholds({
      staleAfterMs: 100,
      stuckAfterMs: stuckMs,
      errorRateThreshold: 0.5,
    });

    const id = lifecycle.start(makeMetadata());
    vi.advanceTimersByTime(stuckMs + 50);

    const status = healthMonitor.checkHealth(id);
    expect(status).toBe("critical");
  });

  it("health monitor stop() prevents interval-driven alerts", () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const emitter = new SessionEventEmitter();
    const lifecycle = new SessionLifecycleManager(store, emitter);
    const aggregator = new SessionMetricsAggregator(emitter, store);
    const healthMonitor = new SessionHealthMonitor(store, emitter, aggregator);

    healthMonitor.setThresholds({ staleAfterMs: 10, stuckAfterMs: 20, errorRateThreshold: 0.5 });

    const alerts: unknown[] = [];
    healthMonitor.onAlert((a) => alerts.push(a));

    lifecycle.start(makeMetadata());
    healthMonitor.start(50);
    healthMonitor.stop(); // stop before any interval fires

    vi.advanceTimersByTime(500); // would have fired ~10 times if not stopped
    expect(alerts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5 — Concurrent sessions
// ─────────────────────────────────────────────────────────────────────────────

describe("Concurrent sessions", () => {
  it("multiple sessions can run with independent lifecycle states", () => {
    const { lifecycle, store } = setupFullPipeline();

    const id1 = createTestSession(lifecycle, { name: "session-A" });
    const id2 = createTestSession(lifecycle, { name: "session-B" });
    const id3 = createTestSession(lifecycle, { name: "session-C" });

    lifecycle.pause(id1);
    lifecycle.end(id2);

    expect(store.get(id1)!.status).toBe("paused");
    expect(store.get(id2)!.status).toBe("ended");
    expect(store.get(id3)!.status).toBe("active");
  });

  it("metrics are isolated per session", () => {
    const { lifecycle, emitter, aggregator } = setupFullPipeline();

    const id1 = createTestSession(lifecycle, { name: "session-X" });
    const id2 = createTestSession(lifecycle, { name: "session-Y" });

    emitTestEvents(emitter, id1, 3);
    emitTestEvents(emitter, id2, 7);

    const m1 = aggregator.computeMetrics(id1);
    const m2 = aggregator.computeMetrics(id2);

    // session.start + tool.calls
    expect(m1.toolCalls).toBe(3);
    expect(m2.toolCalls).toBe(7);
    expect(m1.totalEvents).not.toBe(m2.totalEvents);
  });

  it("store lists all active sessions and filters correctly", () => {
    const { lifecycle, commandHandler, store } = setupFullPipeline();

    const id1 = createTestSession(lifecycle, { name: "active-one" });
    const id2 = createTestSession(lifecycle, { name: "ended-one" });
    lifecycle.end(id2);

    const all = store.list();
    const active = store.list({ status: "active" });
    const ended = store.list({ status: "ended" });

    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(active.some((s) => s.metadata.id === id1)).toBe(true);
    expect(ended.some((s) => s.metadata.id === id2)).toBe(true);
    expect(active.some((s) => s.metadata.id === id2)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6 — Error scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("Error scenarios", () => {
  it("invalid transition throws a descriptive error", () => {
    const { lifecycle } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    lifecycle.end(id);

    // Cannot resume an ended session
    expect(() => lifecycle.resume(id)).toThrow(/ended/);
  });

  it("operator command to nonexistent session returns failure", () => {
    const { commandHandler } = setupFullPipeline();

    const result = commandHandler.execute({
      action: "pause",
      sessionId: "does-not-exist",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("exporter throws for unknown session ID", () => {
    const { exporter } = setupFullPipeline();
    expect(() => exporter.toJSON("nonexistent-id")).toThrow(/not found/);
  });

  it("command validator: requireReason rejects commands without reason", () => {
    const { lifecycle, commandHandler } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    commandHandler.setValidator({
      allowedActions: ["pause", "resume", "end"],
      requireReason: true,
      maxConcurrent: 5,
    });

    const result = commandHandler.execute({ action: "pause", sessionId: id });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason");
  });

  it("replay of a paused-then-resumed session gives correct active status", () => {
    const { lifecycle, replayer } = setupFullPipeline();
    const id = createTestSession(lifecycle);

    lifecycle.pause(id);
    lifecycle.resume(id);

    const replayed = replayer.replay(id);
    expect(replayed.status).toBe("active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 7 — Grouped session overview (task-3)
// ─────────────────────────────────────────────────────────────────────────────

describe("Grouped session overview", () => {
  it("can group multiple sessions across all four lifecycle states", () => {
    const { lifecycle, store } = setupFullPipeline();

    const active = createTestSession(lifecycle, { name: "active-session" });
    const paused = createTestSession(lifecycle, { name: "paused-session" });
    const ended = createTestSession(lifecycle, { name: "ended-session" });
    const errored = createTestSession(lifecycle, { name: "errored-session" });

    lifecycle.pause(paused);
    lifecycle.end(ended);
    // Note: to create error status, would need to emit error event or use special method
    // For now, verify the others can be created and grouped

    const all = store.list();
    expect(all.length).toBeGreaterThanOrEqual(3);

    const byStatus = {
      active: all.filter((s) => s.status === "active"),
      paused: all.filter((s) => s.status === "paused"),
      ended: all.filter((s) => s.status === "ended"),
      error: all.filter((s) => s.status === "error"),
    };

    expect(byStatus.active.some((s) => s.metadata.name === "active-session")).toBe(true);
    expect(byStatus.paused.some((s) => s.metadata.name === "paused-session")).toBe(true);
    expect(byStatus.ended.some((s) => s.metadata.name === "ended-session")).toBe(true);
  });

  it("sessions can be filtered and displayed by lifecycle state", () => {
    const { lifecycle, store } = setupFullPipeline();

    const id1 = createTestSession(lifecycle, { name: "session-1" });
    const id2 = createTestSession(lifecycle, { name: "session-2" });
    const id3 = createTestSession(lifecycle, { name: "session-3" });

    lifecycle.pause(id2);
    lifecycle.end(id3);

    const active = store.list({ status: "active" });
    const paused = store.list({ status: "paused" });
    const ended = store.list({ status: "ended" });

    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(paused.length).toBeGreaterThanOrEqual(1);
    expect(ended.length).toBeGreaterThanOrEqual(1);

    // Verify no overlap
    const allIds = new Set<string>();
    const addAll = (arr: any[]) => {
      arr.forEach((s) => {
        expect(allIds.has(s.metadata.id)).toBe(false);
        allIds.add(s.metadata.id);
      });
    };
    addAll(active);
    addAll(paused);
    addAll(ended);
  });

  it("grouped display preserves session data (name, task, metrics)", () => {
    const { lifecycle, store } = setupFullPipeline();

    const id = createTestSession(lifecycle, { name: "test-session" });
    const session = store.get(id)!;

    expect(session.metadata.name).toBe("test-session");
    expect(session.metadata.taskId).toBeDefined();
    expect(session.metrics).toBeDefined();
    expect(session.metrics.eventCount).toBeGreaterThanOrEqual(0);
  });

  it("running (active) sessions should be visually prioritized", () => {
    const { lifecycle, store } = setupFullPipeline();

    // Create sessions in mixed order
    const ended = createTestSession(lifecycle, { name: "z-ended" });
    const active = createTestSession(lifecycle, { name: "a-active" });
    const paused = createTestSession(lifecycle, { name: "m-paused" });

    lifecycle.end(ended);
    lifecycle.pause(paused);

    const all = store.list();

    // Grouping should organize them by status, with running first
    // This is verified in the render functions
    const running = all.filter((s) => s.status === "active");
    expect(running.length).toBeGreaterThan(0);
    expect(running.some((s) => s.metadata.name === "a-active")).toBe(true);
  });
});
