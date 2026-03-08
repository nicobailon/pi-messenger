import { describe, it, expect } from "vitest";
import { renderSessionInspector } from "../../../src/monitor/ui/inspector.js";
import type { SessionState } from "../../../src/monitor/types/session.js";
import type { HealthAlert } from "../../../src/monitor/health/types.js";

describe("Session Inspector", () => {
  it("renders a basic active session correctly", () => {
    const session: SessionState = {
      status: "active",
      metadata: {
        id: "sess-123",
        name: "Test Session",
        cwd: "/tmp",
        model: "gpt-4",
        startedAt: "2026-03-08T00:00:00.000Z",
        agent: "TestAgent",
      },
      metrics: {
        duration: 5000,
        eventCount: 2,
        errorCount: 0,
        toolCalls: 1,
        tokensUsed: 100,
      },
      events: [
        {
          type: "session.start",
          timestamp: "2026-03-08T00:00:00.000Z",
          data: { task: "fix bugs" }
        },
        {
          type: "tool.call",
          timestamp: "2026-03-08T00:00:05.000Z",
          data: { toolName: "ls" }
        }
      ]
    };

    const lines = renderSessionInspector(session, "healthy", undefined, 80);

    expect(lines.some(l => l.includes("Session Inspector") && l.includes("Test Session"))).toBe(true);
    expect(lines.some(l => l.includes("active") && l.includes("healthy"))).toBe(true);
    expect(lines.some(l => l.includes("Task:") && l.includes("fix bugs"))).toBe(true);
    expect(lines.some(l => l.includes("Last Tool:") && l.includes("ls"))).toBe(true);
  });

  it("renders explainable degraded diagnostics with repeat history", () => {
    const session: SessionState = {
      status: "active",
      metadata: {
        id: "sess-123",
        name: "Test Session",
        cwd: "/tmp",
        model: "gpt-4",
        startedAt: "2026-03-08T00:00:00.000Z",
        agent: "TestAgent",
      },
      metrics: {
        duration: 65_000,
        eventCount: 4,
        errorCount: 0,
        toolCalls: 1,
        tokensUsed: 100,
      },
      events: [
        {
          type: "session.start",
          timestamp: "2026-03-08T00:00:00.000Z",
          data: { task: "fix bugs" }
        },
        {
          type: "execution.output",
          timestamp: "2026-03-08T00:00:10.000Z",
          data: { text: "running" }
        }
      ]
    };

    const alert: HealthAlert = {
      sessionId: "sess-123",
      status: "degraded",
      reason: "No recent output for 55s while session is still active.",
      detectedAt: Date.parse("2026-03-08T00:01:05.000Z"),
      explanation: {
        state: "degraded",
        summary: "No recent output for 55s while session is still active.",
        actionable: true,
        recommendedAction: "Check whether the worker is blocked on a slow tool or loop.",
        repeatCount: 3,
        historyCount: 1,
        signals: {
          idleMs: 55_000,
          lastHeartbeatAt: Date.parse("2026-03-08T00:00:10.000Z"),
          lastOutputAt: Date.parse("2026-03-08T00:00:10.000Z"),
          lastToolActivityAt: Date.parse("2026-03-08T00:00:05.000Z"),
          retryCount: 0,
          waiting: false,
          errorRate: 0,
        },
      },
    };

    const lines = renderSessionInspector(session, "degraded", alert, 100);
    const joined = lines.join("\n");

    expect(joined).toContain("No recent output for 55s while session is still active");
    expect(joined).toContain("repeat");
    expect(joined).toContain("3");
    expect(joined).toContain("history");
    expect(joined).toContain("1");
    expect(joined).toContain("Check whether the worker is blocked on a slow tool or loop");
  });
});
