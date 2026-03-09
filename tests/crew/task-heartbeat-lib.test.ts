/**
 * task-13: lib.ts heartbeat timer tests (startHeartbeat + checkStaleHeartbeats)
 *
 * Uses vitest fake timers to avoid real I/O waits.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  startHeartbeat,
  stopHeartbeat,
  checkStaleHeartbeats,
  heartbeatTimestamps,
} from "../../lib.js";
import { readFeedEvents } from "../../feed.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

describe("lib.ts heartbeat infrastructure", () => {
  let cwd: string;

  beforeEach(() => {
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    // Clear any residual timestamps from other tests
    heartbeatTimestamps.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    heartbeatTimestamps.clear();
    vi.useRealTimers();
  });

  // ── startHeartbeat ──────────────────────────────────────────────────────

  describe("startHeartbeat", () => {
    it("emits an immediate task.heartbeat feed event on start", () => {
      startHeartbeat(cwd, "TestAgent", "task-1", 60_000);

      const events = readFeedEvents(cwd, 10);
      const hbEvents = events.filter(e => e.type === "task.heartbeat");
      expect(hbEvents).toHaveLength(1);
      expect(hbEvents[0].target).toBe("task-1");
      expect(hbEvents[0].agent).toBe("TestAgent");
      expect(hbEvents[0].heartbeat?.taskId).toBe("task-1");
      expect(hbEvents[0].heartbeat?.status).toBe("active");
    });

    it("emits subsequent task.heartbeat events on interval", () => {
      startHeartbeat(cwd, "TestAgent", "task-1", 30_000);

      // After one interval
      vi.advanceTimersByTime(30_000);
      let events = readFeedEvents(cwd, 20);
      let hbEvents = events.filter(e => e.type === "task.heartbeat");
      expect(hbEvents.length).toBeGreaterThanOrEqual(2); // initial + 1 interval

      // After two more intervals
      vi.advanceTimersByTime(60_000);
      events = readFeedEvents(cwd, 20);
      hbEvents = events.filter(e => e.type === "task.heartbeat");
      expect(hbEvents.length).toBeGreaterThanOrEqual(4); // initial + 3 intervals
    });

    it("records heartbeat timestamp in heartbeatTimestamps map", () => {
      startHeartbeat(cwd, "TestAgent", "task-1", 60_000);
      expect(heartbeatTimestamps.has("task-1")).toBe(true);
    });

    it("cleanup function stops further heartbeats", () => {
      const cleanup = startHeartbeat(cwd, "TestAgent", "task-2", 30_000);
      const countBefore = readFeedEvents(cwd, 20).filter(e => e.type === "task.heartbeat").length;

      cleanup();
      vi.advanceTimersByTime(90_000);

      const countAfter = readFeedEvents(cwd, 20).filter(e => e.type === "task.heartbeat").length;
      expect(countAfter).toBe(countBefore); // no new events after cleanup
    });

    it("stopHeartbeat removes timestamp from map", () => {
      startHeartbeat(cwd, "TestAgent", "task-3", 60_000);
      expect(heartbeatTimestamps.has("task-3")).toBe(true);

      stopHeartbeat("task-3");
      expect(heartbeatTimestamps.has("task-3")).toBe(false);
    });

    it("replacing a heartbeat (same taskId) cancels the old interval", () => {
      startHeartbeat(cwd, "AgentA", "task-dup", 30_000);
      startHeartbeat(cwd, "AgentB", "task-dup", 30_000); // replaces

      // Clear feed to count only new events
      const countNow = readFeedEvents(cwd, 50).filter(e => e.type === "task.heartbeat").length;

      vi.advanceTimersByTime(30_000);
      const countAfter = readFeedEvents(cwd, 50).filter(e => e.type === "task.heartbeat").length;

      // Only 1 new interval event (not 2) because old timer was stopped
      expect(countAfter - countNow).toBe(1);
    });
  });

  // ── checkStaleHeartbeats ────────────────────────────────────────────────

  describe("checkStaleHeartbeats", () => {
    it("returns empty array when no heartbeats registered", () => {
      const stale = checkStaleHeartbeats(cwd, "HealthAgent");
      expect(stale).toEqual([]);
    });

    it("returns empty array when all heartbeats are fresh", () => {
      heartbeatTimestamps.set("task-fresh", new Date().toISOString());
      const stale = checkStaleHeartbeats(cwd, "HealthAgent", 120_000);
      expect(stale).toEqual([]);
    });

    it("returns stale taskIds when heartbeat exceeds threshold", () => {
      // Set an old timestamp (older than threshold)
      const oldTs = new Date(Date.now() - 200_000).toISOString();
      heartbeatTimestamps.set("task-stale", oldTs);

      const stale = checkStaleHeartbeats(cwd, "HealthAgent", 120_000);
      expect(stale).toContain("task-stale");
    });

    it("emits heartbeat.stale feed event for each stale task", () => {
      const oldTs = new Date(Date.now() - 200_000).toISOString();
      heartbeatTimestamps.set("task-stale-feed", oldTs);

      checkStaleHeartbeats(cwd, "HealthAgent", 120_000);

      const events = readFeedEvents(cwd, 10);
      const staleEvents = events.filter(e => e.type === "heartbeat.stale");
      expect(staleEvents).toHaveLength(1);
      expect(staleEvents[0].target).toBe("task-stale-feed");
      expect(staleEvents[0].agent).toBe("HealthAgent");
    });

    it("includes elapsed time in heartbeat.stale event preview", () => {
      const oldTs = new Date(Date.now() - 150_000).toISOString();
      heartbeatTimestamps.set("task-stale-prev", oldTs);

      checkStaleHeartbeats(cwd, "HealthAgent", 120_000);

      const events = readFeedEvents(cwd, 10);
      const staleEvent = events.find(e => e.type === "heartbeat.stale" && e.target === "task-stale-prev");
      expect(staleEvent).toBeDefined();
      expect(staleEvent?.preview).toContain("heartbeat");
    });

    it("respects custom threshold", () => {
      const slightlyOld = new Date(Date.now() - 60_000).toISOString();
      heartbeatTimestamps.set("task-60s", slightlyOld);

      // With 30s threshold → stale
      expect(checkStaleHeartbeats(cwd, "HealthAgent", 30_000)).toContain("task-60s");

      // Re-add with fresh timestamp to test not stale with 90s threshold
      heartbeatTimestamps.set("task-60s", slightlyOld);
      expect(checkStaleHeartbeats(cwd, "HealthAgent", 90_000)).not.toContain("task-60s");
    });

    it("handles multiple tasks, both stale and fresh", () => {
      const oldTs = new Date(Date.now() - 200_000).toISOString();
      const freshTs = new Date().toISOString();
      heartbeatTimestamps.set("task-stale-a", oldTs);
      heartbeatTimestamps.set("task-fresh-b", freshTs);

      const stale = checkStaleHeartbeats(cwd, "HealthAgent", 120_000);
      expect(stale).toContain("task-stale-a");
      expect(stale).not.toContain("task-fresh-b");
    });
  });
});

// ── FIX 3: API heartbeat detected by BOTH mechanisms ───────────────────────

describe("FIX 3: task.heartbeat API bridges in-memory + file-based mechanisms", () => {
  let storeMod: typeof import("../../crew/store.js");

  beforeEach(async () => {
    storeMod = await import("../../crew/store.js");
  });

  it("task.heartbeat API updates heartbeatTimestamps AND writes a heartbeat file", async () => {
    const { cwd } = createTempCrewDirs();
    heartbeatTimestamps.clear();

    const { execute } = await import("../../crew/handlers/task.js");
    const { getHeartbeats } = await import("../../crew/heartbeat.js");

    const state = { agentName: "worker-1" } as any;
    const ctx = { cwd, ui: { notify: () => {} } } as any;

    storeMod.createPlan(cwd, "docs/PRD.md");
    const task = storeMod.createTask(cwd, "Heartbeat Task");

    await execute("heartbeat", { id: task.id }, state, ctx);

    // Check in-memory Map
    expect(heartbeatTimestamps.has(task.id)).toBe(true);

    // Check file-based mechanism
    const fileHeartbeats = getHeartbeats(cwd);
    const found = fileHeartbeats.find(h => h.taskId === task.id);
    expect(found).toBeDefined();
    expect(found?.agentName).toBe("worker-1");
  });

  it("getStaleAgents does NOT flag task after API heartbeat (file written)", async () => {
    const { cwd } = createTempCrewDirs();
    heartbeatTimestamps.clear();

    const { execute } = await import("../../crew/handlers/task.js");
    const { getStaleAgents } = await import("../../crew/heartbeat.js");

    const state = { agentName: "worker-2" } as any;
    const ctx = { cwd, ui: { notify: () => {} } } as any;

    storeMod.createPlan(cwd, "docs/PRD.md");
    const task = storeMod.createTask(cwd, "Fresh Task");

    // Emit a heartbeat via API
    await execute("heartbeat", { id: task.id }, state, ctx);

    // Should NOT be stale immediately after heartbeat
    const stale = getStaleAgents(cwd, 120_000);
    const staleTask = stale.find(h => h.taskId === task.id);
    expect(staleTask).toBeUndefined();
  });
});
