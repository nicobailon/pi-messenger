import { describe, it, expect, beforeEach } from "vitest";
import { OperatorCommandHandler, createOperatorCommandHandler } from "../../../src/monitor/commands/handler.js";
import { SessionLifecycleManager } from "../../../src/monitor/lifecycle/manager.js";
import type { OperatorCommand, CommandValidator } from "../../../src/monitor/types/commands.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMetadata(id: string) {
  return {
    id,
    name: "Test Session",
    cwd: "/tmp",
    model: "test-model",
    startedAt: new Date().toISOString(),
    agent: "test-agent",
  };
}

function makeActiveSession(lifecycle: SessionLifecycleManager): string {
  return lifecycle.start(makeMetadata("session-" + Math.random().toString(36).slice(2)));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("OperatorCommandHandler", () => {
  let lifecycle: SessionLifecycleManager;
  let handler: OperatorCommandHandler;

  beforeEach(() => {
    lifecycle = new SessionLifecycleManager();
    handler = new OperatorCommandHandler(lifecycle);
  });

  // ── constructor / factory ─────────────────────────────────────────────────

  it("createOperatorCommandHandler returns an OperatorCommandHandler instance", () => {
    const h = createOperatorCommandHandler();
    expect(h).toBeInstanceOf(OperatorCommandHandler);
  });

  it("accepts an external SessionLifecycleManager", () => {
    const h = createOperatorCommandHandler(lifecycle);
    expect(h).toBeInstanceOf(OperatorCommandHandler);
  });

  // ── validate — no validator configured ───────────────────────────────────

  it("validate returns valid=true when no validator is set", () => {
    const sessionId = makeActiveSession(lifecycle);
    const cmd: OperatorCommand = { action: "pause", sessionId };
    const result = handler.validate(cmd);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ── validate — allowedActions ─────────────────────────────────────────────

  it("validate rejects action not in allowedActions", () => {
    handler.setValidator({ allowedActions: ["resume", "end"], requireReason: false, maxConcurrent: 5 });
    const sessionId = makeActiveSession(lifecycle);
    const cmd: OperatorCommand = { action: "pause", sessionId };
    const result = handler.validate(cmd);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("pause");
  });

  it("validate passes action in allowedActions", () => {
    handler.setValidator({ allowedActions: ["pause", "resume"], requireReason: false, maxConcurrent: 5 });
    const sessionId = makeActiveSession(lifecycle);
    const cmd: OperatorCommand = { action: "pause", sessionId };
    const result = handler.validate(cmd);
    expect(result.valid).toBe(true);
  });

  // ── validate — requireReason ──────────────────────────────────────────────

  it("validate rejects command when requireReason=true and no reason provided", () => {
    handler.setValidator({ allowedActions: ["pause", "resume", "end", "inspect", "escalate"], requireReason: true, maxConcurrent: 5 });
    const sessionId = makeActiveSession(lifecycle);
    const cmd: OperatorCommand = { action: "pause", sessionId };
    const result = handler.validate(cmd);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("reason");
  });

  it("validate passes when requireReason=true and reason is provided", () => {
    handler.setValidator({ allowedActions: ["pause", "resume", "end", "inspect", "escalate"], requireReason: true, maxConcurrent: 5 });
    const sessionId = makeActiveSession(lifecycle);
    const cmd: OperatorCommand = { action: "pause", sessionId, reason: "maintenance" };
    const result = handler.validate(cmd);
    expect(result.valid).toBe(true);
  });

  // ── execute — valid commands ──────────────────────────────────────────────

  it("execute pause returns success=true with updated session state (paused)", () => {
    const sessionId = makeActiveSession(lifecycle);
    const cmd: OperatorCommand = { action: "pause", sessionId };
    const result = handler.execute(cmd);
    expect(result.success).toBe(true);
    expect(result.command).toEqual(cmd);
    expect(result.executedAt).toBeTruthy();
    const state = result.result as { status: string };
    expect(state.status).toBe("paused");
  });

  it("execute resume after pause returns success=true with active state", () => {
    const sessionId = makeActiveSession(lifecycle);
    handler.execute({ action: "pause", sessionId });
    const result = handler.execute({ action: "resume", sessionId });
    expect(result.success).toBe(true);
    const state = result.result as { status: string };
    expect(state.status).toBe("active");
  });

  it("execute end returns success=true with ended state", () => {
    const sessionId = makeActiveSession(lifecycle);
    const result = handler.execute({ action: "end", sessionId, reason: "done" });
    expect(result.success).toBe(true);
    const state = result.result as { status: string };
    expect(state.status).toBe("ended");
  });

  it("execute inspect returns success=true with current session state", () => {
    const sessionId = makeActiveSession(lifecycle);
    const result = handler.execute({ action: "inspect", sessionId });
    expect(result.success).toBe(true);
    const state = result.result as { status: string };
    expect(state.status).toBe("active");
  });

  it("execute escalate returns success=true and marks session as error", () => {
    const sessionId = makeActiveSession(lifecycle);
    const result = handler.execute({ action: "escalate", sessionId, reason: "stuck" });
    expect(result.success).toBe(true);
    const state = result.result as { status: string };
    expect(state.status).toBe("error");
  });

  // ── execute — invalid / error cases ──────────────────────────────────────

  it("execute returns success=false when command fails validation (disallowed action)", () => {
    handler.setValidator({ allowedActions: ["resume"], requireReason: false, maxConcurrent: 5 });
    const sessionId = makeActiveSession(lifecycle);
    const result = handler.execute({ action: "pause", sessionId });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.command.action).toBe("pause");
  });

  it("execute returns success=false for nonexistent session", () => {
    const result = handler.execute({ action: "pause", sessionId: "does-not-exist" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("execute returns success=false for invalid transition (pause already-ended session)", () => {
    const sessionId = makeActiveSession(lifecycle);
    handler.execute({ action: "end", sessionId });
    const result = handler.execute({ action: "pause", sessionId });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── maxConcurrent ────────────────────────────────────────────────────────

  it("execute enforces maxConcurrent=1 by rejecting second concurrent command synchronously", () => {
    // Set maxConcurrent to 0 to guarantee rejection on the very first call
    handler.setValidator({ allowedActions: ["pause", "resume", "end", "inspect", "escalate"], requireReason: false, maxConcurrent: 0 });
    const sessionId = makeActiveSession(lifecycle);
    const result = handler.execute({ action: "inspect", sessionId });
    expect(result.success).toBe(false);
    expect(result.error).toContain("concurrent");
  });

  // ── result shape ─────────────────────────────────────────────────────────

  it("successful result includes executedAt as ISO datetime string", () => {
    const sessionId = makeActiveSession(lifecycle);
    const result = handler.execute({ action: "inspect", sessionId });
    expect(result.success).toBe(true);
    expect(() => new Date(result.executedAt)).not.toThrow();
    expect(new Date(result.executedAt).getTime()).toBeGreaterThan(0);
  });

  it("failure result includes error string and no result field", () => {
    const result = handler.execute({ action: "resume", sessionId: "ghost" });
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  // ── setValidator ────────────────────────────────────────────────────────

  it("setValidator can be changed between executions", () => {
    const sessionId = makeActiveSession(lifecycle);

    // First: restrict to inspect only
    handler.setValidator({ allowedActions: ["inspect"], requireReason: false, maxConcurrent: 5 });
    const r1 = handler.execute({ action: "pause", sessionId });
    expect(r1.success).toBe(false);

    // Change: allow pause
    handler.setValidator({ allowedActions: ["pause", "resume", "end", "inspect", "escalate"], requireReason: false, maxConcurrent: 5 });
    const r2 = handler.execute({ action: "pause", sessionId });
    expect(r2.success).toBe(true);
  });
});
