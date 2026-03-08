import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  emitHeartbeat,
  getHeartbeats,
  getStaleAgents,
  clearHeartbeat,
  type Heartbeat,
} from "../../crew/heartbeat.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

describe("heartbeat", () => {
  let cwd: string;
  let crewDir: string;

  beforeEach(() => {
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    crewDir = dirs.crewDir;
  });

  describe("emitHeartbeat", () => {
    it("creates a heartbeat JSON file in the heartbeats directory", () => {
      const hb: Heartbeat = {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
        progress: 50,
      };
      emitHeartbeat(cwd, hb);

      const hbDir = path.join(crewDir, "heartbeats");
      expect(fs.existsSync(hbDir)).toBe(true);

      const files = fs.readdirSync(hbDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe("worker-alpha-task-1.json");

      const content = JSON.parse(fs.readFileSync(path.join(hbDir, files[0]), "utf-8"));
      expect(content.agentName).toBe("worker-alpha");
      expect(content.taskId).toBe("task-1");
      expect(content.progress).toBe(50);
    });

    it("overwrites previous heartbeat for same agent+task", () => {
      emitHeartbeat(cwd, {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        progress: 20,
      });
      emitHeartbeat(cwd, {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: "2026-01-01T00:01:00.000Z",
        progress: 80,
      });

      const hbDir = path.join(crewDir, "heartbeats");
      const files = fs.readdirSync(hbDir);
      expect(files).toHaveLength(1);

      const content = JSON.parse(fs.readFileSync(path.join(hbDir, files[0]), "utf-8"));
      expect(content.progress).toBe(80);
    });
  });

  describe("getHeartbeats", () => {
    it("returns empty array when no heartbeats exist", () => {
      expect(getHeartbeats(cwd)).toEqual([]);
    });

    it("returns all heartbeat files", () => {
      emitHeartbeat(cwd, {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
      });
      emitHeartbeat(cwd, {
        agentName: "worker-beta",
        taskId: "task-2",
        timestamp: new Date().toISOString(),
      });

      const hbs = getHeartbeats(cwd);
      expect(hbs).toHaveLength(2);
      const names = hbs.map(h => h.agentName).sort();
      expect(names).toEqual(["worker-alpha", "worker-beta"]);
    });
  });

  describe("getStaleAgents", () => {
    it("returns empty array when all heartbeats are fresh", () => {
      emitHeartbeat(cwd, {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
        progress: 50,
      });

      expect(getStaleAgents(cwd)).toEqual([]);
    });

    it("returns heartbeats older than threshold", () => {
      const oldTime = new Date(Date.now() - 300_000).toISOString();
      emitHeartbeat(cwd, {
        agentName: "worker-stale",
        taskId: "task-1",
        timestamp: oldTime,
        progress: 10,
      });
      emitHeartbeat(cwd, {
        agentName: "worker-fresh",
        taskId: "task-2",
        timestamp: new Date().toISOString(),
        progress: 90,
      });

      const stale = getStaleAgents(cwd);
      expect(stale).toHaveLength(1);
      expect(stale[0].agentName).toBe("worker-stale");
    });

    it("uses default threshold of 120000ms (2 minutes)", () => {
      const justOver2Min = new Date(Date.now() - 121_000).toISOString();
      emitHeartbeat(cwd, {
        agentName: "worker-slow",
        taskId: "task-1",
        timestamp: justOver2Min,
      });

      expect(getStaleAgents(cwd)).toHaveLength(1);
    });

    it("respects custom threshold", () => {
      const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
      emitHeartbeat(cwd, {
        agentName: "worker-med",
        taskId: "task-1",
        timestamp: oneMinAgo,
      });

      expect(getStaleAgents(cwd, 30_000)).toHaveLength(1);
      expect(getStaleAgents(cwd, 90_000)).toHaveLength(0);
    });
  });

  describe("clearHeartbeat", () => {
    it("removes the heartbeat file for a given agent+task", () => {
      emitHeartbeat(cwd, {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
      });

      expect(getHeartbeats(cwd)).toHaveLength(1);
      clearHeartbeat(cwd, "worker-alpha", "task-1");
      expect(getHeartbeats(cwd)).toHaveLength(0);
    });

    it("does not throw when heartbeat file does not exist", () => {
      expect(() => clearHeartbeat(cwd, "nonexistent", "task-99")).not.toThrow();
    });

    it("only clears the specified agent+task heartbeat", () => {
      emitHeartbeat(cwd, {
        agentName: "worker-alpha",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
      });
      emitHeartbeat(cwd, {
        agentName: "worker-beta",
        taskId: "task-2",
        timestamp: new Date().toISOString(),
      });

      clearHeartbeat(cwd, "worker-alpha", "task-1");
      const remaining = getHeartbeats(cwd);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].agentName).toBe("worker-beta");
    });
  });
});
