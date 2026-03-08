import { describe, expect, it } from "vitest";
import { deriveAttentionItems } from "../../../src/monitor/attention/derivation.js";
import type { SessionState } from "../../../src/monitor/types/session.js";
import type { HealthStatus } from "../../../src/monitor/health/types.js";
import type { ComputedMetrics } from "../../../src/monitor/metrics/aggregator.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "active",
    metadata: {
      id: "sess-1",
      name: "Session 1",
      cwd: "/tmp",
      model: "claude",
      startedAt: new Date("2026-03-08T12:00:00.000Z").toISOString(),
      agent: "WorkerOne",
      taskId: "task-1",
    },
    metrics: {
      duration: 60_000,
      eventCount: 3,
      errorCount: 0,
      toolCalls: 1,
      tokensUsed: 100,
    },
    events: [
      {
        type: "session.start",
        timestamp: new Date("2026-03-08T12:00:00.000Z").toISOString(),
        data: {},
      },
    ],
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<ComputedMetrics> = {}): ComputedMetrics {
  return {
    totalEvents: 3,
    errorCount: 0,
    errorRate: 0,
    eventCounts: {},
    activeDurationMs: 60_000,
    toolCalls: 1,
    ...overrides,
  };
}

describe("deriveAttentionItems", () => {
  it("derives waiting-on-human items from paused sessions", () => {
    const session = makeSession({
      status: "paused",
      events: [
        {
          type: "session.pause",
          timestamp: new Date("2026-03-08T12:01:00.000Z").toISOString(),
          data: { reason: "Waiting for operator approval" },
        },
      ],
    });

    const items = deriveAttentionItems([session], new Map(), new Map(), Date.parse("2026-03-08T12:01:30.000Z"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sessionId: session.metadata.id,
      reason: "waiting_on_human",
    });
    expect(items[0].message).toMatch(/approval|waiting/i);
    expect(items[0].recommendedAction).toMatch(/resume|input|operator/i);
  });

  it("derives a stuck item for critical sessions", () => {
    const session = makeSession();
    const healthMap = new Map<string, HealthStatus>([[session.metadata.id, "critical"]]);
    const metricsMap = new Map<string, ComputedMetrics>([[session.metadata.id, makeMetrics()]]);

    const items = deriveAttentionItems([session], healthMap, metricsMap, Date.parse("2026-03-08T12:03:00.000Z"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sessionId: session.metadata.id,
      reason: "stuck",
    });
    expect(items[0].recommendedAction).toMatch(/investigate|inspect|blocked/i);
  });

  it("derives stale-running items for degraded active sessions with old activity", () => {
    const session = makeSession({
      events: [
        {
          type: "agent.progress",
          timestamp: new Date("2026-03-08T12:00:10.000Z").toISOString(),
          data: { message: "still working" },
        },
      ],
    });
    const healthMap = new Map<string, HealthStatus>([[session.metadata.id, "degraded"]]);

    const items = deriveAttentionItems([session], healthMap, new Map(), Date.parse("2026-03-08T12:01:10.000Z"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sessionId: session.metadata.id,
      reason: "stale_running",
    });
    expect(items[0].message).toMatch(/stale|no recent activity/i);
  });

  it("derives degraded items when health is degraded without stale inactivity", () => {
    const session = makeSession({
      events: [
        {
          type: "health.alert",
          timestamp: new Date("2026-03-08T12:00:50.000Z").toISOString(),
          data: { message: "tool latency elevated" },
        },
      ],
    });
    const healthMap = new Map<string, HealthStatus>([[session.metadata.id, "degraded"]]);

    const items = deriveAttentionItems([session], healthMap, new Map(), Date.parse("2026-03-08T12:01:00.000Z"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reason: "degraded",
    });
    expect(items[0].message).toMatch(/latency|degraded/i);
  });

  it("derives repeated-retries items from repeated retry actions", () => {
    const session = makeSession({
      status: "error",
      events: [
        {
          type: "operator.action",
          timestamp: new Date("2026-03-08T12:00:10.000Z").toISOString(),
          data: { action: "retry" },
        },
        {
          type: "operator.action",
          timestamp: new Date("2026-03-08T12:00:20.000Z").toISOString(),
          data: { action: "retry" },
        },
        {
          type: "session.error",
          timestamp: new Date("2026-03-08T12:00:30.000Z").toISOString(),
          data: { message: "Still failing" },
        },
      ],
    });

    const items = deriveAttentionItems([session], new Map(), new Map(), Date.parse("2026-03-08T12:01:00.000Z"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reason: "repeated_retries",
    });
    expect(items[0].recommendedAction).toMatch(/inspect|manual|escalate/i);
  });

  it("derives recoverable failed items with a clear next action", () => {
    const session = makeSession({
      status: "error",
      events: [
        {
          type: "session.error",
          timestamp: new Date("2026-03-08T12:00:30.000Z").toISOString(),
          data: { message: "Tool execution failed" },
        },
      ],
    });

    const items = deriveAttentionItems([session], new Map(), new Map(), Date.parse("2026-03-08T12:01:00.000Z"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reason: "failed_recoverable",
    });
    expect(items[0].message).toMatch(/failed|error/i);
    expect(items[0].recommendedAction).toMatch(/retry|logs|recovery/i);
  });

  it("returns no items for healthy completed sessions", () => {
    const session = makeSession({ status: "ended" });

    const items = deriveAttentionItems([session], new Map(), new Map(), Date.parse("2026-03-08T12:01:00.000Z"));

    expect(items).toEqual([]);
  });
});
