import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

vi.mock("../../crew/agents.js", () => ({
  resolveModel: vi.fn((taskModel?: string, paramModel?: string, configModel?: string, agentModel?: string) => (
    taskModel ?? paramModel ?? configModel ?? agentModel
  )),
  spawnAgents: vi.fn(),
}));

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a worker.
`);
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function makeResult(taskId: string) {
  return {
    agent: "crew-worker",
    exitCode: 0,
    output: "",
    truncated: false,
    progress: {
      agent: "crew-worker",
      status: "completed" as const,
      recentTools: [],
      toolCallCount: 0,
      tokens: 0,
      durationMs: 0,
    },
    taskId,
    wasGracefullyShutdown: false,
  };
}

describe("crew/work namespacing", () => {
  let workHandler: typeof import("../../crew/handlers/work.js");
  let store: typeof import("../../crew/store.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let cwd: string;
  let taskId: string;

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    writeWorkerAgent(cwd);

    store = await import("../../crew/store.js");
    store.createPlan(cwd, "docs/PRD.md");

    workHandler = await import("../../crew/handlers/work.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;
  });

  it("uses namespaced worker task IDs and maps results back to task IDs", async () => {
    taskId = store.createTask(cwd, "Task 1", "Implement task", undefined, "alpha").id;

    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      const workerTaskId = tasks[0]?.taskId ?? "";
      expect(workerTaskId).toBe(`alpha::${taskId}`);
      store.updateTask(cwd, taskId, { status: "done" });
      return [makeResult(workerTaskId)] as any;
    });

    const response = await workHandler.execute(
      { action: "work", crew: "alpha" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(response.details.succeeded).toEqual([taskId]);
  });

  it("keeps shared task IDs by default", async () => {
    taskId = store.createTask(cwd, "Task 1", "Implement task", undefined, "shared").id;

    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      const workerTaskId = tasks[0]?.taskId ?? "";
      expect(workerTaskId).toBe(taskId);
      store.updateTask(cwd, taskId, { status: "done" });
      return [makeResult(workerTaskId)] as any;
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(response.details.succeeded).toEqual([taskId]);
  });
});
