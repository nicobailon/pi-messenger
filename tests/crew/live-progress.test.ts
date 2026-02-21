import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLiveWorkers,
  hasLiveWorkers,
  onLiveWorkersChanged,
  removeLiveWorker,
  updateLiveWorker,
} from "../../crew/live-progress.js";

const CWD = "/tmp/project-a";

function resetStore(): void {
  for (const key of Array.from(getLiveWorkers().keys())) {
    const [cwd, taskId] = key.split("::");
    if (cwd && taskId) removeLiveWorker(cwd, taskId);
  }
}

function makeInfo(taskId: string, agent: string) {
  return {
    taskId,
    agent,
    name: "TestWorker",
    startedAt: Date.now(),
    progress: {
      agent,
      status: "running" as const,
      currentTool: "bash",
      currentToolArgs: "npm test",
      recentTools: [],
      toolCallCount: 2,
      tokens: 1500,
      durationMs: 3000,
    },
  };
}

describe("crew/live-progress", () => {
  beforeEach(() => {
    resetStore();
  });

  it("updateLiveWorker and getLiveWorkers round-trip worker info", () => {
    updateLiveWorker(CWD, "task-1", makeInfo("task-1", "crew-worker"));

    const workers = getLiveWorkers(CWD);
    expect(workers.size).toBe(1);
    expect(workers.get("task-1")?.agent).toBe("crew-worker");
    expect(workers.get("task-1")?.progress.currentTool).toBe("bash");
  });

  it("removeLiveWorker removes worker entry", () => {
    updateLiveWorker(CWD, "task-1", makeInfo("task-1", "crew-worker"));
    removeLiveWorker(CWD, "task-1");

    expect(getLiveWorkers(CWD).has("task-1")).toBe(false);
    expect(getLiveWorkers(CWD).size).toBe(0);
  });

  it("hasLiveWorkers reflects empty/non-empty state", () => {
    expect(hasLiveWorkers(CWD)).toBe(false);
    updateLiveWorker(CWD, "task-1", makeInfo("task-1", "crew-worker"));
    expect(hasLiveWorkers(CWD)).toBe(true);
    removeLiveWorker(CWD, "task-1");
    expect(hasLiveWorkers(CWD)).toBe(false);
  });

  it("listeners fire on update and remove and can unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onLiveWorkersChanged(listener);

    updateLiveWorker(CWD, "task-1", makeInfo("task-1", "crew-worker"));
    removeLiveWorker(CWD, "task-1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    updateLiveWorker(CWD, "task-2", makeInfo("task-2", "crew-worker"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tracks multiple concurrent workers independently", () => {
    updateLiveWorker(CWD, "task-1", makeInfo("task-1", "crew-worker"));
    updateLiveWorker(CWD, "task-2", makeInfo("task-2", "crew-worker"));
    updateLiveWorker(CWD, "task-3", makeInfo("task-3", "crew-worker"));

    const workers = getLiveWorkers(CWD);
    expect(workers.size).toBe(3);
    expect(workers.get("task-1")?.taskId).toBe("task-1");
    expect(workers.get("task-2")?.taskId).toBe("task-2");
    expect(workers.get("task-3")?.taskId).toBe("task-3");
  });

  it("isolates workers by cwd even with identical task IDs", () => {
    updateLiveWorker("/tmp/project-a", "task-1", makeInfo("task-1", "crew-worker"));
    updateLiveWorker("/tmp/project-b", "task-1", makeInfo("task-1", "crew-worker"));

    const aWorkers = getLiveWorkers("/tmp/project-a");
    const bWorkers = getLiveWorkers("/tmp/project-b");

    expect(aWorkers.size).toBe(1);
    expect(bWorkers.size).toBe(1);
    expect(hasLiveWorkers("/tmp/project-a")).toBe(true);
    expect(hasLiveWorkers("/tmp/project-b")).toBe(true);
  });
});
