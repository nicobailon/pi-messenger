import { describe, expect, it } from "vitest";
import {
  SessionDetailView,
  renderSessionDetailView,
  stripDetailAnsi,
} from "../../../src/monitor/ui/session-detail.js";
import type { SessionState } from "../../../src/monitor/types/session.js";
import type { HealthAlert, HealthStatus } from "../../../src/monitor/health/types.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "active",
    metadata: {
      id: "sess-1",
      name: "Scout River",
      cwd: "/tmp/project",
      model: "claude-haiku",
      startedAt: "2026-03-08T03:00:00.000Z",
      agent: "ScoutAgent",
      taskId: "task-42",
    },
    metrics: {
      duration: 180_000,
      eventCount: 7,
      errorCount: 0,
      toolCalls: 2,
      tokensUsed: 320,
    },
    events: [
      {
        type: "session.start",
        timestamp: "2026-03-08T03:00:00.000Z",
        data: { task: "Investigate monitor" },
      },
      {
        type: "agent.thinking",
        timestamp: "2026-03-08T03:00:05.000Z",
        data: { message: "Tracing the session graph" },
      },
      {
        type: "tool.call",
        timestamp: "2026-03-08T03:00:10.000Z",
        data: { toolName: "read", args: { path: "src/monitor/ui/panel.ts" } },
      },
      {
        type: "agent.progress",
        timestamp: "2026-03-08T03:00:15.000Z",
        data: { message: "RED: wrote failing detail-view test" },
      },
      {
        type: "execution.output",
        timestamp: "2026-03-08T03:00:20.000Z",
        data: { text: "FAIL tests/monitor/ui/session-detail.test.ts" },
      },
      {
        type: "session.error",
        timestamp: "2026-03-08T03:00:25.000Z",
        data: { message: "Temporary tool timeout" },
      },
      {
        type: "session.end",
        timestamp: "2026-03-08T03:00:30.000Z",
        data: { summary: "Completed detail view" },
      },
    ],
    ...overrides,
  } as SessionState;
}

function makeAlert(overrides: Partial<HealthAlert> = {}): HealthAlert {
  return {
    sessionId: "sess-1",
    status: "critical",
    reason: "No new output or tool activity for 125s.",
    detectedAt: Date.parse("2026-03-08T03:02:05.000Z"),
    explanation: {
      state: "stuck",
      summary: "No new output or tool activity for 125s.",
      actionable: true,
      recommendedAction: "Inspect the worker and retry if it is no longer making progress.",
      repeatCount: 4,
      historyCount: 2,
      signals: {
        idleMs: 125_000,
        lastHeartbeatAt: Date.parse("2026-03-08T03:00:00.000Z"),
        lastOutputAt: Date.parse("2026-03-08T03:00:20.000Z"),
        lastToolActivityAt: Date.parse("2026-03-08T03:00:10.000Z"),
        retryCount: 1,
        waiting: false,
        errorRate: 0.25,
      },
    },
    ...overrides,
  };
}

describe("renderSessionDetailView", () => {
  it("renders session metadata in the header including last activity", () => {
    const session = makeSession({
      events: [
        {
          type: "session.start",
          timestamp: "2026-03-08T03:00:00.000Z",
          data: { task: "Investigate monitor" },
        },
        {
          type: "agent.progress",
          timestamp: "2026-03-08T03:00:45.000Z",
          data: { message: "Still analyzing" },
        },
      ],
    });

    const lines = renderSessionDetailView(session, "healthy", 120, 18, Date.parse("2026-03-08T03:01:00.000Z"));
    const plain = stripDetailAnsi(lines.join("\n"));

    expect(plain).toContain("Session Detail");
    expect(plain).toContain("ScoutAgent");
    expect(plain).toContain("task-42");
    expect(plain).toContain("active");
    expect(plain).toContain("healthy");
    expect(plain).toContain("2026-03-08 03:00:00Z");
    expect(plain).toContain("Last activity");
    expect(plain).toContain("2026-03-08 03:00:45Z");
    expect(plain).toContain("2026-03-08 03:01:00Z");
  });

  it("renders visually distinguishable thinking, tool, progress, execution, error, and completion entries", () => {
    const lines = renderSessionDetailView(makeSession({ status: "ended" }), "healthy", 120, 18, Date.parse("2026-03-08T03:00:30.000Z"));
    const plain = stripDetailAnsi(lines.join("\n"));

    expect(plain).toContain("🧠 THINK");
    expect(plain).toContain("🛠 TOOL");
    expect(plain).toContain("📈 PROGRESS");
    expect(plain).toContain("⚡ EXEC");
    expect(plain).toContain("❗ ERROR");
    expect(plain).toContain("✅ DONE");
    expect(plain).toContain("Tracing the session graph");
    expect(plain).toContain("Running read");
    expect(plain).toContain("RED: wrote failing detail-view test");
    expect(plain).toContain("FAIL tests/monitor/ui/session-detail.test.ts");
    expect(plain).toContain("Temporary tool timeout");
    expect(plain).toContain("Completed detail view");
  });

  it("shows explainable stuck diagnostics with repeat history", () => {
    const lines = renderSessionDetailView(
      makeSession(),
      "critical",
      120,
      20,
      Date.parse("2026-03-08T03:02:05.000Z"),
      makeAlert(),
    );
    const plain = stripDetailAnsi(lines.join("\n"));

    expect(plain).toContain("No new output or tool activity for 125s");
    expect(plain).toContain("repeat");
    expect(plain).toContain("4");
    expect(plain).toContain("history");
    expect(plain).toContain("2");
    expect(plain).toContain("Inspect the worker and retry if it is no longer making progress");
  });

  it("keeps long stream content readable within display width", () => {
    const session = makeSession({
      events: [
        {
          type: "execution.output",
          timestamp: "2026-03-08T03:00:10.000Z",
          data: { text: "A".repeat(240) },
        },
      ],
    });

    const lines = renderSessionDetailView(session, "healthy", 60, 20, Date.parse("2026-03-08T03:00:20.000Z"));
    const eventLines = lines.slice(4).map((line) => stripDetailAnsi(line));
    expect(eventLines.every((line) => line.length <= 60)).toBe(true);
    expect(eventLines.join("\n")).toContain("…");
  });
});

describe("SessionDetailView", () => {
  it("auto-follows live sessions to the newest stream entries by default", () => {
    const session = makeSession({
      events: Array.from({ length: 12 }, (_, index) => ({
        type: "agent.progress",
        timestamp: new Date(Date.parse("2026-03-08T03:00:00.000Z") + index * 1000).toISOString(),
        data: { message: `step ${index}` },
      })),
    });

    const view = new SessionDetailView({ maxHeight: 12 });
    view.setSession(session, { health: "healthy" });

    const plain = stripDetailAnsi(view.render(80).join("\n"));
    expect(plain).toContain("step 11");
    expect(plain).not.toContain("step 0");
  });

  it("supports inspectability after completion by disabling auto-follow and scrolling older entries", () => {
    const session = makeSession({
      status: "ended",
      events: Array.from({ length: 12 }, (_, index) => ({
        type: index === 11 ? "session.end" : "agent.progress",
        timestamp: new Date(Date.parse("2026-03-08T03:00:00.000Z") + index * 1000).toISOString(),
        data: index === 11 ? { summary: "done" } : { message: `step ${index}` },
      })),
    });

    const view = new SessionDetailView({ maxHeight: 12 });
    view.setSession(session, { health: "degraded" as HealthStatus, alert: makeAlert({ status: "degraded", explanation: { ...makeAlert().explanation!, state: "degraded" } }) });
    view.handleInput("f");
    view.handleInput("home");

    const plain = stripDetailAnsi(view.render(80).join("\n"));
    expect(plain).toContain("step 0");
    expect(plain).not.toContain("step 11");
    expect(view.isAutoFollowEnabled()).toBe(false);
  });
});
