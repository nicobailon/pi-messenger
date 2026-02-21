import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessengerState } from "../../lib.js";
import * as store from "../../crew/store.js";
import * as taskHandler from "../../crew/handlers/task.js";
import { createMockContext } from "../helpers/mock-context.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

function createState(agentName: string = "TestAgent"): MessengerState {
  return { agentName } as MessengerState;
}

describe("crew/task.split", () => {
  let dirs: TempCrewDirs;
  let cwd: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
  });

  it("returns inspect context with spec, progress, and dependents", async () => {
    const foundation = store.createTask(cwd, "Foundation", "Foundational work");
    store.startTask(cwd, foundation.id, "WorkerA");
    store.completeTask(cwd, foundation.id, "Done");

    const parent = store.createTask(cwd, "Big task", "Large task body", [foundation.id]);
    const dependent = store.createTask(cwd, "Downstream", "Uses big task", [parent.id]);
    store.appendTaskProgress(cwd, parent.id, "WorkerA", "Partial implementation");

    const response = await taskHandler.execute(
      "split",
      { id: parent.id, count: 3 },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.mode).toBe("task.split");
    expect(response.details.phase).toBe("inspect");
    expect(response.details.suggestedCount).toBe(3);
    expect(response.details.dependents).toEqual([dependent.id]);
    expect(response.content[0].text).toContain(`Split Task ${parent.id}`);
    expect(response.content[0].text).toContain("Current Spec");
    expect(response.content[0].text).toContain("Progress");
  });

  it("executes split by creating subtasks, rewiring dependents, and converting parent to milestone", async () => {
    const dep = store.createTask(cwd, "Shared dependency", "Dependency");
    store.startTask(cwd, dep.id, "WorkerA");
    store.completeTask(cwd, dep.id, "Done");

    const parent = store.createTask(cwd, "Parent task", "Parent work", [dep.id]);
    const downstream = store.createTask(cwd, "Downstream task", "Downstream work", [parent.id]);

    const response = await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Subtask one", content: "Part 1" },
          { title: "Subtask two", content: "Part 2" },
        ],
      },
      createState("Splitter"),
      createMockContext(cwd),
    );

    expect(response.details.mode).toBe("task.split");
    expect(response.details.phase).toBe("execute");
    const subtaskIds = response.details.subtasks.map((t: { id: string }) => t.id);
    expect(subtaskIds).toHaveLength(2);

    const reloadedParent = store.getTask(cwd, parent.id);
    expect(reloadedParent?.milestone).toBe(true);
    expect(reloadedParent?.status).toBe("todo");
    expect(reloadedParent?.depends_on).toEqual(subtaskIds);

    const reloadedDownstream = store.getTask(cwd, downstream.id);
    expect(reloadedDownstream?.depends_on).not.toContain(parent.id);
    for (const subtaskId of subtaskIds) {
      expect(reloadedDownstream?.depends_on).toContain(subtaskId);
    }
  });

  it("rejects splitting a milestone task", async () => {
    const parent = store.createTask(cwd, "Parent task", "Parent work");
    await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Subtask one" },
          { title: "Subtask two" },
        ],
      },
      createState(),
      createMockContext(cwd),
    );

    const secondSplit = await taskHandler.execute(
      "split",
      { id: parent.id },
      createState(),
      createMockContext(cwd),
    );

    expect(secondSplit.details.error).toBe("already_milestone");
    expect(secondSplit.content[0].text).toContain("Cannot split milestone task");
  });

  it("rejects execute mode when a subtask title is blank", async () => {
    const parent = store.createTask(cwd, "Parent task", "Parent work");

    const response = await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Valid subtask" },
          { title: "   " },
        ],
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.error).toBe("invalid_subtask_title");
    expect(store.getTasks(cwd)).toHaveLength(1);
  });

  it("allows splitting a blocked task and removes its block context file", async () => {
    const parent = store.createTask(cwd, "Blocked parent", "Needs decomposition");
    store.startTask(cwd, parent.id, "WorkerA");
    store.blockTask(cwd, parent.id, "Need smaller slices");

    const blockFile = path.join(dirs.blocksDir, `${parent.id}.md`);
    expect(fs.existsSync(blockFile)).toBe(true);

    await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Slice one" },
          { title: "Slice two" },
        ],
      },
      createState(),
      createMockContext(cwd),
    );

    const reloadedParent = store.getTask(cwd, parent.id);
    expect(fs.existsSync(blockFile)).toBe(false);
    expect(reloadedParent?.status).toBe("todo");
    expect(reloadedParent?.blocked_reason).toBeUndefined();
    expect(reloadedParent?.milestone).toBe(true);
  });
});
