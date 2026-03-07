import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionMetricsAggregator, createSessionMetricsAggregator } from "../../../src/monitor/metrics/aggregator.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;

function makeEvent(
  type: SessionEvent["type"],
  sessionId: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    sessionId,
    timestamp: Date.now(),
    sequence: _seq++,
    payload: buildPayload(type),
    ...overrides,
  } as SessionEvent;
}

function buildPayload(type: SessionEvent["type"]): SessionEvent["payload"] {
  switch (type) {
    case "session.start":   return { type: "session.start", agentName: "agent-1" };
    case "session.pause":   return { type: "session.pause" };
    case "session.resume":  return { type: "session.resume" };
    case "session.end":     return { type: "session.end" };
    case "session.error":   return { type: "session.error", message: "oops" };
    case "tool.call":       return { type: "tool.call", toolName: "bash" };
    case "tool.result":     return { type: "tool.result", toolName: "bash", success: true };
    case "operator.action": return { type: "operator.action", action: "pause" };
    case "health.check":    return { type: "health.check", status: "healthy" };
    case "health.alert":    return { type: "health.alert", severity: "warning", message: "high cpu" };
    default:                return { type: "metrics.snapshot", toolCallCount: 0, errorCount: 0, uptimeMs: 0 };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionMetricsAggregator", () => {
  let emitter: SessionEventEmitter;
  let agg: SessionMetricsAggregator;

  beforeEach(() => {
    _seq = 0;
    emitter = new SessionEventEmitter();
    agg = new SessionMetricsAggregator(emitter);
  });

  // 1. Factory function creates an instance
  it("createSessionMetricsAggregator returns a SessionMetricsAggregator", () => {
    const a = createSessionMetricsAggregator(new SessionEventEmitter());
    expect(a).toBeInstanceOf(SessionMetricsAggregator);
  });

  // 2. Empty state — no events emitted yet
  it("computeMetrics returns zeroed metrics for unknown session", () => {
    const m = agg.computeMetrics("sess-x");
    expect(m.totalEvents).toBe(0);
    expect(m.errorCount).toBe(0);
    expect(m.errorRate).toBe(0);
    expect(m.activeDurationMs).toBe(0);
    expect(m.toolCalls).toBe(0);
  });

  // 3. Total event count increments on each emit
  it("totalEvents increments correctly after multiple events", () => {
    emitter.emit(makeEvent("session.start", "sess-1"));
    emitter.emit(makeEvent("tool.call", "sess-1"));
    emitter.emit(makeEvent("tool.result", "sess-1"));
    expect(agg.computeMetrics("sess-1").totalEvents).toBe(3);
  });

  // 4. Error rate calculation
  it("getErrorRate returns errorCount / totalEvents", () => {
    emitter.emit(makeEvent("session.start", "sess-2"));
    emitter.emit(makeEvent("session.error", "sess-2"));
    emitter.emit(makeEvent("tool.call", "sess-2"));
    emitter.emit(makeEvent("session.error", "sess-2"));
    // 2 errors out of 4 events = 0.5
    expect(agg.getErrorRate("sess-2")).toBeCloseTo(0.5);
  });

  // 5. Error rate is 0 when no events
  it("getErrorRate returns 0 when no events have been emitted", () => {
    expect(agg.getErrorRate("sess-none")).toBe(0);
  });

  // 6. Error rate is 0 when there are events but no errors
  it("getErrorRate returns 0 when no error events", () => {
    emitter.emit(makeEvent("session.start", "sess-3"));
    emitter.emit(makeEvent("tool.call", "sess-3"));
    expect(agg.getErrorRate("sess-3")).toBe(0);
  });

  // 7. getEventCounts returns per-type breakdown
  it("getEventCounts returns per-type event counts", () => {
    emitter.emit(makeEvent("session.start", "sess-4"));
    emitter.emit(makeEvent("tool.call", "sess-4"));
    emitter.emit(makeEvent("tool.call", "sess-4"));
    emitter.emit(makeEvent("tool.result", "sess-4"));
    const counts = agg.getEventCounts("sess-4");
    expect(counts["session.start"]).toBe(1);
    expect(counts["tool.call"]).toBe(2);
    expect(counts["tool.result"]).toBe(1);
  });

  // 8. Duration: simple active period
  it("getActiveDuration accumulates time since session.start", async () => {
    const t0 = Date.now();
    emitter.emit(makeEvent("session.start", "sess-5", { timestamp: t0 }));
    // Wait a tiny bit
    await new Promise((r) => setTimeout(r, 20));
    const dur = agg.getActiveDuration("sess-5");
    expect(dur).toBeGreaterThan(0);
  });

  // 9. Duration excludes paused intervals
  it("getActiveDuration excludes paused intervals", () => {
    const t0 = 1000;
    const t1 = 1500; // pause at +500ms active
    const t2 = 2000; // resume (500ms paused — excluded)
    const t3 = 2300; // end at +300ms active = total 800ms

    emitter.emit(makeEvent("session.start", "sess-6", { timestamp: t0 }));
    emitter.emit(makeEvent("session.pause", "sess-6", { timestamp: t1 }));
    emitter.emit(makeEvent("session.resume", "sess-6", { timestamp: t2 }));
    emitter.emit(makeEvent("session.end", "sess-6", { timestamp: t3 }));

    const dur = agg.getActiveDuration("sess-6");
    expect(dur).toBe(800); // 500 + 300
  });

  // 10. Duration: session with multiple pause/resume cycles
  it("getActiveDuration handles multiple pause/resume cycles", () => {
    const t0 = 0;    // start
    const t1 = 100;  // pause1 — 100ms active
    const t2 = 200;  // resume1
    const t3 = 350;  // pause2 — 150ms active
    const t4 = 500;  // resume2
    const t5 = 600;  // end — 100ms active

    emitter.emit(makeEvent("session.start", "sess-7", { timestamp: t0 }));
    emitter.emit(makeEvent("session.pause", "sess-7", { timestamp: t1 }));
    emitter.emit(makeEvent("session.resume", "sess-7", { timestamp: t2 }));
    emitter.emit(makeEvent("session.pause", "sess-7", { timestamp: t3 }));
    emitter.emit(makeEvent("session.resume", "sess-7", { timestamp: t4 }));
    emitter.emit(makeEvent("session.end", "sess-7", { timestamp: t5 }));

    expect(agg.getActiveDuration("sess-7")).toBe(350); // 100 + 150 + 100
  });

  // 11. Sessions are isolated — events for one session don't affect another
  it("metrics are isolated per session", () => {
    emitter.emit(makeEvent("session.start", "sess-A"));
    emitter.emit(makeEvent("session.error", "sess-A"));
    emitter.emit(makeEvent("session.start", "sess-B"));

    expect(agg.computeMetrics("sess-A").totalEvents).toBe(2);
    expect(agg.computeMetrics("sess-B").totalEvents).toBe(1);
    expect(agg.getErrorRate("sess-A")).toBeCloseTo(0.5);
    expect(agg.getErrorRate("sess-B")).toBe(0);
  });

  // 12. subscribe receives real-time metric updates
  it("subscribe handler is called with updated metrics on each event", () => {
    const updates: number[] = [];
    agg.subscribe("sess-C", (m) => updates.push(m.totalEvents));

    emitter.emit(makeEvent("session.start", "sess-C"));
    emitter.emit(makeEvent("tool.call", "sess-C"));
    emitter.emit(makeEvent("tool.result", "sess-C"));

    expect(updates).toEqual([1, 2, 3]);
  });

  // 13. subscribe returns an unsubscribe function
  it("unsubscribe stops metric handler from being called", () => {
    const updates: number[] = [];
    const unsub = agg.subscribe("sess-D", (m) => updates.push(m.totalEvents));

    emitter.emit(makeEvent("session.start", "sess-D"));
    unsub();
    emitter.emit(makeEvent("tool.call", "sess-D"));

    expect(updates).toHaveLength(1);
    expect(updates[0]).toBe(1);
  });

  // 14. subscribe does not deliver events for other sessions
  it("subscribe handler only fires for the subscribed session", () => {
    const updates: number[] = [];
    agg.subscribe("sess-E", (m) => updates.push(m.totalEvents));

    emitter.emit(makeEvent("session.start", "sess-OTHER"));
    emitter.emit(makeEvent("session.start", "sess-E"));
    emitter.emit(makeEvent("tool.call", "sess-OTHER"));

    expect(updates).toHaveLength(1);
    expect(updates[0]).toBe(1);
  });

  // 15. tool.call events counted in computeMetrics.toolCalls
  it("computeMetrics.toolCalls counts tool.call events", () => {
    emitter.emit(makeEvent("session.start", "sess-F"));
    emitter.emit(makeEvent("tool.call", "sess-F"));
    emitter.emit(makeEvent("tool.call", "sess-F"));
    emitter.emit(makeEvent("tool.result", "sess-F"));
    expect(agg.computeMetrics("sess-F").toolCalls).toBe(2);
  });

  // 16. destroy() stops the aggregator from processing further events
  it("destroy() stops processing new events", () => {
    emitter.emit(makeEvent("session.start", "sess-G"));
    agg.destroy();
    emitter.emit(makeEvent("tool.call", "sess-G"));

    // Should still have only the 1 event from before destroy
    expect(agg.computeMetrics("sess-G").totalEvents).toBe(1);
  });
});
