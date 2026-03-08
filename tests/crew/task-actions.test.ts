import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as store from "../../crew/store.js";
import { executeTaskAction } from "../../crew/task-actions.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function writeCrewDependenciesConfig(cwd: string, dependencies: "advisory" | "strict"): void {
  const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ dependencies }, null, 2));
}

describe("crew/task-actions", () => {
  it("starts a todo task and assigns it", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Implement auth", "Desc");

    const result = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(result.success).toBe(true);
    expect(result.task?.status).toBe("in_progress");
    expect(result.task?.assigned_to).toBe("AgentA");
  });

  it("returns success when agent is already assigned to in_progress task", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Implement auth", "Desc");
    store.startTask(cwd, task.id, "AgentA");

    const result = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(result.success).toBe(true);
    expect(result.task?.status).toBe("in_progress");
    expect(result.task?.assigned_to).toBe("AgentA");
  });

  it("rejects start when task is in_progress but assigned to different agent", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Implement auth", "Desc");
    store.startTask(cwd, task.id, "AgentA");

    const result = executeTaskAction(cwd, "start", task.id, "AgentB");

    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_status");
  });

  it("rejects starting when dependencies are not done", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    writeCrewDependenciesConfig(cwd, "strict");
    const dep = store.createTask(cwd, "Dependency", "Desc");
    const task = store.createTask(cwd, "Main", "Desc", [dep.id]);

    const result = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(result.success).toBe(false);
    expect(result.error).toBe("unmet_dependencies");
    expect(result.unmetDependencies).toEqual([dep.id]);
  });

  it("allows starting when dependencies are not done in advisory mode", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    writeCrewDependenciesConfig(cwd, "advisory");
    const dep = store.createTask(cwd, "Dependency", "Desc");
    const task = store.createTask(cwd, "Main", "Desc", [dep.id]);

    const result = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(result.success).toBe(true);
    expect(result.task?.status).toBe("in_progress");
    expect(result.error).toBeUndefined();
  });

  it("rejects starting milestones", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Milestone", "Desc");
    store.updateTask(cwd, task.id, { milestone: true });

    const result = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(result.success).toBe(false);
    expect(result.error).toBe("milestone_not_startable");
  });

  it("blocks and unblocks an in-progress task", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");
    store.startTask(cwd, task.id, "AgentA");

    const blocked = executeTaskAction(cwd, "block", task.id, "AgentA", "Waiting on API");
    expect(blocked.success).toBe(true);
    expect(store.getTask(cwd, task.id)?.status).toBe("blocked");

    const unblocked = executeTaskAction(cwd, "unblock", task.id, "AgentA");
    expect(unblocked.success).toBe(true);
    expect(store.getTask(cwd, task.id)?.status).toBe("todo");
  });

  it("prevents deleting active in-progress worker tasks", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");
    store.startTask(cwd, task.id, "AgentA");

    const result = executeTaskAction(cwd, "delete", task.id, "AgentA", undefined, {
      isWorkerActive: () => true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("active_worker");
    expect(store.getTask(cwd, task.id)).not.toBeNull();
  });

  it("deletes non-active tasks", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");

    const result = executeTaskAction(cwd, "delete", task.id, "AgentA", undefined, {
      isWorkerActive: () => false,
    });

    expect(result.success).toBe(true);
    expect(store.getTask(cwd, task.id)).toBeNull();
  });

  it("stops an in-progress task with an active worker", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");
    store.startTask(cwd, task.id, "AgentA");

    const result = executeTaskAction(cwd, "stop", task.id, "AgentA", undefined, {
      isWorkerActive: () => true,
    });

    expect(result.success).toBe(true);
    const updated = store.getTask(cwd, task.id);
    expect(updated?.status).toBe("todo");
    expect(updated?.assigned_to).toBeUndefined();
    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).toContain("Worker stopped by user");
  });

  it("reset with force zeroes attempt_count and spawn_failure_count", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");
    store.startTask(cwd, task.id, "AgentA");
    // Simulate multiple attempts and spawn failures
    store.updateTask(cwd, task.id, { attempt_count: 5, spawn_failure_count: 3, status: "blocked" as any });

    const result = executeTaskAction(cwd, "reset", task.id, "AgentA", undefined, { force: true });

    expect(result.success).toBe(true);
    const updated = store.getTask(cwd, task.id);
    expect(updated?.attempt_count).toBe(0);
    expect(updated?.spawn_failure_count).toBe(0);
    expect(updated?.status).toBe("todo");
  });

  it("reset without force preserves attempt_count and spawn_failure_count", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");
    store.startTask(cwd, task.id, "AgentA");
    store.updateTask(cwd, task.id, { attempt_count: 5, spawn_failure_count: 3, status: "blocked" as any });

    const result = executeTaskAction(cwd, "reset", task.id, "AgentA");

    expect(result.success).toBe(true);
    const updated = store.getTask(cwd, task.id);
    expect(updated?.attempt_count).toBe(5);
    expect(updated?.spawn_failure_count).toBe(3);
  });

  it("cascade-reset with force zeroes attempt_count and spawn_failure_count on all reset tasks", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const dep = store.createTask(cwd, "Dep", "Desc");
    const task = store.createTask(cwd, "Main", "Desc", [dep.id]);
    store.startTask(cwd, dep.id, "AgentA");
    store.updateTask(cwd, dep.id, { attempt_count: 3, spawn_failure_count: 2, status: "blocked" as any });
    store.startTask(cwd, task.id, "AgentB");
    store.updateTask(cwd, task.id, { attempt_count: 4, spawn_failure_count: 1, status: "in_progress" as any });

    const result = executeTaskAction(cwd, "cascade-reset", dep.id, "AgentA", undefined, { force: true });

    expect(result.success).toBe(true);
    expect(result.resetTasks!.length).toBeGreaterThanOrEqual(1);
    // Check all reset tasks have zeroed counters
    for (const rt of result.resetTasks!) {
      const updated = store.getTask(cwd, rt.id);
      expect(updated?.attempt_count).toBe(0);
      expect(updated?.spawn_failure_count).toBe(0);
    }
  });

  it("rejects stop when task is not in_progress", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");

    const result = executeTaskAction(cwd, "stop", task.id, "AgentA", undefined, {
      isWorkerActive: () => true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_status");
  });

  it("stop without active worker resets task to todo", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task", "Desc");
    store.startTask(cwd, task.id, "AgentA");

    const result = executeTaskAction(cwd, "stop", task.id, "AgentA", undefined, {
      isWorkerActive: () => false,
    });

    expect(result.success).toBe(true);
    const updated = store.getTask(cwd, task.id);
    expect(updated?.status).toBe("todo");
    expect(updated?.assigned_to).toBeUndefined();
  });
});
