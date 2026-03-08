import { describe, it, expect } from "vitest";
import {
  ANSI,
  formatFreshness,
  renderAttentionBadge,
  renderFreshnessBadge,
  renderSessionRow,
  stripAnsi,
  type SessionRowData,
} from "../../../src/monitor/ui/session-row.js";
import type { SessionState, SessionMetrics } from "../../../src/monitor/types/session.js";
import type { HealthStatus } from "../../../src/monitor/health/types.js";
import type { AttentionReason } from "../../../src/monitor/types/attention.js";

function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    duration: 60_000,
    eventCount: 4,
    errorCount: 0,
    toolCalls: 2,
    tokensUsed: 200,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "active",
    metadata: {
      id: "sess-1",
      name: "Scout River",
      cwd: "/tmp/project",
      model: "claude-haiku",
      startedAt: new Date("2026-03-08T03:00:00.000Z").toISOString(),
      agent: "ScoutAgent",
      taskId: "task-42",
    },
    metrics: makeMetrics(),
    events: [
      {
        type: "session.start",
        timestamp: new Date("2026-03-08T03:00:00.000Z").toISOString(),
        data: {},
      },
      {
        type: "session.progress",
        timestamp: new Date("2026-03-08T03:01:00.000Z").toISOString(),
        data: {},
      },
    ],
    ...overrides,
  } as SessionState;
}

function makeRowData(overrides: Partial<SessionRowData> = {}): SessionRowData {
  return {
    session: makeSession(),
    health: "healthy",
    attention: null,
    now: Date.parse("2026-03-08T03:02:00.000Z"),
    lastActivityAt: Date.parse("2026-03-08T03:01:35.000Z"),
    ...overrides,
  };
}

describe("formatFreshness", () => {
  it("formats under a minute in seconds", () => {
    expect(formatFreshness(12_000)).toBe("12s ago");
  });

  it("formats minute-scale freshness", () => {
    expect(formatFreshness(125_000)).toBe("2m ago");
  });

  it("formats hour-scale freshness", () => {
    expect(formatFreshness(7_200_000)).toBe("2h ago");
  });
});

describe("renderFreshnessBadge", () => {
  it("marks fresh activity in green", () => {
    const badge = renderFreshnessBadge(10_000);
    expect(badge).toContain(ANSI.green);
    expect(stripAnsi(badge)).toContain("10s ago");
  });

  it("marks stale activity in yellow", () => {
    const badge = renderFreshnessBadge(45_000);
    expect(badge).toContain(ANSI.yellow);
    expect(stripAnsi(badge)).toContain("45s ago");
  });

  it("marks stuck activity in red", () => {
    const badge = renderFreshnessBadge(180_000);
    expect(badge).toContain(ANSI.red);
    expect(stripAnsi(badge)).toContain("3m ago");
  });
});

describe("renderAttentionBadge", () => {
  it.each([
    ["waiting_on_human", "waiting on human"],
    ["stuck", "needs attention"],
    ["failed_recoverable", "retryable"],
    ["degraded", "needs attention"],
  ] as [AttentionReason, string][]) (
    "renders actionable badge for %s",
    (reason, label) => {
      const badge = renderAttentionBadge(reason);
      expect(stripAnsi(badge)).toContain(label);
    },
  );
});

describe("renderSessionRow", () => {
  it("renders agent, task, lifecycle, freshness, and summary in row form", () => {
    const row = renderSessionRow(makeRowData());
    const plain = stripAnsi(row);

    expect(plain).toContain("ScoutAgent");
    expect(plain).toContain("task-42");
    expect(plain).toContain("Scout River");
    expect(plain).toContain("active");
    expect(plain).toContain("25s ago");
    expect(plain).toContain("4 events · 2 tools");
  });

  it("renders failed rows differently from completed rows", () => {
    const failed = renderSessionRow(
      makeRowData({
        session: makeSession({ status: "error", metrics: makeMetrics({ errorCount: 2 }) }),
        attention: "failed_recoverable",
      }),
    );
    const completed = renderSessionRow(
      makeRowData({
        session: makeSession({ status: "ended" }),
      }),
    );

    const failedPlain = stripAnsi(failed);
    const completedPlain = stripAnsi(completed);

    expect(failedPlain).toContain("error");
    expect(failedPlain).toContain("retryable");
    expect(completedPlain).toContain("ended");
    expect(completedPlain).not.toContain("retryable");
  });

  it("surfaces degraded and waiting states without opening details", () => {
    const row = renderSessionRow(
      makeRowData({
        health: "degraded",
        attention: "waiting_on_human",
        lastActivityAt: Date.parse("2026-03-08T03:01:10.000Z"),
      }),
    );

    const plain = stripAnsi(row);
    expect(plain).toContain("degraded");
    expect(plain).toContain("waiting on human");
    expect(plain).toContain("50s ago");
  });

  it("shows keyboard focus/selection state with a leading arrow", () => {
    const row = renderSessionRow(makeRowData(), { selected: true });
    expect(stripAnsi(row).startsWith("> ")).toBe(true);
  });

  it("uses an unselected prefix when not focused", () => {
    const row = renderSessionRow(makeRowData(), { selected: false });
    expect(stripAnsi(row).startsWith("  ")).toBe(true);
  });

  it("fits within the requested visible width", () => {
    const row = renderSessionRow(makeRowData(), { width: 72 });
    expect(stripAnsi(row).length).toBeLessThanOrEqual(72);
  });

  it("falls back to session id when the session name is blank", () => {
    const row = renderSessionRow(
      makeRowData({
        session: makeSession({ metadata: { ...makeSession().metadata, name: "" } }),
      }),
    );

    expect(stripAnsi(row)).toContain("sess-1");
  });

  it("omits health badge for queued sessions where health is not applicable", () => {
    const row = renderSessionRow(
      makeRowData({
        session: makeSession({ status: "paused" }),
        health: "degraded" as HealthStatus,
      }),
    );

    const plain = stripAnsi(row);
    expect(plain).toContain("paused");
    expect(plain).not.toContain("degraded");
  });

  it("shows blocked badge when attention is blocked-like", () => {
    const row = renderSessionRow(
      makeRowData({
        session: makeSession({ status: "paused" }),
        attention: "stuck",
      }),
    );

    expect(stripAnsi(row)).toContain("needs attention");
  });
});
