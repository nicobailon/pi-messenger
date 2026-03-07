import { describe, it, expect, vi } from "vitest";
import { SessionEventEmitter, createSessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(type: SessionEvent["type"], overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    sessionId: "sess-1",
    timestamp: Date.now(),
    sequence: 0, // will be overwritten by emitter
    payload: type === "session.start"
      ? { type: "session.start", agentName: "test-agent" }
      : type === "session.end"
      ? { type: "session.end" }
      : type === "tool.call"
      ? { type: "tool.call", toolName: "bash" }
      : type === "tool.result"
      ? { type: "tool.result", toolName: "bash", success: true }
      : type === "session.error"
      ? { type: "session.error", message: "oops" }
      : type === "session.pause"
      ? { type: "session.pause" }
      : type === "session.resume"
      ? { type: "session.resume" }
      : type === "operator.action"
      ? { type: "operator.action", action: "pause" }
      : type === "health.check"
      ? { type: "health.check", status: "healthy" }
      : type === "health.alert"
      ? { type: "health.alert", severity: "warning", message: "cpu high" }
      : { type: "metrics.snapshot", toolCallCount: 0, errorCount: 0, uptimeMs: 0 },
    ...overrides,
  } as SessionEvent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionEventEmitter", () => {
  // 1. Factory function returns an instance
  it("createSessionEventEmitter returns a SessionEventEmitter", () => {
    const emitter = createSessionEventEmitter();
    expect(emitter).toBeInstanceOf(SessionEventEmitter);
  });

  // 2. Emit/subscribe round-trip
  it("subscriber receives emitted event", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    emitter.subscribe((e) => received.push(e));
    const event = makeEvent("session.start");
    emitter.emit(event);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session.start");
  });

  // 3. Multiple subscribers all receive the event
  it("all subscribers receive the same event", () => {
    const emitter = new SessionEventEmitter();
    const calls1: SessionEvent[] = [];
    const calls2: SessionEvent[] = [];
    emitter.subscribe((e) => calls1.push(e));
    emitter.subscribe((e) => calls2.push(e));
    emitter.emit(makeEvent("tool.call"));
    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);
  });

  // 4. Unsubscribe (via returned function) prevents further delivery
  it("unsubscribe via returned function stops delivery", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    const unsub = emitter.subscribe((e) => received.push(e));
    emitter.emit(makeEvent("tool.call"));
    unsub();
    emitter.emit(makeEvent("tool.result"));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("tool.call");
  });

  // 5. unsubscribe(handler) removes handler by reference
  it("unsubscribe(handler) stops delivery", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    const handler = (e: SessionEvent) => received.push(e);
    emitter.subscribe(handler);
    emitter.emit(makeEvent("session.start"));
    emitter.unsubscribe(handler);
    emitter.emit(makeEvent("session.end"));
    expect(received).toHaveLength(1);
  });

  // 6. Filtered subscriptions — type array — only receive matching types
  it("type array filter only delivers matching event types", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    emitter.subscribe((e) => received.push(e), ["session.start", "session.end"]);
    emitter.emit(makeEvent("session.start"));
    emitter.emit(makeEvent("tool.call"));
    emitter.emit(makeEvent("session.end"));
    emitter.emit(makeEvent("tool.result"));
    expect(received).toHaveLength(2);
    expect(received.map((e) => e.type)).toEqual(["session.start", "session.end"]);
  });

  // 7. Filtered subscriptions — predicate function
  it("predicate filter only delivers events matching predicate", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    emitter.subscribe((e) => received.push(e), (e) => e.sessionId === "sess-special");
    emitter.emit(makeEvent("session.start", { sessionId: "sess-1" }));
    emitter.emit(makeEvent("session.start", { sessionId: "sess-special" }));
    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("sess-special");
  });

  // 8. Sequence numbers are monotonically increasing
  it("sequence numbers are monotonically increasing across emits", () => {
    const emitter = new SessionEventEmitter();
    emitter.emit(makeEvent("session.start"));
    emitter.emit(makeEvent("tool.call"));
    emitter.emit(makeEvent("tool.result"));
    const history = emitter.getHistory();
    const seqs = history.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  // 9. getHistory returns all events
  it("getHistory returns all emitted events", () => {
    const emitter = new SessionEventEmitter();
    emitter.emit(makeEvent("session.start"));
    emitter.emit(makeEvent("tool.call"));
    emitter.emit(makeEvent("tool.result"));
    expect(emitter.getHistory()).toHaveLength(3);
  });

  // 10. getHistory(limit) returns the N most recent events
  it("getHistory(limit) returns the N most recent events", () => {
    const emitter = new SessionEventEmitter();
    emitter.emit(makeEvent("session.start"));
    emitter.emit(makeEvent("tool.call"));
    emitter.emit(makeEvent("tool.result"));
    emitter.emit(makeEvent("session.end"));
    const recent = emitter.getHistory(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].type).toBe("tool.result");
    expect(recent[1].type).toBe("session.end");
  });

  // 11. clear() empties history and resets sequence counter
  it("clear() resets history and sequence counter", () => {
    const emitter = new SessionEventEmitter();
    emitter.emit(makeEvent("session.start"));
    emitter.emit(makeEvent("tool.call"));
    emitter.clear();
    expect(emitter.getHistory()).toHaveLength(0);
    // After clear, next sequence starts at 0 again
    emitter.emit(makeEvent("session.start"));
    expect(emitter.getHistory()[0].sequence).toBe(0);
  });

  // 12. clear() does NOT remove subscriptions
  it("clear() preserves subscriptions", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    emitter.subscribe((e) => received.push(e));
    emitter.emit(makeEvent("session.start"));
    emitter.clear();
    emitter.emit(makeEvent("session.end"));
    // handler still active — received both before and after clear
    expect(received).toHaveLength(2);
  });

  // 13. Emitter assigns sequence numbers starting from 0
  it("sequence numbers start from 0", () => {
    const emitter = new SessionEventEmitter();
    emitter.emit(makeEvent("session.start"));
    expect(emitter.getHistory()[0].sequence).toBe(0);
  });

  // 14. Handler errors do not break other subscribers
  it("an error in one handler does not prevent other handlers from running", () => {
    const emitter = new SessionEventEmitter();
    const received: SessionEvent[] = [];
    emitter.subscribe(() => { throw new Error("boom"); });
    emitter.subscribe((e) => received.push(e));
    emitter.emit(makeEvent("session.start"));
    expect(received).toHaveLength(1);
  });
});
