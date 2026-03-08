/**
 * Tests for crew/reconcile.ts - Startup Heartbeat Enforcement
 *
 * Tests: stale assigned → todo, stale over maxRetries → blocked,
 *        fresh in_progress → skipped, todo/done/blocked → ignored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { reconcileOrphans } from "../../crew/reconcile.js";
import type { Task } from "../../crew/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeTask(tasksDir: string, task: Partial<Task> & { id: string }): void {
  const full: Task = {
    title: task.title ?? task.id,
    status: task.status ?? "todo",
    depends_on: task.depends_on ?? [],
    created_at: new Date().toISOString(),
    updated_at: task.updated_at ?? new Date().toISOString(),
    attempt_count: task.attempt_count ?? 0,
    ...task,
  };
  writeJson(path.join(tasksDir, `${task.id}.json`), full);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcileOrphans", () => {
  it("resets a stale assigned task to todo", () => {
    const { cwd, tasksDir } = createTempCrewDirs();

    // Task was assigned 60 seconds ago — well past the 30s timeout
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeTask(tasksDir, {
      id: "task-1",
      status: "assigned",
      updated_at: staleAt,
      attempt_count: 0,
    });

    const result = reconcileOrphans(cwd, { heartbeatTimeoutMs: 30_000, maxRetries: 3 });

    expect(result.reset).toContain("task-1");
    expect(result.skipped).not.toContain("task-1");

    // Verify actual file was updated
    const raw = JSON.parse(
      fs.readFileSync(path.join(tasksDir, "task-1.json"), "utf-8")
    );
    expect(raw.status).toBe("todo");
    expect(raw.assigned_to).toBeUndefined();
    expect(raw.attempt_count).toBe(1);
  });

  it("resets a stale in_progress task to todo and increments attempt_count", () => {
    const { cwd, tasksDir } = createTempCrewDirs();

    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeTask(tasksDir, {
      id: "task-2",
      status: "in_progress",
      updated_at: staleAt,
      attempt_count: 1,
      assigned_to: "some-worker",
    });

    const result = reconcileOrphans(cwd, { heartbeatTimeoutMs: 30_000, maxRetries: 3 });

    expect(result.reset).toContain("task-2");

    const raw = JSON.parse(
      fs.readFileSync(path.join(tasksDir, "task-2.json"), "utf-8")
    );
    expect(raw.status).toBe("todo");
    expect(raw.attempt_count).toBe(2);
  });

  it("marks a stale task as blocked when attempt_count >= maxRetries", () => {
    const { cwd, tasksDir } = createTempCrewDirs();

    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeTask(tasksDir, {
      id: "task-3",
      status: "in_progress",
      updated_at: staleAt,
      attempt_count: 3, // already at maxRetries — next attempt (4) would exceed
    });

    const result = reconcileOrphans(cwd, { heartbeatTimeoutMs: 30_000, maxRetries: 3 });

    expect(result.skipped).toContain("task-3");
    expect(result.reset).not.toContain("task-3");

    const raw = JSON.parse(
      fs.readFileSync(path.join(tasksDir, "task-3.json"), "utf-8")
    );
    expect(raw.status).toBe("blocked");
  });

  it("skips a fresh in_progress task (not yet timed out)", () => {
    const { cwd, tasksDir } = createTempCrewDirs();

    // Only 5 seconds old — well within the 30s timeout
    const freshAt = new Date(Date.now() - 5_000).toISOString();
    writeTask(tasksDir, {
      id: "task-4",
      status: "in_progress",
      updated_at: freshAt,
      attempt_count: 0,
    });

    const result = reconcileOrphans(cwd, { heartbeatTimeoutMs: 30_000, maxRetries: 3 });

    expect(result.skipped).toContain("task-4");
    expect(result.reset).not.toContain("task-4");

    const raw = JSON.parse(
      fs.readFileSync(path.join(tasksDir, "task-4.json"), "utf-8")
    );
    expect(raw.status).toBe("in_progress");
  });

  it("ignores tasks in todo, done, and blocked states", () => {
    const { cwd, tasksDir } = createTempCrewDirs();

    const staleAt = new Date(Date.now() - 60_000).toISOString();
    writeTask(tasksDir, { id: "task-5", status: "todo", updated_at: staleAt });
    writeTask(tasksDir, { id: "task-6", status: "done", updated_at: staleAt });
    writeTask(tasksDir, { id: "task-7", status: "blocked", updated_at: staleAt });

    const result = reconcileOrphans(cwd, { heartbeatTimeoutMs: 30_000, maxRetries: 3 });

    expect(result.reset).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);

    // Statuses unchanged
    for (const id of ["task-5", "task-6", "task-7"]) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(tasksDir, `${id}.json`), "utf-8")
      );
      expect(["todo", "done", "blocked"]).toContain(raw.status);
    }
  });

  it("uses defaults when options are omitted", () => {
    const { cwd, tasksDir } = createTempCrewDirs();

    // 35 seconds old — beyond the default 30s timeout
    const staleAt = new Date(Date.now() - 35_000).toISOString();
    writeTask(tasksDir, {
      id: "task-8",
      status: "starting",
      updated_at: staleAt,
      attempt_count: 0,
    });

    // Call with no options — should use defaults (30s, 3 retries)
    const result = reconcileOrphans(cwd);

    expect(result.reset).toContain("task-8");
  });

  it("handles an empty task directory gracefully", () => {
    const { cwd } = createTempCrewDirs();

    const result = reconcileOrphans(cwd, { heartbeatTimeoutMs: 30_000, maxRetries: 3 });

    expect(result.reset).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
