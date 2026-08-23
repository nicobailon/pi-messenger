import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

vi.mock("../../crew/agents.ts", () => ({
  spawnAgents: vi.fn(),
}));

describe("plan duplicate-run guard", () => {
  let planHandler: typeof import("../../crew/handlers/plan.ts");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.ts");
  let state: typeof import("../../crew/state.ts");
  let tmpDir: string;
  let mockCtx: ReturnType<typeof createMockContext>;

  const plannerOutput = `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n[{"title":"Task A","description":"Do A","dependsOn":[]}]\n\`\`\``;

  function planningStatePath(): string {
    return path.join(tmpDir, ".pi", "messenger", "crew", "planning-state.json");
  }

  function writePersistedPlanningState(pid: number): void {
    fs.mkdirSync(path.dirname(planningStatePath()), { recursive: true });
    fs.writeFileSync(planningStatePath(), JSON.stringify({
      active: true,
      cwd: tmpDir,
      runId: "run-from-another-process",
      pass: 1,
      maxPasses: 3,
      phase: "scan-code",
      updatedAt: new Date().toISOString(),
      pid,
    }, null, 2));
  }

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.ts");
    store = await import("../../crew/store.ts");
    state = await import("../../crew/state.ts");
    const agents = await import("../../crew/agents.ts");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild something");

    mockCtx = createMockContext(tmpDir);

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  it("rejects plan when a live planning run exists only in persisted state", async () => {
    // Simulate another process mid-planning: persisted state is active with a
    // live pid, but this process's in-memory state knows nothing about it.
    writePersistedPlanningState(process.pid);

    store.createPlan(tmpDir, "docs/PRD.md");

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    expect(r.details?.error).toBe("planning_active");
    expect(spawnAgents).not.toHaveBeenCalled();
  });

  it("clears a stale persisted run (dead pid) and plans normally", async () => {
    writePersistedPlanningState(2147483647);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    expect(r.details?.error).toBeUndefined();
    expect(store.getTasks(tmpDir)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(planningStatePath(), "utf-8")).active).toBe(false);
  });
});

describe("plan idempotent task creation", () => {
  let planHandler: typeof import("../../crew/handlers/plan.ts");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.ts");
  let state: typeof import("../../crew/state.ts");
  let tmpDir: string;
  let mockCtx: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.ts");
    store = await import("../../crew/store.ts");
    state = await import("../../crew/state.ts");
    const agents = await import("../../crew/agents.ts");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild something");

    mockCtx = createMockContext(tmpDir);
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  function outputWithTasks(tasks: Array<{ title: string; description: string; dependsOn: string[] }>): string {
    return `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n${JSON.stringify(tasks)}\n\`\`\``;
  }

  it("reuses an existing board task instead of appending a copy", async () => {
    // Simulate the interleaved duplicate run: while this plan is executing its
    // planner pass, a parallel execution already created "Task A".
    spawnAgents.mockImplementation(async () => {
      store.createPlan(tmpDir, "docs/PRD.md");
      store.createTask(tmpDir, "Task A", "Do A");
      return [{
        exitCode: 0,
        output: outputWithTasks([
          { title: "Task A", description: "Do A", dependsOn: [] },
          { title: "Task B", description: "Do B", dependsOn: ["Task A"] },
        ]),
        error: null,
        progress: { toolCallCount: 0, tokens: 0 },
      }];
    });

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    expect(r.details?.error).toBeUndefined();
    const tasks = store.getTasks(tmpDir);
    expect(tasks).toHaveLength(2);
    expect(tasks.filter(t => t.title === "Task A")).toHaveLength(1);
    const taskA = tasks.find(t => t.title === "Task A")!;
    const taskB = tasks.find(t => t.title === "Task B")!;
    expect(taskB.depends_on).toEqual([taskA.id]);
  });

  it("deduplicates repeated titles within one planner output", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: outputWithTasks([
        { title: "Task A", description: "Do A", dependsOn: [] },
        { title: "Task A", description: "Do A again", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    expect(r.details?.error).toBeUndefined();
    const tasks = store.getTasks(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(r.details?.tasksCreated).toHaveLength(1);
  });
});
