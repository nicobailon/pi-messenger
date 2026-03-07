import { describe, it, expect } from "vitest";
import {
  OperatorCommandSchema,
  CommandResultSchema,
  CommandValidatorSchema,
} from "../../../src/monitor/types/commands.js";

describe("OperatorCommandSchema", () => {
  it("parses a valid pause command", () => {
    const result = OperatorCommandSchema.parse({ action: "pause", sessionId: "sess-1" });
    expect(result.action).toBe("pause");
    expect(result.sessionId).toBe("sess-1");
  });

  it("parses a valid resume command", () => {
    const result = OperatorCommandSchema.parse({ action: "resume", sessionId: "sess-2" });
    expect(result.action).toBe("resume");
  });

  it("parses a valid end command with optional reason", () => {
    const result = OperatorCommandSchema.parse({ action: "end", sessionId: "sess-3", reason: "done" });
    expect(result.action).toBe("end");
    expect(result.reason).toBe("done");
  });

  it("parses a valid inspect command", () => {
    const result = OperatorCommandSchema.parse({ action: "inspect", sessionId: "sess-4" });
    expect(result.action).toBe("inspect");
  });

  it("parses a valid escalate command", () => {
    const result = OperatorCommandSchema.parse({ action: "escalate", sessionId: "sess-5", reason: "urgent" });
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("urgent");
  });

  it("rejects an invalid action value", () => {
    expect(() =>
      OperatorCommandSchema.parse({ action: "delete", sessionId: "sess-1" })
    ).toThrow();
  });

  it("rejects a command missing sessionId", () => {
    expect(() =>
      OperatorCommandSchema.parse({ action: "pause" })
    ).toThrow();
  });

  it("narrows type correctly on action field", () => {
    const cmd = OperatorCommandSchema.parse({ action: "pause", sessionId: "sess-1" });
    if (cmd.action === "pause") {
      expect(cmd.sessionId).toBeDefined();
    }
  });
});

describe("CommandResultSchema", () => {
  it("parses a successful command result", () => {
    const result = CommandResultSchema.parse({
      success: true,
      command: { action: "pause", sessionId: "sess-1" },
      executedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("parses a failed command result with error", () => {
    const result = CommandResultSchema.parse({
      success: false,
      command: { action: "end", sessionId: "sess-2" },
      error: "Session not found",
      executedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Session not found");
  });
});

describe("CommandValidatorSchema", () => {
  it("parses a valid validator config", () => {
    const result = CommandValidatorSchema.parse({
      allowedActions: ["pause", "resume", "end"],
      requireReason: false,
      maxConcurrent: 5,
    });
    expect(result.allowedActions).toContain("pause");
    expect(result.maxConcurrent).toBe(5);
  });

  it("rejects zero maxConcurrent", () => {
    expect(() =>
      CommandValidatorSchema.parse({
        allowedActions: ["pause"],
        requireReason: false,
        maxConcurrent: 0,
      })
    ).toThrow();
  });

  it("rejects invalid action in allowedActions", () => {
    expect(() =>
      CommandValidatorSchema.parse({
        allowedActions: ["pause", "delete"],
        requireReason: false,
        maxConcurrent: 1,
      })
    ).toThrow();
  });
});
