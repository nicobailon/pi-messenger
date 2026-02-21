import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../../crew/store.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

describe("crew/store", () => {
  let dirs: TempCrewDirs;
  let cwd: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
  });

  describe("plan CRUD", () => {
    it("createPlan + getPlan round-trip", () => {
      const created = store.createPlan(cwd, "docs/PRD.md");
      const loaded = store.getPlan(cwd);

      expect(loaded).toEqual(created);
      expect(loaded?.prd).toBe("docs/PRD.md");
      expect(loaded?.task_count).toBe(0);
      expect(loaded?.completed_count).toBe(0);
    });

    it("updatePlan touches updated_at", async () => {
      const created = store.createPlan(cwd, "docs/PRD.md");
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = store.updatePlan(cwd, { task_count: 3 });
      expect(updated?.task_count).toBe(3);
      expect(updated?.updated_at).not.toBe(created.updated_at);
    });

    it("deletePlan removes plan.json, plan.md, and all task files", () => {
      store.createPlan(cwd, "docs/PRD.md");
      store.setPlanSpec(cwd, "# Plan");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two");

      expect(fs.existsSync(path.join(dirs.crewDir, "plan.json"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.crewDir, "plan.md"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t1.id}.json`))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t1.id}.md`))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t2.id}.json`))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t2.id}.md`))).toBe(true);

      const deleted = store.deletePlan(cwd);
      expect(deleted).toBe(true);
      expect(fs.existsSync(path.join(dirs.crewDir, "plan.json"))).toBe(false);
      expect(fs.existsSync(path.join(dirs.crewDir, "plan.md"))).toBe(false);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t1.id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t1.id}.md`))).toBe(false);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t2.id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dirs.tasksDir, `${t2.id}.md`))).toBe(false);
    });

    it("hasPlan returns false when no plan exists", () => {
      expect(store.hasPlan(cwd)).toBe(false);
      expect(store.getPlan(cwd)).toBeNull();
    });
  });

  describe("task CRUD", () => {
    it("createTask assigns sequential IDs and creates .json/.md files", () => {
      store.createPlan(cwd, "docs/PRD.md");

      const t1 = store.createTask(cwd, "Task one", "Description one");
      const t2 = store.createTask(cwd, "Task two", "Description two");

      expect(t1.id).toBe("task-1");
      expect(t2.id).toBe("task-2");
      expect(fs.existsSync(path.join(dirs.tasksDir, "task-1.json"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, "task-1.md"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, "task-2.json"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.tasksDir, "task-2.md"))).toBe(true);
    });

    it("getTasks sorts by numeric task ID (task-10 after task-9)", () => {
      store.createPlan(cwd, "docs/PRD.md");
      for (let i = 0; i < 10; i++) {
        store.createTask(cwd, `Task ${i + 1}`, `Desc ${i + 1}`);
      }

      const ids = store.getTasks(cwd).map(t => t.id);
      expect(ids).toEqual([
        "task-1",
        "task-2",
        "task-3",
        "task-4",
        "task-5",
        "task-6",
        "task-7",
        "task-8",
        "task-9",
        "task-10",
      ]);
    });

    it("getTaskSpec / setTaskSpec round-trip", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one");

      const initialSpec = store.getTaskSpec(cwd, task.id);
      expect(initialSpec).toContain("*Spec pending*");

      store.setTaskSpec(cwd, task.id, "# Task one\n\nConcrete spec");
      const savedSpec = store.getTaskSpec(cwd, task.id);
      expect(savedSpec).toBe("# Task one\n\nConcrete spec");
    });
  });

  describe("task lifecycle", () => {
    it("startTask: todo -> in_progress, sets started/base/assigned, increments attempt_count", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");

      const started = store.startTask(cwd, task.id, "WorkerAlpha");

      expect(started).not.toBeNull();
      expect(started?.status).toBe("in_progress");
      expect(started?.assigned_to).toBe("WorkerAlpha");
      expect(started?.attempt_count).toBe(1);
      expect(started?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect("base_commit" in (started ?? {})).toBe(true);
    });

    it("startTask on non-todo task returns null", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      const first = store.startTask(cwd, task.id, "WorkerAlpha");
      expect(first?.status).toBe("in_progress");

      const second = store.startTask(cwd, task.id, "WorkerBeta");
      expect(second).toBeNull();
    });

    it("completeTask: in_progress -> done and updates plan completed_count", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      store.startTask(cwd, task.id, "WorkerAlpha");

      const completed = store.completeTask(
        cwd,
        task.id,
        "Implemented feature",
        { commits: ["abc123"], tests: ["npm test"] }
      );

      expect(completed).not.toBeNull();
      expect(completed?.status).toBe("done");
      expect(completed?.summary).toBe("Implemented feature");
      expect(completed?.evidence?.commits).toEqual(["abc123"]);
      expect(completed?.assigned_to).toBeUndefined();
      expect(completed?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const plan = store.getPlan(cwd);
      expect(plan?.completed_count).toBe(1);
    });

    it("completeTask on non-in_progress task returns null", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");

      const completed = store.completeTask(cwd, task.id, "No-op");
      expect(completed).toBeNull();
    });

    it("blockTask sets blocked state, writes block file, clears assigned_to", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      store.startTask(cwd, task.id, "WorkerAlpha");

      const blocked = store.blockTask(cwd, task.id, "Waiting on API keys");
      const blockFile = path.join(dirs.blocksDir, `${task.id}.md`);

      expect(blocked).not.toBeNull();
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.blocked_reason).toBe("Waiting on API keys");
      expect(blocked?.assigned_to).toBeUndefined();
      expect(fs.existsSync(blockFile)).toBe(true);
      expect(fs.readFileSync(blockFile, "utf-8")).toContain("Waiting on API keys");
    });

    it("unblockTask: blocked -> todo and removes block file", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      store.blockTask(cwd, task.id, "Blocked upstream");
      const blockFile = path.join(dirs.blocksDir, `${task.id}.md`);
      expect(fs.existsSync(blockFile)).toBe(true);

      const unblocked = store.unblockTask(cwd, task.id);
      expect(unblocked?.status).toBe("todo");
      expect(unblocked?.blocked_reason).toBeUndefined();
      expect(fs.existsSync(blockFile)).toBe(false);
    });

    it("unblockTask on non-blocked task returns null", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");

      const unblocked = store.unblockTask(cwd, task.id);
      expect(unblocked).toBeNull();
    });

    it("resetTask resets status and lifecycle fields back to todo", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      store.startTask(cwd, task.id, "WorkerAlpha");
      store.completeTask(cwd, task.id, "Completed", { tests: ["npm test"] });
      store.blockTask(cwd, task.id, "Manually blocked after completion");

      const reset = store.resetTask(cwd, task.id);
      const reloaded = store.getTask(cwd, task.id);

      expect(reset).toHaveLength(1);
      expect(reloaded?.status).toBe("todo");
      expect(reloaded?.started_at).toBeUndefined();
      expect(reloaded?.completed_at).toBeUndefined();
      expect(reloaded?.base_commit).toBeUndefined();
      expect(reloaded?.assigned_to).toBeUndefined();
      expect(reloaded?.summary).toBeUndefined();
      expect(reloaded?.evidence).toBeUndefined();
      expect(reloaded?.blocked_reason).toBeUndefined();
      expect(reloaded?.attempt_count).toBe(1);
    });

    it("resetTask cleans up block file when resetting a blocked task", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      store.blockTask(cwd, task.id, "Needs clarification");

      const blockFile = path.join(dirs.blocksDir, `${task.id}.md`);
      expect(fs.existsSync(blockFile)).toBe(true);

      store.resetTask(cwd, task.id);
      expect(fs.existsSync(blockFile)).toBe(false);
    });

    it("resetTask(cascade: true) resets dependents recursively and syncs completed_count", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two", [t1.id]);
      const t3 = store.createTask(cwd, "Task three", "Desc three", [t2.id]);

      store.startTask(cwd, t1.id, "WorkerA");
      store.completeTask(cwd, t1.id, "Done 1");
      store.startTask(cwd, t2.id, "WorkerB");
      store.completeTask(cwd, t2.id, "Done 2");
      store.startTask(cwd, t3.id, "WorkerC");
      store.completeTask(cwd, t3.id, "Done 3");

      expect(store.getPlan(cwd)?.completed_count).toBe(3);

      const reset = store.resetTask(cwd, t1.id, true);
      const resetIds = new Set(reset.map(t => t.id));

      expect(resetIds).toEqual(new Set([t1.id, t2.id, t3.id]));
      expect(store.getTask(cwd, t1.id)?.status).toBe("todo");
      expect(store.getTask(cwd, t2.id)?.status).toBe("todo");
      expect(store.getTask(cwd, t3.id)?.status).toBe("todo");
      expect(store.getPlan(cwd)?.completed_count).toBe(0);
    });
  });

  describe("dependency resolution (getReadyTasks)", () => {
    it("returns todo tasks with no dependencies", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");

      const ready = store.getReadyTasks(cwd).map(t => t.id);
      expect(ready).toEqual([t1.id]);
    });

    it("excludes todo tasks when one dependency is still todo", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two", [t1.id]);

      const ready = store.getReadyTasks(cwd).map(t => t.id);
      expect(ready).toEqual([t1.id]);
      expect(ready).not.toContain(t2.id);
    });

    it("includes todo task when all dependencies are done", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two", [t1.id]);

      store.startTask(cwd, t1.id, "WorkerA");
      store.completeTask(cwd, t1.id, "Done");

      const ready = store.getReadyTasks(cwd).map(t => t.id);
      expect(ready).toContain(t2.id);
    });

    it("never returns in_progress, done, or blocked tasks", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two");
      const t3 = store.createTask(cwd, "Task three", "Desc three");
      const t4 = store.createTask(cwd, "Task four", "Desc four");

      store.startTask(cwd, t1.id, "WorkerA");
      store.startTask(cwd, t2.id, "WorkerB");
      store.completeTask(cwd, t2.id, "Done");
      store.blockTask(cwd, t3.id, "Blocked");

      const ready = store.getReadyTasks(cwd).map(t => t.id);
      expect(ready).toEqual([t4.id]);
      expect(ready).not.toContain(t1.id);
      expect(ready).not.toContain(t2.id);
      expect(ready).not.toContain(t3.id);
    });

    it("returns tasks with unmet dependencies when advisory is true", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two", [t1.id]);

      const ready = store.getReadyTasks(cwd, { advisory: true }).map(t => t.id);
      expect(ready).toContain(t2.id);
    });

    it("does not return tasks with unmet dependencies when advisory is false", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two", [t1.id]);

      const ready = store.getReadyTasks(cwd, { advisory: false }).map(t => t.id);
      expect(ready).toEqual([t1.id]);
      expect(ready).not.toContain(t2.id);
    });

    it("never returns milestones regardless of advisory flag", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Milestone task", "Desc");
      store.updateTask(cwd, t1.id, { milestone: true });

      const advisoryReady = store.getReadyTasks(cwd, { advisory: true }).map(t => t.id);
      const strictReady = store.getReadyTasks(cwd, { advisory: false }).map(t => t.id);

      expect(advisoryReady).not.toContain(t1.id);
      expect(strictReady).not.toContain(t1.id);
    });

    it("returns same result for empty dependency lists in both modes", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two");

      const advisoryReady = store.getReadyTasks(cwd, { advisory: true }).map(t => t.id);
      const strictReady = store.getReadyTasks(cwd, { advisory: false }).map(t => t.id);

      expect(advisoryReady).toEqual([t1.id, t2.id]);
      expect(strictReady).toEqual([t1.id, t2.id]);
    });
  });

  describe("validatePlan", () => {
    it("detects orphan dependencies", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      store.updateTask(cwd, t1.id, { depends_on: ["task-999"] });
      store.setPlanSpec(cwd, "# Plan");
      store.setTaskSpec(cwd, t1.id, "# Task one\n\nDetailed spec");

      const validation = store.validatePlan(cwd);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(`Task ${t1.id} depends on non-existent task task-999`);
    });

    it("detects circular dependencies", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two");
      store.updateTask(cwd, t1.id, { depends_on: [t2.id] });
      store.updateTask(cwd, t2.id, { depends_on: [t1.id] });
      store.setPlanSpec(cwd, "# Plan");
      store.setTaskSpec(cwd, t1.id, "# Task one\n\nDetailed spec");
      store.setTaskSpec(cwd, t2.id, "# Task two\n\nDetailed spec");

      const validation = store.validatePlan(cwd);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes("Circular dependency detected"))).toBe(true);
    });

    it("warns on missing task and plan specs", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one");

      const validation = store.validatePlan(cwd);
      expect(validation.valid).toBe(true);
      expect(validation.warnings).toContain(`Task ${t1.id} has no detailed spec`);
      expect(validation.warnings).toContain("Plan has no detailed spec");
    });

    it("warns on task_count and completed_count mismatches", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      store.setPlanSpec(cwd, "# Plan");
      store.setTaskSpec(cwd, t1.id, "# Task one\n\nDetailed spec");

      store.updatePlan(cwd, { task_count: 99, completed_count: 88 });

      const validation = store.validatePlan(cwd);
      expect(validation.valid).toBe(true);
      expect(validation.warnings).toContain("Plan task_count (99) doesn't match actual tasks (1)");
      expect(validation.warnings).toContain("Plan completed_count (88) doesn't match actual (0)");
    });
  });

  describe("task progress", () => {
    it("appendTaskProgress creates progress file with timestamped entry", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");

      store.appendTaskProgress(cwd, task.id, "WorkerA", "Started implementing");

      const progressPath = path.join(dirs.tasksDir, `${task.id}.progress.md`);
      expect(fs.existsSync(progressPath)).toBe(true);

      const content = fs.readFileSync(progressPath, "utf-8");
      expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T.+\] \(WorkerA\) Started implementing\n$/);
    });

    it("appendTaskProgress appends multiple entries without overwriting", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");

      store.appendTaskProgress(cwd, task.id, "WorkerA", "First entry");
      store.appendTaskProgress(cwd, task.id, "WorkerA", "Second entry");
      store.appendTaskProgress(cwd, task.id, "system", "Third entry");

      const content = fs.readFileSync(
        path.join(dirs.tasksDir, `${task.id}.progress.md`),
        "utf-8"
      );
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("(WorkerA) First entry");
      expect(lines[1]).toContain("(WorkerA) Second entry");
      expect(lines[2]).toContain("(system) Third entry");
    });

    it("getTaskProgress returns null when no progress file exists", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");

      expect(store.getTaskProgress(cwd, task.id)).toBeNull();
    });

    it("getTaskProgress returns null for whitespace-only progress file", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      fs.writeFileSync(path.join(dirs.tasksDir, `${task.id}.progress.md`), "  \n\n  ");

      expect(store.getTaskProgress(cwd, task.id)).toBeNull();
    });

    it("deletePlan removes progress files with other task files", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      store.appendTaskProgress(cwd, t1.id, "WorkerA", "Some progress");

      const progressPath = path.join(dirs.tasksDir, `${t1.id}.progress.md`);
      expect(fs.existsSync(progressPath)).toBe(true);

      store.deletePlan(cwd);
      expect(fs.existsSync(progressPath)).toBe(false);
    });
  });

  describe("deleteTask", () => {
    it("removes json, md, and progress files", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const task = store.createTask(cwd, "Task one", "Desc one");
      store.appendTaskProgress(cwd, task.id, "WorkerA", "Some work");

      const jsonPath = path.join(dirs.tasksDir, `${task.id}.json`);
      const mdPath = path.join(dirs.tasksDir, `${task.id}.md`);
      const progressPath = path.join(dirs.tasksDir, `${task.id}.progress.md`);
      expect(fs.existsSync(jsonPath)).toBe(true);
      expect(fs.existsSync(mdPath)).toBe(true);
      expect(fs.existsSync(progressPath)).toBe(true);

      expect(store.deleteTask(cwd, task.id)).toBe(true);
      expect(fs.existsSync(jsonPath)).toBe(false);
      expect(fs.existsSync(mdPath)).toBe(false);
      expect(fs.existsSync(progressPath)).toBe(false);
    });

    it("cleans dependency references from other tasks", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two", [t1.id]);
      expect(store.getTask(cwd, t2.id)?.depends_on).toEqual([t1.id]);

      store.deleteTask(cwd, t1.id);
      expect(store.getTask(cwd, t2.id)?.depends_on).toEqual([]);
    });

    it("decrements plan task_count and completed_count for done tasks", () => {
      store.createPlan(cwd, "docs/PRD.md");
      const t1 = store.createTask(cwd, "Task one", "Desc one");
      const t2 = store.createTask(cwd, "Task two", "Desc two");

      store.startTask(cwd, t1.id, "WorkerA");
      store.completeTask(cwd, t1.id, "Done");
      expect(store.getPlan(cwd)?.task_count).toBe(2);
      expect(store.getPlan(cwd)?.completed_count).toBe(1);

      store.deleteTask(cwd, t1.id);
      expect(store.getPlan(cwd)?.task_count).toBe(1);
      expect(store.getPlan(cwd)?.completed_count).toBe(0);

      store.deleteTask(cwd, t2.id);
      expect(store.getPlan(cwd)?.task_count).toBe(0);
      expect(store.getPlan(cwd)?.completed_count).toBe(0);
    });

    it("returns false for non-existent task", () => {
      store.createPlan(cwd, "docs/PRD.md");
      expect(store.deleteTask(cwd, "task-999")).toBe(false);
    });
  });
});
