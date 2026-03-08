// task-11: session monitor UI render tests
import { describe, it, expect } from "vitest";
import {
  renderStatusBadge,
  renderMetricsSummary,
  renderHealthIndicator,
  renderSessionRow,
  renderGroupedSessions,
  formatDuration,
  stripAnsi,
  visibleLen,
  ANSI,
} from "../../../src/monitor/ui/render.js";
import type { SessionState, SessionMetrics } from "../../../src/monitor/types/session.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeMetrics(overrides?: Partial<SessionMetrics>): SessionMetrics {
  return {
    duration: 0,
    eventCount: 0,
    errorCount: 0,
    toolCalls: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    status: "active",
    metadata: {
      id: "sess-1",
      name: "My Session",
      cwd: "/tmp",
      model: "claude-3",
      startedAt: new Date().toISOString(),
      agent: "TestAgent",
    },
    metrics: makeMetrics(),
    events: [],
    ...overrides,
  } as SessionState;
}

// ─── renderStatusBadge ────────────────────────────────────────────────────────

describe("renderStatusBadge", () => {
  it("uses green ANSI code for active status", () => {
    const badge = renderStatusBadge("active");
    expect(badge).toContain(ANSI.green);
    expect(badge).toContain("active");
    expect(badge).toContain(ANSI.reset);
  });

  it("uses yellow ANSI code for paused status", () => {
    const badge = renderStatusBadge("paused");
    expect(badge).toContain(ANSI.yellow);
    expect(badge).toContain("paused");
    expect(badge).toContain(ANSI.reset);
  });

  it("uses red ANSI code for error status", () => {
    const badge = renderStatusBadge("error");
    expect(badge).toContain(ANSI.red);
    expect(badge).toContain("error");
    expect(badge).toContain(ANSI.reset);
  });

  it("uses gray ANSI code for ended status", () => {
    const badge = renderStatusBadge("ended");
    expect(badge).toContain(ANSI.gray);
    expect(badge).toContain("ended");
    expect(badge).toContain(ANSI.reset);
  });

  it("uses gray ANSI code for idle status", () => {
    const badge = renderStatusBadge("idle");
    expect(badge).toContain(ANSI.gray);
    expect(badge).toContain("idle");
    expect(badge).toContain(ANSI.reset);
  });
});

// ─── renderMetricsSummary ─────────────────────────────────────────────────────

describe("renderMetricsSummary", () => {
  it("formats all zero metrics correctly", () => {
    const summary = renderMetricsSummary(makeMetrics());
    expect(summary).toContain("0 events");
    expect(summary).toContain("0 errors");
    expect(summary).toContain("0 tools");
  });

  it("formats non-zero counts correctly", () => {
    const summary = renderMetricsSummary(
      makeMetrics({ eventCount: 42, errorCount: 3, toolCalls: 10 }),
    );
    expect(summary).toContain("42 events");
    expect(summary).toContain("3 errors");
    expect(summary).toContain("10 tools");
  });

  it("formats duration in seconds for short durations", () => {
    const summary = renderMetricsSummary(makeMetrics({ duration: 30_000 }));
    expect(summary).toContain("30s");
  });

  it("formats duration in minutes for longer durations", () => {
    const summary = renderMetricsSummary(makeMetrics({ duration: 90_000 }));
    expect(summary).toContain("1m 30s");
  });

  it("formats duration in hours for very long durations", () => {
    const summary = renderMetricsSummary(makeMetrics({ duration: 3_600_000 }));
    expect(summary).toContain("1h");
  });
});

// ─── renderHealthIndicator ────────────────────────────────────────────────────

describe("renderHealthIndicator", () => {
  it("uses green for healthy status", () => {
    const indicator = renderHealthIndicator("healthy");
    expect(indicator).toContain(ANSI.green);
    expect(indicator).toContain("healthy");
  });

  it("uses yellow for degraded status", () => {
    const indicator = renderHealthIndicator("degraded");
    expect(indicator).toContain(ANSI.yellow);
    expect(indicator).toContain("degraded");
  });

  it("uses red for critical status", () => {
    const indicator = renderHealthIndicator("critical");
    expect(indicator).toContain(ANSI.red);
    expect(indicator).toContain("critical");
  });
});

// ─── renderSessionRow ─────────────────────────────────────────────────────────

describe("renderSessionRow", () => {
  it("returns two lines per session", () => {
    const session = makeSession();
    const rows = renderSessionRow(session, false);
    expect(rows).toHaveLength(2);
  });

  it("shows '>' prefix for selected row", () => {
    const session = makeSession();
    const rows = renderSessionRow(session, true);
    expect(rows[0]).toContain("> ");
  });

  it("shows '  ' prefix for unselected row", () => {
    const session = makeSession();
    const rows = renderSessionRow(session, false);
    expect(rows[0]).toMatch(/^  /);
  });

  it("includes session name in first row", () => {
    const session = makeSession();
    const rows = renderSessionRow(session, false);
    expect(rows[0]).toContain("My Session");
  });

  it("includes status badge in first row", () => {
    const session = makeSession({ status: "active" });
    const rows = renderSessionRow(session, false);
    expect(rows[0]).toContain(ANSI.green);
    expect(rows[0]).toContain("active");
  });

  it("includes metrics in second row", () => {
    const session = makeSession({
      metrics: makeMetrics({ eventCount: 5 }),
    });
    const rows = renderSessionRow(session, false);
    expect(rows[1]).toContain("5 events");
  });

  it("respects width constraint — visible content fits within width", () => {
    const session = makeSession();
    const width = 40;
    const rows = renderSessionRow(session, false, width);
    for (const row of rows) {
      const visible = visibleLen(row);
      expect(visible).toBeLessThanOrEqual(width);
    }
  });

  it("falls back to session id when name is empty", () => {
    const session = makeSession();
    session.metadata.name = "";
    const rows = renderSessionRow(session, false);
    expect(rows[0]).toContain("sess-1");
  });
});

// ─── formatDuration helper ────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats 0ms as 0s", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats 5000ms as 5s", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  it("formats 65000ms as 1m 5s", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
  });

  it("formats 3600000ms as 1h 0m", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
  });
});

// ─── stripAnsi helper ─────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    expect(stripAnsi(`${ANSI.green}hello${ANSI.reset}`)).toBe("hello");
  });

  it("returns plain string unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

// ─── getEventReason (via renderGroupedSessions) ───────────────────────────────

describe("getEventReason — fallback field extraction", () => {
  function makeSessionWithEvent(
    status: "error" | "paused",
    eventType: string,
    payload: Record<string, unknown>,
  ): SessionState {
    return makeSession({
      status,
      events: [
        {
          id: "evt-1",
          type: eventType,
          timestamp: new Date().toISOString(),
          data: payload,
        } as any,
      ],
    });
  }

  it("extracts reason from data.reason (highest priority)", () => {
    const session = makeSessionWithEvent("error", "session.error", {
      reason: "explicit reason",
      message: "fallback message",
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const reasonLine = lines.find((l) => stripAnsi(l).includes("Reason:"));
    expect(reasonLine).toBeDefined();
    expect(stripAnsi(reasonLine!)).toContain("explicit reason");
  });

  it("extracts reason from data.message when reason is absent", () => {
    const session = makeSessionWithEvent("error", "session.error", {
      message: "error message text",
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const reasonLine = lines.find((l) => stripAnsi(l).includes("Reason:"));
    expect(reasonLine).toBeDefined();
    expect(stripAnsi(reasonLine!)).toContain("error message text");
  });

  it("extracts reason from data.error when reason and message are absent", () => {
    const session = makeSessionWithEvent("error", "session.error", {
      error: "something crashed",
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const reasonLine = lines.find((l) => stripAnsi(l).includes("Reason:"));
    expect(reasonLine).toBeDefined();
    expect(stripAnsi(reasonLine!)).toContain("something crashed");
  });

  it("extracts reason from data.summary when higher-priority fields are absent", () => {
    const session = makeSessionWithEvent("paused", "session.paused", {
      summary: "waiting for user input",
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const reasonLine = lines.find((l) => stripAnsi(l).includes("Reason:"));
    expect(reasonLine).toBeDefined();
    expect(stripAnsi(reasonLine!)).toContain("waiting for user input");
  });

  it("returns no reason line when payload has none of the expected fields", () => {
    const session = makeSessionWithEvent("error", "session.error", {
      code: 500,
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const reasonLine = lines.find((l) => stripAnsi(l).includes("Reason:"));
    expect(reasonLine).toBeUndefined();
  });

  it("supports payload shape (event.payload instead of event.data)", () => {
    const session = makeSession({
      status: "error",
      events: [
        {
          id: "evt-2",
          type: "session.error",
          timestamp: new Date().toISOString(),
          payload: { message: "payload shape message" },
        } as any,
      ],
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const reasonLine = lines.find((l) => stripAnsi(l).includes("Reason:"));
    expect(reasonLine).toBeDefined();
    expect(stripAnsi(reasonLine!)).toContain("payload shape message");
  });
});
