/**
 * namespace-bleed.test.ts
 *
 * Proves that namespace isolation is enforced across the crew pipeline:
 *   1. plan in `alpha` namespace creates alpha-owned tasks
 *   2. task.list for `beta` namespace does not include `alpha` tasks
 *   3. work only pulls ready tasks for the requested namespace
 *   4. shared (default) namespace still works
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";
import type { MessengerState } from "../../lib.js";
import * as store from "../../crew/store.js";

vi.mock("../../crew/agents.js", () => ({
  resolveModel: vi.fn(
    (
      taskModel?: string,
      paramModel?: string,
      configModel?: string,
      agentModel?: string,
    ) => taskModel ?? paramModel ?? configModel ?? agentModel,
  ),
  resolveModelForTaskRole: vi.fn(
    (
      _role: string,
      taskModel?: string,
      paramModel?: string,
      _models?: unknown,
      agentModel?: string,
    ) => taskModel ?? paramModel ?? agentModel,
  ),
  selectCrewAgentForRole: vi.fn(() => undefined),
  spawnAgents: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createState(agentName = "TestAgent"): MessengerState {
  return { agentName } as MessengerState;
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function writePlannerAgent(cwd: string): void {
  const filePath = path.join(
    cwd,
    ".pi",
    "messenger",
    "crew",
    "agents",
    "crew-planner.md",
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---
name: crew-planner
description: Test planner
crewRole: planner
---
You are a planner.
`,
  );
}

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(
    cwd,
    ".pi",
    "messenger",
    "crew",
    "agents",
    "crew-worker.md",
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a worker.
`,
  );
}

/** Returns a minimal planner output containing a tasks-json block. */
function makePlannerOutput(tasks: Array<{ title: string; description: string }>) {
  const json = JSON.stringify(
    tasks.map((t) => ({ ...t, dependsOn: [] })),
    null,
    2,
  );
  return `## 1. PRD Understanding Summary
Summary here.

## 2. Relevant Code/Docs/Resources Reviewed
Nothing special.

## 3. Sequential Implementation Steps
1. Do the thing.

## 4. Parallelized Task Graph
All tasks.

\`\`\`tasks-json
${json}
\`\`\`
`;
}

function makeSpawnResult(output: string) {
  return [
    {
      agent: "crew-planner",
      exitCode: 0,
      output,
      truncated: false,
      progress: {
        agent: "crew-planner",
        status: "completed" as const,
        recentTools: [],
        toolCallCount: 0,
        tokens: 0,
        durationMs: 0,
      },
      taskId: "__planner__",
      wasGracefullyShutdown: false,
    },
  ];
}

function makeWorkerResult(taskId: string) {
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("crew namespace isolation (namespace-bleed)", () => {
  let spawnAgents: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;

    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;
  });

  // =========================================================================
  // 1. plan in `alpha` creates alpha-owned tasks
  // =========================================================================
  it("plan in alpha namespace creates tasks with namespace=alpha", async () => {
    writePlannerAgent(cwd);

    spawnAgents.mockResolvedValue(
      makeSpawnResult(
        makePlannerOutput([
          { title: "Alpha Task One", description: "First task" },
          { title: "Alpha Task Two", description: "Second task" },
        ]),
      ),
    );

    const planHandler = await import("../../crew/handlers/plan.js");

    const response = await planHandler.execute(
      { action: "plan", crew: "alpha", prompt: "Build the alpha feature", autoWork: false } as any,
      createMockContext(cwd),
      "TestAgent",
      () => {},
    );

    // Handler should report success
    expect(response.details.mode).toBe("plan");
    expect(response.details.error).toBeUndefined();

    // Returned tasksCreated should have 2 tasks
    const created = (response.details as any).tasksCreated as Array<{ id: string; title: string }>;
    expect(created).toHaveLength(2);

    // Each task in the store must carry namespace "alpha"
    for (const { id } of created) {
      const task = store.getTask(cwd, id);
      expect(task).not.toBeNull();
      expect(task!.namespace).toBe("alpha");
    }
  });

  // =========================================================================
  // 2. task.list for beta does NOT include alpha tasks
  // =========================================================================
  it("task.list for beta namespace does not expose alpha tasks", async () => {
    store.createPlan(cwd, "docs/PRD.md");

    // Create tasks in alpha namespace
    const alphaTask = store.createTask(cwd, "Alpha Work", "Do alpha things", undefined, "alpha");
    // Create tasks in beta namespace
    const betaTask = store.createTask(cwd, "Beta Work", "Do beta things", undefined, "beta");

    const taskHandler = await import("../../crew/handlers/task.js");

    const betaList = await taskHandler.execute(
      "list",
      { action: "task.list", crew: "beta" } as any,
      createState(),
      createMockContext(cwd),
    );

    const betaTasks = (betaList.details as any).tasks as Array<{ id: string }>;
    const betaIds = betaTasks.map((t) => t.id);

    // Beta list must NOT contain the alpha task
    expect(betaIds).not.toContain(alphaTask.id);
    // Beta list MUST contain the beta task
    expect(betaIds).toContain(betaTask.id);
  });

  // =========================================================================
  // 3. work only pulls ready tasks for the requested namespace
  // =========================================================================
  it("work for alpha namespace only spawns alpha tasks", async () => {
    writeWorkerAgent(cwd);
    store.createPlan(cwd, "docs/PRD.md");

    const alphaTask = store.createTask(cwd, "Alpha Task", "Do alpha things", undefined, "alpha");
    const betaTask = store.createTask(cwd, "Beta Task", "Do beta things", undefined, "beta");

    const spawnedTaskIds: string[] = [];

    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) spawnedTaskIds.push(t.taskId);
      }
      // Mark spawned tasks done so work handler can resolve them
      for (const t of tasks) {
        const rawId = t.taskId?.startsWith("alpha::") ? t.taskId.slice("alpha::".length) : t.taskId;
        if (rawId) store.updateTask(cwd, rawId, { status: "done" });
      }
      return tasks.map((t) => makeWorkerResult(t.taskId ?? "")) as any;
    });

    const workHandler = await import("../../crew/handlers/work.js");

    await workHandler.execute(
      { action: "work", crew: "alpha" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    // The spawned task IDs should only reference the alpha task
    expect(spawnedTaskIds.length).toBeGreaterThan(0);
    const spawnedRawIds = spawnedTaskIds.map((id) =>
      id.startsWith("alpha::") ? id.slice("alpha::".length) : id,
    );
    expect(spawnedRawIds).toContain(alphaTask.id);
    expect(spawnedRawIds).not.toContain(betaTask.id);
  });

  // =========================================================================
  // 4. shared (default) namespace still works
  // =========================================================================
  it("shared (default) namespace is visible without explicit namespace param", async () => {
    writeWorkerAgent(cwd);
    store.createPlan(cwd, "docs/PRD.md");

    const sharedTask = store.createTask(cwd, "Shared Task", "Shared work");

    // Verify task.list without namespace param returns shared task
    const taskHandler = await import("../../crew/handlers/task.js");

    const sharedList = await taskHandler.execute(
      "list",
      { action: "task.list" } as any,
      createState(),
      createMockContext(cwd),
    );

    const sharedTasks = (sharedList.details as any).tasks as Array<{ id: string }>;
    expect(sharedTasks.map((t) => t.id)).toContain(sharedTask.id);

    // Verify work without namespace param spawns shared tasks
    const spawnedTaskIds: string[] = [];
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) spawnedTaskIds.push(t.taskId);
      }
      for (const t of tasks) {
        if (t.taskId) store.updateTask(cwd, t.taskId, { status: "done" });
      }
      return tasks.map((t) => makeWorkerResult(t.taskId ?? "")) as any;
    });

    const workHandler = await import("../../crew/handlers/work.js");

    await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(spawnedTaskIds).toContain(sharedTask.id);
  });
});
