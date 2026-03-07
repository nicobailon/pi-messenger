import { describe, it, expect } from "vitest";
import {
  OperatorActionSchema,
  OperatorPresenceSchema,
  OperatorStateSchema,
} from "../../../src/monitor/types/operator.js";

const validPresence = {
  agentName: "UltraArrow",
  role: "operator",
  joinedAt: "2026-03-07T10:00:00.000Z",
  lastActiveAt: "2026-03-07T12:00:00.000Z",
  status: "online" as const,
};

describe("OperatorActionSchema", () => {
  it("parses all valid operator actions", () => {
    expect(OperatorActionSchema.parse("pause")).toBe("pause");
    expect(OperatorActionSchema.parse("resume")).toBe("resume");
    expect(OperatorActionSchema.parse("end")).toBe("end");
    expect(OperatorActionSchema.parse("inspect")).toBe("inspect");
    expect(OperatorActionSchema.parse("escalate")).toBe("escalate");
  });

  it("rejects invalid action strings", () => {
    expect(() => OperatorActionSchema.parse("kill")).toThrow();
    expect(() => OperatorActionSchema.parse("start")).toThrow();
    expect(() => OperatorActionSchema.parse("")).toThrow();
  });
});

describe("OperatorPresenceSchema", () => {
  it("parses valid presence", () => {
    const result = OperatorPresenceSchema.parse(validPresence);
    expect(result.agentName).toBe("UltraArrow");
    expect(result.status).toBe("online");
  });

  it("parses all valid status values", () => {
    expect(OperatorPresenceSchema.parse({ ...validPresence, status: "idle" }).status).toBe("idle");
    expect(OperatorPresenceSchema.parse({ ...validPresence, status: "offline" }).status).toBe("offline");
  });

  it("rejects invalid status", () => {
    expect(() =>
      OperatorPresenceSchema.parse({ ...validPresence, status: "away" })
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      OperatorPresenceSchema.parse({ agentName: "X" })
    ).toThrow();
  });

  it("rejects invalid datetime", () => {
    expect(() =>
      OperatorPresenceSchema.parse({ ...validPresence, joinedAt: "not-a-date" })
    ).toThrow();
  });
});

describe("OperatorStateSchema", () => {
  it("parses valid operator state with active session", () => {
    const state = {
      presence: validPresence,
      permissions: ["pause", "resume", "inspect"],
      activeSession: "sess-001",
    };
    const result = OperatorStateSchema.parse(state);
    expect(result.activeSession).toBe("sess-001");
    expect(result.permissions).toHaveLength(3);
  });

  it("parses state with null activeSession", () => {
    const state = {
      presence: validPresence,
      permissions: [],
      activeSession: null,
    };
    const result = OperatorStateSchema.parse(state);
    expect(result.activeSession).toBeNull();
  });

  it("rejects invalid permission actions", () => {
    expect(() =>
      OperatorStateSchema.parse({
        presence: validPresence,
        permissions: ["invalid-action"],
        activeSession: null,
      })
    ).toThrow();
  });

  it("rejects missing presence", () => {
    expect(() =>
      OperatorStateSchema.parse({
        permissions: [],
        activeSession: null,
      })
    ).toThrow();
  });
});
