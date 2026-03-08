import { describe, it, expect } from "vitest";
import {
  EventCategorySchema,
  EventTypeSchema,
  SessionEventSchema,
  SessionEventPayloadSchema,
  StreamConfigSchema,
  GroupedEventSchema,
  SessionStartPayloadSchema,
  SessionErrorPayloadSchema,
  AgentThinkingPayloadSchema,
  AgentWaitingPayloadSchema,
  AgentProgressPayloadSchema,
  ExecutionStartPayloadSchema,
  ExecutionOutputPayloadSchema,
  ExecutionEndPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  HealthCheckPayloadSchema,
  HealthAlertPayloadSchema,
  MetricsSnapshotPayloadSchema,
} from "../../../src/monitor/events/index.js";

describe("EventCategorySchema", () => {
  it("parses all valid event categories", () => {
    const categories = [
      "thinking",
      "execution",
      "tool",
      "progress",
      "waiting",
      "lifecycle",
    ];

    for (const c of categories) {
      expect(EventCategorySchema.parse(c)).toBe(c);
    }
  });

  it("rejects unknown categories", () => {
    expect(() => EventCategorySchema.parse("invalid")).toThrow();
  });
});

describe("EventTypeSchema", () => {
  it("parses all valid event types", () => {
    const types = [
      "session.start",
      "session.pause",
      "session.resume",
      "session.end",
      "session.error",
      "tool.call",
      "tool.result",
      "operator.action",
      "health.check",
      "health.alert",
      "metrics.snapshot",
      "agent.thinking",
      "agent.waiting",
      "agent.progress",
      "execution.start",
      "execution.output",
      "execution.end",
    ];

    for (const t of types) {
      expect(EventTypeSchema.parse(t)).toBe(t);
    }
  });

  it("rejects unknown event types", () => {
    expect(() => EventTypeSchema.parse("unknown.type")).toThrow();
  });
});

describe("SessionEventPayloadSchema — discriminated union", () => {
  it("parses session.start payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "session.start",
      agentName: "PurePhoenix",
      model: "claude-3-5-sonnet",
    });
    expect(result.type).toBe("session.start");
    if (result.type === "session.start") {
      expect(result.agentName).toBe("PurePhoenix");
    }
  });

  it("narrows payload type for session.error", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "session.error",
      message: "Something went wrong",
      fatal: true,
    });
    expect(result.type).toBe("session.error");
    if (result.type === "session.error") {
      expect(result.message).toBe("Something went wrong");
      expect(result.fatal).toBe(true);
    }
  });

  it("parses agent.thinking payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "agent.thinking",
      message: "Considering options",
      metadata: { model: "claude" },
    });
    expect(result.type).toBe("agent.thinking");
    if (result.type === "agent.thinking") {
      expect(result.message).toBe("Considering options");
    }
  });

  it("parses agent.waiting payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "agent.waiting",
      reason: "For API response",
      etaMs: 250,
    });
    expect(result.type).toBe("agent.waiting");
    if (result.type === "agent.waiting") {
      expect(result.reason).toBe("For API response");
    }
  });

  it("parses agent.progress payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "agent.progress",
      message: "Halfway done",
      progress: 0.5,
      step: "analysis",
    });
    expect(result.type).toBe("agent.progress");
    if (result.type === "agent.progress") {
      expect(result.progress).toBe(0.5);
    }
  });

  it("parses execution.start payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "execution.start",
      command: "npm test",
    });
    expect(result.type).toBe("execution.start");
    if (result.type === "execution.start") {
      expect(result.command).toBe("npm test");
    }
  });

  it("parses execution.output payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "execution.output",
      text: "done\n",
      stream: "stdout",
    });
    expect(result.type).toBe("execution.output");
    if (result.type === "execution.output") {
      expect(result.text).toBe("done\n");
    }
  });

  it("parses execution.end payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "execution.end",
      exitCode: 0,
      success: true,
      durationMs: 180,
    });
    expect(result.type).toBe("execution.end");
    if (result.type === "execution.end") {
      expect(result.success).toBe(true);
    }
  });

  it("parses tool.call payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "tool.call",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(result.type).toBe("tool.call");
    if (result.type === "tool.call") {
      expect(result.toolName).toBe("bash");
    }
  });

  it("parses tool.result payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "tool.result",
      toolName: "bash",
      success: true,
      durationMs: 123,
    });
    expect(result.type).toBe("tool.result");
    if (result.type === "tool.result") {
      expect(result.success).toBe(true);
    }
  });

  it("parses health.check payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "health.check",
      status: "healthy",
      checks: { db: true, net: true },
    });
    expect(result.type).toBe("health.check");
    if (result.type === "health.check") {
      expect(result.status).toBe("healthy");
    }
  });

  it("parses health.alert payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "health.alert",
      severity: "critical",
      message: "Memory exceeded",
    });
    expect(result.type).toBe("health.alert");
    if (result.type === "health.alert") {
      expect(result.severity).toBe("critical");
    }
  });

  it("parses metrics.snapshot payload", () => {
    const result = SessionEventPayloadSchema.parse({
      type: "metrics.snapshot",
      toolCallCount: 42,
      errorCount: 1,
      uptimeMs: 60000,
      memoryMb: 256,
    });
    expect(result.type).toBe("metrics.snapshot");
    if (result.type === "metrics.snapshot") {
      expect(result.toolCallCount).toBe(42);
    }
  });

  it("rejects payload with unknown type", () => {
    expect(() =>
      SessionEventPayloadSchema.parse({
        type: "unknown",
        data: "foo",
      })
    ).toThrow();
  });

  it("rejects session.error payload missing required message", () => {
    expect(() =>
      SessionErrorPayloadSchema.parse({
        type: "session.error",
        // message missing
      })
    ).toThrow();
  });

  it("rejects agent.thinking payload missing required message", () => {
    expect(() =>
      AgentThinkingPayloadSchema.parse({
        type: "agent.thinking",
      })
    ).toThrow();
  });

  it("rejects execution.start payload missing required command", () => {
    expect(() =>
      ExecutionStartPayloadSchema.parse({
        type: "execution.start",
      })
    ).toThrow();
  });

  it("rejects execution.output payload missing required text", () => {
    expect(() =>
      ExecutionOutputPayloadSchema.parse({
        type: "execution.output",
      })
    ).toThrow();
  });

  it("rejects execution.end payload with non-integer exitCode", () => {
    expect(() =>
      ExecutionEndPayloadSchema.parse({
        type: "execution.end",
        exitCode: 1.2,
      })
    ).toThrow();
  });

  it("rejects agent.progress payload with invalid progress", () => {
    expect(() =>
      AgentProgressPayloadSchema.parse({
        type: "agent.progress",
        progress: 1.2,
      })
    ).toThrow();
  });
});

describe("SessionEventSchema", () => {
  it("parses a complete valid event", () => {
    const event = SessionEventSchema.parse({
      id: "evt-001",
      type: "session.start",
      sessionId: "sess-abc",
      timestamp: Date.now(),
      payload: {
        type: "session.start",
        agentName: "TestAgent",
      },
      sequence: 0,
    });
    expect(event.id).toBe("evt-001");
    expect(event.type).toBe("session.start");
    expect(event.category).toBe("lifecycle");
    expect(event.sequence).toBe(0);
  });

  it("derives event category when omitted", () => {
    const event = SessionEventSchema.parse({
      id: "evt-002",
      type: "agent.thinking",
      sessionId: "sess-abc",
      timestamp: Date.now(),
      payload: {
        type: "agent.thinking",
        message: "Planning",
      },
      sequence: 0,
    });
    expect(event.category).toBe("thinking");
  });

  it("accepts explicit event category", () => {
    const event = SessionEventSchema.parse({
      id: "evt-003",
      type: "execution.start",
      category: "execution",
      sessionId: "sess-abc",
      timestamp: Date.now(),
      payload: {
        type: "execution.start",
        command: "npm test",
      },
      sequence: 0,
    });
    expect(event.category).toBe("execution");
  });

  it("rejects event with negative sequence", () => {
    expect(() =>
      SessionEventSchema.parse({
        id: "evt-004",
        type: "session.end",
        sessionId: "sess-abc",
        timestamp: Date.now(),
        payload: { type: "session.end" },
        sequence: -1,
      })
    ).toThrow();
  });
});

describe("GroupedEventSchema", () => {
  it("parses a valid grouped event", () => {
    const group = GroupedEventSchema.parse({
      category: "tool",
      events: [
        {
          id: "evt-005",
          type: "tool.call",
          category: "tool",
          sessionId: "sess-abc",
          timestamp: Date.now(),
          payload: { type: "tool.call", toolName: "bash" },
          sequence: 1,
        },
      ],
    });

    expect(group.category).toBe("tool");
    expect(group.events).toHaveLength(1);
    expect(group.count).toBe(1);
  });
});

describe("StreamConfigSchema", () => {
  it("applies default values when no config provided", () => {
    const config = StreamConfigSchema.parse({});
    expect(config.bufferSize).toBe(100);
    expect(config.replayFromOffset).toBe(0);
    expect(config.filterTypes).toEqual([]);
    expect(config.filterCategories).toEqual([]);
    expect(config.dedupeWarnings).toBe(false);
    expect(config.maxAge).toBeUndefined();
  });

  it("accepts custom values overriding defaults", () => {
    const config = StreamConfigSchema.parse({
      bufferSize: 500,
      replayFromOffset: 10,
      filterTypes: ["session.start", "session.end", "execution.start"],
      filterCategories: ["lifecycle", "execution"],
      dedupeWarnings: true,
      maxAge: 3600000,
    });
    expect(config.bufferSize).toBe(500);
    expect(config.replayFromOffset).toBe(10);
    expect(config.filterTypes).toEqual(["session.start", "session.end", "execution.start"]);
    expect(config.filterCategories).toEqual(["lifecycle", "execution"]);
    expect(config.dedupeWarnings).toBe(true);
    expect(config.maxAge).toBe(3600000);
  });

  it("rejects bufferSize of 0 (must be positive)", () => {
    expect(() =>
      StreamConfigSchema.parse({ bufferSize: 0 })
    ).toThrow();
  });
});
