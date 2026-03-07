import { describe, it, expect, beforeEach } from "vitest";
import { SessionReplayer, createSessionReplayer } from "../../../src/monitor/replay/replayer.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SESSION_A = "session-a";
const SESSION_B = "session-b";

function makeEvent(
  type: SessionEvent["type"],
  sessionId: string,
  timestampMs: number,
  extra: Partial<SessionEvent> = {}
): SessionEvent {
  const payload = buildPayload(type);
  return {
    id: `evt-${type}-${timestampMs}`,
    type,
    sessionId,
    timestamp: timestampMs,
    sequence: 0, // will be overwritten by emitter
    payload,
    ...extra,
  } as SessionEvent;
}

function buildPayload(type: SessionEvent["type"]): SessionEvent["payload"] {
  switch (type) {
    case "session.start":   return { type: "session.start", agentName: "agent-1", model: "gpt-4" };
    case "session.pause":   return { type: "session.pause" };
    case "session.resume":  return { type: "session.resume" };
    case "session.end":     return { type: "session.end", summary: "done" };
    case "session.error":   return { type: "session.error", message: "oops" };
    case "tool.call":       return { type: "tool.call", toolName: "bash" };
    case "tool.result":     return { type: "tool.result", toolName: "bash", success: true };
    case "operator.action": return { type: "operator.action", action: "pause" };
    case "health.check":    return { type: "health.check", status: "healthy" };
    case "health.alert":    return { type: "health.alert", severity: "warning", message: "slow" };
    default:                return { type: "metrics.snapshot", toolCallCount: 0, errorCount: 0, uptimeMs: 0 };
  }
}

// Emit an event into the emitter (sequence is auto-assigned)
function emit(emitter: SessionEventEmitter, type: SessionEvent["type"], sessionId: string, ts: number): SessionEvent {
  const event = makeEvent(type, sessionId, ts);
  emitter.emit(event);
  // Return the actual stored event (with assigned sequence)
  const history = emitter.getHistory();
  return history[history.length - 1];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionReplayer", () => {
  let emitter: SessionEventEmitter;
  let replayer: SessionReplayer;

  const T0 = 1000;
  const T1 = 2000;
  const T2 = 3000;
  const T3 = 4000;
  const T4 = 5000;

  beforeEach(() => {
    emitter = new SessionEventEmitter();
    replayer = new SessionReplayer(emitter);
  });

  // ── Test 1: Factory function ─────────────────────────────────────────────
  it("createSessionReplayer returns a SessionReplayer instance", () => {
    const r = createSessionReplayer(new SessionEventEmitter());
    expect(r).toBeInstanceOf(SessionReplayer);
  });

  // ── Test 2: Empty event log ──────────────────────────────────────────────
  it("replay on empty log returns idle state with empty events", () => {
    const state = replayer.replay(SESSION_A);
    expect(state.status).toBe("idle");
    expect(state.events).toHaveLength(0);
    expect(state.metrics.eventCount).toBe(0);
    expect(state.metrics.errorCount).toBe(0);
    expect(state.metrics.duration).toBe(0);
    expect(state.metadata.id).toBe(SESSION_A);
  });

  // ── Test 3: Full replay — status follows lifecycle ───────────────────────
  it("full replay produces correct final status after end", () => {
    emit(emitter, "session.start", SESSION_A, T0);
    emit(emitter, "tool.call", SESSION_A, T1);
    emit(emitter, "session.end", SESSION_A, T2);

    const state = replayer.replay(SESSION_A);
    expect(state.status).toBe("ended");
    expect(state.events).toHaveLength(3);
    expect(state.metrics.eventCount).toBe(3);
    expect(state.metrics.toolCalls).toBe(1);
  });

  // ── Test 4: Full replay — metadata from session.start ───────────────────
  it("full replay extracts metadata from session.start payload", () => {
    emit(emitter, "session.start", SESSION_A, T0);
    emit(emitter, "session.end", SESSION_A, T1);

    const state = replayer.replay(SESSION_A);
    expect(state.metadata.id).toBe(SESSION_A);
    expect(state.metadata.agent).toBe("agent-1");
    expect(state.metadata.name).toBe("agent-1");
    expect(state.metadata.model).toBe("gpt-4");
    expect(new Date(state.metadata.startedAt).getTime()).toBe(T0);
  });

  // ── Test 5: Partial replay truncates at given sequence ───────────────────
  it("partial replay truncates at toSequence (inclusive)", () => {
    const e0 = emit(emitter, "session.start", SESSION_A, T0);
    const e1 = emit(emitter, "tool.call", SESSION_A, T1);
    const e2 = emit(emitter, "session.pause", SESSION_A, T2);
    emit(emitter, "session.resume", SESSION_A, T3);
    emit(emitter, "session.end", SESSION_A, T4);

    // Replay up to sequence of e2 (pause)
    const state = replayer.replay(SESSION_A, e2.sequence);
    expect(state.status).toBe("paused");
    expect(state.events).toHaveLength(3);
    expect(state.metrics.eventCount).toBe(3);
  });

  // ── Test 6: Partial replay — status at mid-sequence ─────────────────────
  it("partial replay to sequence before end gives non-ended status", () => {
    const e0 = emit(emitter, "session.start", SESSION_A, T0);
    const e1 = emit(emitter, "tool.call", SESSION_A, T1);
    emit(emitter, "session.end", SESSION_A, T2);

    // Replay only through e1 (tool.call)
    const state = replayer.replay(SESSION_A, e1.sequence);
    expect(state.status).toBe("active");
    expect(state.events).toHaveLength(2);
  });

  // ── Test 7: Time-based snapshot ──────────────────────────────────────────
  it("getSnapshot at time between events includes only earlier events", () => {
    emit(emitter, "session.start", SESSION_A, T0);
    emit(emitter, "tool.call", SESSION_A, T1);
    emit(emitter, "session.end", SESSION_A, T4);

    // Snapshot at T2 (between tool.call and session.end)
    const cutoff = new Date(T2).toISOString();
    const state = replayer.getSnapshot(SESSION_A, cutoff);
    expect(state.status).toBe("active");
    expect(state.events).toHaveLength(2); // start + tool.call
  });

  // ── Test 8: Time-based snapshot at exact event boundary ─────────────────
  it("getSnapshot includes events at exactly the cutoff time", () => {
    emit(emitter, "session.start", SESSION_A, T0);
    emit(emitter, "session.end", SESSION_A, T1);

    // Snapshot exactly at T1 — should include session.end
    const cutoff = new Date(T1).toISOString();
    const state = replayer.getSnapshot(SESSION_A, cutoff);
    expect(state.status).toBe("ended");
    expect(state.events).toHaveLength(2);
  });

  // ── Test 9: Duration excludes paused intervals ───────────────────────────
  it("replay with pauses reconstructs correct duration (excludes paused time)", () => {
    // start at T0, pause at T1 (active=1000ms), resume at T2, end at T3 (active=1000ms)
    // total active = 2000ms
    emit(emitter, "session.start", SESSION_A, T0);    // T0=1000
    emit(emitter, "session.pause", SESSION_A, T1);    // T1=2000 → +1000ms active
    emit(emitter, "session.resume", SESSION_A, T2);   // T2=3000
    emit(emitter, "session.end", SESSION_A, T3);      // T3=4000 → +1000ms active

    const state = replayer.replay(SESSION_A);
    expect(state.status).toBe("ended");
    expect(state.metrics.duration).toBe(2000);
  });

  // ── Test 10: replayRange returns events in sequence range ────────────────
  it("replayRange returns only events in [from, to] sequence range", () => {
    const e0 = emit(emitter, "session.start", SESSION_A, T0);
    const e1 = emit(emitter, "tool.call", SESSION_A, T1);
    const e2 = emit(emitter, "tool.call", SESSION_A, T2);
    const e3 = emit(emitter, "session.end", SESSION_A, T3);

    const range = replayer.replayRange(SESSION_A, e1.sequence, e2.sequence);
    expect(range).toHaveLength(2);
    expect(range[0].type).toBe("tool.call");
    expect(range[1].type).toBe("tool.call");
  });

  // ── Test 11: replayRange is inclusive on both ends ───────────────────────
  it("replayRange with from === to returns single event", () => {
    const e0 = emit(emitter, "session.start", SESSION_A, T0);
    const e1 = emit(emitter, "tool.call", SESSION_A, T1);

    const range = replayer.replayRange(SESSION_A, e0.sequence, e0.sequence);
    expect(range).toHaveLength(1);
    expect(range[0].type).toBe("session.start");
  });

  // ── Test 12: Multi-session isolation ─────────────────────────────────────
  it("replay isolates events by sessionId", () => {
    emit(emitter, "session.start", SESSION_A, T0);
    emit(emitter, "session.end", SESSION_A, T1);
    emit(emitter, "session.start", SESSION_B, T2);
    emit(emitter, "tool.call", SESSION_B, T3);

    const stateA = replayer.replay(SESSION_A);
    const stateB = replayer.replay(SESSION_B);

    expect(stateA.events).toHaveLength(2);
    expect(stateA.status).toBe("ended");
    expect(stateB.events).toHaveLength(2);
    expect(stateB.status).toBe("active");
  });

  // ── Test 13: Error count in replayed metrics ─────────────────────────────
  it("replayed metrics correctly count session.error events", () => {
    emit(emitter, "session.start", SESSION_A, T0);
    emit(emitter, "session.error", SESSION_A, T1);
    emit(emitter, "session.error", SESSION_A, T2);
    emit(emitter, "session.end", SESSION_A, T3);

    const state = replayer.replay(SESSION_A);
    expect(state.metrics.errorCount).toBe(2);
    expect(state.metrics.eventCount).toBe(4);
  });

  // ── Test 14: replayRange with empty range returns empty array ────────────
  it("replayRange with range matching no events returns empty array", () => {
    emit(emitter, "session.start", SESSION_A, T0);

    // Range beyond any sequence number
    const range = replayer.replayRange(SESSION_A, 9999, 9999);
    expect(range).toHaveLength(0);
  });

  // ── Test 15: Events in state list are simplified (ISO timestamps) ─────────
  it("replayed state.events list uses ISO string timestamps", () => {
    emit(emitter, "session.start", SESSION_A, T0);

    const state = replayer.replay(SESSION_A);
    expect(typeof state.events[0].timestamp).toBe("string");
    // Should be parseable as a valid date
    expect(Number.isNaN(new Date(state.events[0].timestamp).getTime())).toBe(false);
  });
});
