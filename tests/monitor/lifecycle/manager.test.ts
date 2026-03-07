import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionLifecycleManager } from "../../../src/monitor/lifecycle/manager.js";
import { SessionEventEmitter } from "../../../src/monitor/events/emitter.js";
import { SessionStore } from "../../../src/monitor/store/session-store.js";
import type { SessionEvent } from "../../../src/monitor/events/types.js";

// Minimal valid metadata for tests
const baseMetadata = {
  name: "test-session",
  cwd: "/tmp",
  model: "claude-3",
  agent: "test-agent",
};

describe("SessionLifecycleManager", () => {
  let manager: SessionLifecycleManager;
  let emitter: SessionEventEmitter;
  let store: SessionStore;
  let emittedEvents: SessionEvent[];

  beforeEach(() => {
    emitter = new SessionEventEmitter();
    store = new SessionStore();
    manager = new SessionLifecycleManager(store, emitter);
    emittedEvents = [];
    emitter.subscribe((event) => emittedEvents.push(event));
  });

  // ─── start() ─────────────────────────────────────────────────────────────

  it("start() returns a session ID", () => {
    const id = manager.start(baseMetadata);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("start() creates session in active state", () => {
    const id = manager.start(baseMetadata);
    expect(manager.getState(id)).toBe("active");
  });

  it("start() emits a session.start event", () => {
    const id = manager.start(baseMetadata);
    const startEvent = emittedEvents.find((e) => e.type === "session.start");
    expect(startEvent).toBeDefined();
    expect(startEvent?.sessionId).toBe(id);
  });

  it("start() uses provided id when given", () => {
    const id = manager.start({ ...baseMetadata, id: "custom-id" });
    expect(id).toBe("custom-id");
  });

  // ─── pause() ─────────────────────────────────────────────────────────────

  it("pause() transitions active → paused", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id);
    expect(manager.getState(id)).toBe("paused");
  });

  it("pause() emits a session.pause event", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id, "user requested");
    const pauseEvent = emittedEvents.find((e) => e.type === "session.pause");
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent?.sessionId).toBe(id);
    expect((pauseEvent?.payload as any).reason).toBe("user requested");
  });

  it("pause() throws on invalid transition (idle → paused)", () => {
    // Create session but don't start it — leave in idle
    store.create({
      id: "idle-session",
      name: "test",
      cwd: "/tmp",
      model: "gpt-4",
      agent: "agent",
      startedAt: new Date().toISOString(),
    });
    expect(() => manager.pause("idle-session")).toThrow(/idle.*paused|Invalid lifecycle transition/i);
  });

  it("pause() throws for non-existent session", () => {
    expect(() => manager.pause("no-such-id")).toThrow(/Session not found/);
  });

  // ─── resume() ────────────────────────────────────────────────────────────

  it("resume() transitions paused → active", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id);
    manager.resume(id);
    expect(manager.getState(id)).toBe("active");
  });

  it("resume() emits a session.resume event", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id);
    manager.resume(id, "coordinator");
    const resumeEvent = emittedEvents.find((e) => e.type === "session.resume");
    expect(resumeEvent).toBeDefined();
    expect((resumeEvent?.payload as any).resumedBy).toBe("coordinator");
  });

  it("resume() throws when session is not paused (active)", () => {
    const id = manager.start(baseMetadata);
    expect(() => manager.resume(id)).toThrow(/active.*active|Invalid lifecycle transition/i);
  });

  // ─── end() ───────────────────────────────────────────────────────────────

  it("end() transitions active → ended", () => {
    const id = manager.start(baseMetadata);
    manager.end(id);
    expect(manager.getState(id)).toBe("ended");
  });

  it("end() transitions paused → ended", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id);
    manager.end(id, "completed");
    expect(manager.getState(id)).toBe("ended");
  });

  it("end() emits a session.end event with summary", () => {
    const id = manager.start(baseMetadata);
    manager.end(id, "task complete");
    const endEvent = emittedEvents.find((e) => e.type === "session.end");
    expect(endEvent).toBeDefined();
    expect((endEvent?.payload as any).summary).toBe("task complete");
  });

  it("end() throws on invalid transition (ended → ended)", () => {
    const id = manager.start(baseMetadata);
    manager.end(id);
    expect(() => manager.end(id)).toThrow(/Invalid lifecycle transition/);
  });

  // ─── getState() ──────────────────────────────────────────────────────────

  it("getState() returns undefined for unknown session", () => {
    expect(manager.getState("unknown")).toBeUndefined();
  });

  it("getState() reflects state changes throughout lifecycle", () => {
    const id = manager.start(baseMetadata);
    expect(manager.getState(id)).toBe("active");
    manager.pause(id);
    expect(manager.getState(id)).toBe("paused");
    manager.resume(id);
    expect(manager.getState(id)).toBe("active");
    manager.end(id);
    expect(manager.getState(id)).toBe("ended");
  });

  // ─── Event ordering ───────────────────────────────────────────────────────

  it("events have monotonically increasing sequence numbers per session", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id);
    manager.resume(id);
    manager.end(id);

    const sessionEvents = emittedEvents.filter((e) => e.sessionId === id);
    const sequences = sessionEvents.map((e) => e.sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
  });

  // ─── State consistency ────────────────────────────────────────────────────

  it("store reflects the same state as getState()", () => {
    const id = manager.start(baseMetadata);
    manager.pause(id);
    const storeState = manager.getStore().get(id);
    expect(storeState?.status).toBe(manager.getState(id));
  });
});
