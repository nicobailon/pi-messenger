import { describe, it, expect } from "vitest";
import {
  SessionStatusSchema,
  SessionMetadataSchema,
  SessionMetricsSchema,
  SessionEventSchema,
  SessionStateSchema,
} from "../../../src/monitor/types/session.js";

const validMetadata = {
  id: "sess-001",
  name: "Test Session",
  cwd: "/home/user/project",
  model: "claude-opus-4",
  startedAt: "2026-03-07T12:00:00.000Z",
  agent: "TestAgent",
};

const validMetrics = {
  duration: 3600,
  eventCount: 42,
  errorCount: 0,
  toolCalls: 10,
  tokensUsed: 5000,
};

const validEvent = {
  type: "tool_call",
  timestamp: "2026-03-07T12:01:00.000Z",
  data: { tool: "bash" },
};

describe("SessionStatusSchema", () => {
  it("parses valid status values", () => {
    expect(SessionStatusSchema.parse("idle")).toBe("idle");
    expect(SessionStatusSchema.parse("active")).toBe("active");
    expect(SessionStatusSchema.parse("paused")).toBe("paused");
    expect(SessionStatusSchema.parse("ended")).toBe("ended");
    expect(SessionStatusSchema.parse("error")).toBe("error");
  });

  it("rejects invalid status", () => {
    expect(() => SessionStatusSchema.parse("unknown")).toThrow();
    expect(() => SessionStatusSchema.parse("")).toThrow();
    expect(() => SessionStatusSchema.parse(null)).toThrow();
  });
});

describe("SessionMetadataSchema", () => {
  it("parses valid metadata", () => {
    const result = SessionMetadataSchema.parse(validMetadata);
    expect(result.id).toBe("sess-001");
    expect(result.agent).toBe("TestAgent");
  });

  it("rejects missing required fields", () => {
    expect(() => SessionMetadataSchema.parse({ id: "x" })).toThrow();
  });

  it("rejects invalid datetime format", () => {
    expect(() =>
      SessionMetadataSchema.parse({ ...validMetadata, startedAt: "not-a-date" })
    ).toThrow();
  });
});

describe("SessionMetricsSchema", () => {
  it("parses valid metrics", () => {
    const result = SessionMetricsSchema.parse(validMetrics);
    expect(result.duration).toBe(3600);
    expect(result.toolCalls).toBe(10);
  });

  it("rejects negative values", () => {
    expect(() =>
      SessionMetricsSchema.parse({ ...validMetrics, duration: -1 })
    ).toThrow();
    expect(() =>
      SessionMetricsSchema.parse({ ...validMetrics, errorCount: -5 })
    ).toThrow();
  });

  it("rejects non-integer counts", () => {
    expect(() =>
      SessionMetricsSchema.parse({ ...validMetrics, eventCount: 1.5 })
    ).toThrow();
  });
});

describe("SessionStateSchema", () => {
  it("parses a full valid session state", () => {
    const state = {
      status: "active",
      metadata: validMetadata,
      metrics: validMetrics,
      events: [validEvent],
    };
    const result = SessionStateSchema.parse(state);
    expect(result.status).toBe("active");
    expect(result.events).toHaveLength(1);
  });

  it("parses state with empty events array", () => {
    const state = {
      status: "idle",
      metadata: validMetadata,
      metrics: { ...validMetrics, eventCount: 0 },
      events: [],
    };
    const result = SessionStateSchema.parse(state);
    expect(result.events).toHaveLength(0);
  });

  it("rejects state with invalid status", () => {
    expect(() =>
      SessionStateSchema.parse({
        status: "running",
        metadata: validMetadata,
        metrics: validMetrics,
        events: [],
      })
    ).toThrow();
  });

  it("rejects state missing metadata", () => {
    expect(() =>
      SessionStateSchema.parse({
        status: "active",
        metrics: validMetrics,
        events: [],
      })
    ).toThrow();
  });
});

describe("SessionEventSchema", () => {
  it("parses event with optional data", () => {
    const noData = { type: "ping", timestamp: "2026-03-07T12:00:00.000Z" };
    const result = SessionEventSchema.parse(noData);
    expect(result.type).toBe("ping");
    expect(result.data).toBeUndefined();
  });

  it("rejects event with invalid timestamp", () => {
    expect(() =>
      SessionEventSchema.parse({ type: "x", timestamp: "bad" })
    ).toThrow();
  });
});
