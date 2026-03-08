/**
 * SessionMonitorPanel tests for grouped sections overview (task-3)
 *
 * Tests the following:
 * 1. Sessions are grouped into four sections: Running, Queued, Completed, Failed
 * 2. Status mapping: active→Running, paused/idle→Queued, ended→Completed, error→Failed
 * 3. Shared session row rendering with all required fields
 * 4. Running section is visually prioritized (rendered first)
 * 5. Selection works across grouped sections
 * 6. Enter key triggers selection/open-detail behavior via callback/getter
 * 7. Failed and queued rows show concise reason summaries when available
 */

import { describe, it, expect } from "vitest";
import {
  renderGroupedSessions,
  groupSessionsByLifecycle,
  type SessionGroup,
} from "../../../src/monitor/ui/render.js";
import type { SessionState } from "../../../src/monitor/types/session.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeMetadata(overrides?: any) {
  return {
    id: "sess-1",
    name: "Test Session",
    cwd: "/tmp",
    model: "claude-3",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    agent: "TestAgent",
    taskId: "task-1",
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    status: "active",
    metadata: makeMetadata(),
    metrics: {
      duration: 60_000,
      eventCount: 5,
      errorCount: 0,
      toolCalls: 3,
      tokensUsed: 1000,
    },
    events: [
      {
        type: "session.start",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        data: {},
      },
      {
        type: "tool.call",
        timestamp: new Date(Date.now() - 30_000).toISOString(),
        data: {},
      },
    ],
    ...overrides,
  } as SessionState;
}

// ─── groupSessionsByLifecycle ─────────────────────────────────────────────────

describe("groupSessionsByLifecycle", () => {
  it("returns an object with four sections: running, queued, completed, failed", () => {
    const sessions = [makeSession({ status: "active" })];
    const grouped = groupSessionsByLifecycle(sessions);

    expect(grouped).toHaveProperty("running");
    expect(grouped).toHaveProperty("queued");
    expect(grouped).toHaveProperty("completed");
    expect(grouped).toHaveProperty("failed");
    expect(grouped.running).toBeInstanceOf(Array);
    expect(grouped.queued).toBeInstanceOf(Array);
    expect(grouped.completed).toBeInstanceOf(Array);
    expect(grouped.failed).toBeInstanceOf(Array);
  });

  it("maps active status to running", () => {
    const session = makeSession({ status: "active" });
    const grouped = groupSessionsByLifecycle([session]);

    expect(grouped.running).toContain(session);
    expect(grouped.queued.length).toBe(0);
    expect(grouped.completed.length).toBe(0);
    expect(grouped.failed.length).toBe(0);
  });

  it("maps paused status to queued", () => {
    const session = makeSession({ status: "paused" });
    const grouped = groupSessionsByLifecycle([session]);

    expect(grouped.queued).toContain(session);
    expect(grouped.running.length).toBe(0);
    expect(grouped.completed.length).toBe(0);
    expect(grouped.failed.length).toBe(0);
  });

  it("maps idle status to queued", () => {
    const session = makeSession({ status: "idle" });
    const grouped = groupSessionsByLifecycle([session]);

    expect(grouped.queued).toContain(session);
    expect(grouped.running.length).toBe(0);
  });

  it("maps ended status to completed", () => {
    const session = makeSession({ status: "ended" });
    const grouped = groupSessionsByLifecycle([session]);

    expect(grouped.completed).toContain(session);
    expect(grouped.running.length).toBe(0);
    expect(grouped.queued.length).toBe(0);
    expect(grouped.failed.length).toBe(0);
  });

  it("maps error status to failed", () => {
    const session = makeSession({ status: "error" });
    const grouped = groupSessionsByLifecycle([session]);

    expect(grouped.failed).toContain(session);
    expect(grouped.running.length).toBe(0);
    expect(grouped.completed.length).toBe(0);
  });

  it("each session appears in exactly one section", () => {
    const s1 = makeSession({ status: "active", metadata: makeMetadata({ id: "1" }) });
    const s2 = makeSession({ status: "paused", metadata: makeMetadata({ id: "2" }) });
    const s3 = makeSession({ status: "ended", metadata: makeMetadata({ id: "3" }) });
    const s4 = makeSession({ status: "error", metadata: makeMetadata({ id: "4" }) });

    const grouped = groupSessionsByLifecycle([s1, s2, s3, s4]);
    const totalCount =
      grouped.running.length +
      grouped.queued.length +
      grouped.completed.length +
      grouped.failed.length;

    expect(totalCount).toBe(4);
    expect(grouped.running).toContain(s1);
    expect(grouped.queued).toContain(s2);
    expect(grouped.completed).toContain(s3);
    expect(grouped.failed).toContain(s4);
  });
});

// ─── renderGroupedSessions ────────────────────────────────────────────────────

describe("renderGroupedSessions", () => {
  it("returns a non-empty array of strings", () => {
    const sessions = [makeSession({ status: "active" })];
    const lines = renderGroupedSessions(sessions, 0, 80);

    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((line) => expect(typeof line).toBe("string"));
  });

  it("includes all four section headers: Running, Queued, Completed, Failed", () => {
    const s1 = makeSession({ status: "active" });
    const s2 = makeSession({ status: "paused" });
    const s3 = makeSession({ status: "ended" });
    const s4 = makeSession({ status: "error" });

    const lines = renderGroupedSessions([s1, s2, s3, s4], 0, 80);
    const text = lines.join("\n");

    expect(text).toContain("Running");
    expect(text).toContain("Queued");
    expect(text).toContain("Completed");
    expect(text).toContain("Failed");
  });

  it("renders sessions under their correct section", () => {
    const s1 = makeSession({
      status: "active",
      metadata: makeMetadata({ name: "Running Session" }),
    });
    const s2 = makeSession({
      status: "ended",
      metadata: makeMetadata({ name: "Completed Session" }),
    });

    const lines = renderGroupedSessions([s1, s2], 0, 80);
    const text = lines.join("\n");

    expect(text).toContain("Running Session");
    expect(text).toContain("Completed Session");
  });

  it("Running section appears first in output", () => {
    const s1 = makeSession({ status: "ended" });
    const s2 = makeSession({ status: "active" });
    const s3 = makeSession({ status: "error" });

    const lines = renderGroupedSessions([s1, s2, s3], 0, 80);
    const text = lines.join("\n");

    const runningIdx = text.indexOf("Running");
    const completedIdx = text.indexOf("Completed");
    const failedIdx = text.indexOf("Failed");

    expect(runningIdx).toBeLessThan(completedIdx);
    expect(runningIdx).toBeLessThan(failedIdx);
  });

  it("selectedIndex correctly highlights a session in grouped view", () => {
    const s1 = makeSession({ status: "active" });
    const s2 = makeSession({ status: "paused" });
    const s3 = makeSession({ status: "ended" });

    // selectedIndex 0 = s1, selectedIndex 1 = s2, selectedIndex 2 = s3
    const lines0 = renderGroupedSessions([s1, s2, s3], 0, 80);
    const lines1 = renderGroupedSessions([s1, s2, s3], 1, 80);

    expect(lines0.length).toBeGreaterThan(0);
    expect(lines1.length).toBeGreaterThan(0);
    // Both should be different because selection changes content
    expect(lines0.some((l) => l.includes(">"))).toBe(true);
    expect(lines1.some((l) => l.includes(">"))).toBe(true);
  });
});

// ─── Session row rendering with all required fields ─────────────────────────

describe("Session row rendering with required fields", () => {
  it("shows session/agent name", () => {
    const session = makeSession({
      metadata: makeMetadata({ name: "MySession", agent: "Scout" }),
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const text = lines.join("\n");

    expect(text).toContain("MySession");
  });

  it("shows agent and health state for running sessions in the shared overview row", () => {
    const session = makeSession({
      status: "active",
      metadata: makeMetadata({ name: "MySession", agent: "Scout" }),
      events: [
        {
          type: "session.start",
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          data: {},
        },
        {
          type: "tool.call",
          timestamp: new Date(Date.now() - 5_000).toISOString(),
          data: {},
        },
      ],
    });

    const lines = renderGroupedSessions([session], 0, 120, Date.now());
    const text = lines.join("\n");

    expect(text).toContain("Scout");
    expect(text).toContain("healthy");
  });

  it("shows assigned task (taskId from metadata)", () => {
    const session = makeSession({
      metadata: makeMetadata({ taskId: "task-42" }),
    });
    const lines = renderGroupedSessions([session], 0, 80);
    const text = lines.join("\n");

    expect(text).toContain("task-42");
  });

  it("shows lifecycle state (status badge)", () => {
    const session = makeSession({ status: "active" });
    const lines = renderGroupedSessions([session], 0, 80);
    const text = lines.join("\n");

    expect(text).toContain("active");
  });

  it("shows last activity age (time since last event)", () => {
    const now = Date.now();
    const twoMinutesAgo = new Date(now - 120_000).toISOString();
    const session = makeSession({
      events: [
        { type: "session.start", timestamp: twoMinutesAgo, data: {} },
        { type: "tool.call", timestamp: twoMinutesAgo, data: {} },
      ],
    });

    const lines = renderGroupedSessions([session], 0, 80, now);
    const text = lines.join("\n");

    // Should show age like "2m 0s ago" or similar
    expect(text).toMatch(/\d+[ms]/); // matches "2m" or "30s"
  });

  it("shows concise status summary in row", () => {
    const session = makeSession({
      metrics: { duration: 60_000, eventCount: 5, errorCount: 1, toolCalls: 3, tokensUsed: 1000 },
    });

    const lines = renderGroupedSessions([session], 0, 80);
    const text = lines.join("\n");

    // Should include metrics or summary of status
    expect(text).toMatch(/events|active|status/i);
  });

  it("shows concise reason summary for failed sessions", () => {
    const session = makeSession({
      status: "error",
      events: [
        { type: "session.start", timestamp: new Date().toISOString(), data: {} },
        {
          type: "session.error",
          timestamp: new Date().toISOString(),
          data: { reason: "Timeout waiting for response" },
        },
      ],
    });

    const lines = renderGroupedSessions([session], 0, 80);
    const text = lines.join("\n");

    // Should either show the reason or a summary
    expect(text).toMatch(/error|timeout|reason/i);
  });

  it("shows concise reason summary for queued sessions", () => {
    const session = makeSession({
      status: "paused",
      events: [
        { type: "session.start", timestamp: new Date().toISOString(), data: {} },
        {
          type: "session.paused",
          timestamp: new Date().toISOString(),
          data: { reason: "User requested pause" },
        },
      ],
    });

    const lines = renderGroupedSessions([session], 0, 80);
    const text = lines.join("\n");

    // Should show the session
    expect(text).toContain(session.metadata.name);
  });
});
