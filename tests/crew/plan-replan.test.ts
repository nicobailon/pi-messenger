import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import type { Plan } from "../../crew/types.js";

vi.mock("../../crew/agents.js", () => ({
  spawnAgents: vi.fn(),
}));

describe("plan with prompt (re-plan)", () => {
  let planHandler: typeof import("../../crew/handlers/plan.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.js");
  let state: typeof import("../../crew/state.js");
  let tmpDir: string;
  let mockCtx: any;

  const plannerOutput = `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n[{"title":"Task A","description":"Do A","dependsOn":[]}]\n\`\`\``;

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.js");
    store = await import("../../crew/store.js");
    state = await import("../../crew/state.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild something");

    mockCtx = { cwd: tmpDir, hasUI: false, ui: {} };
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  it("rejects plan with existing tasks and no prompt", async () => {
    store.createPlan(tmpDir, "docs/PRD.md");
    store.createTask(tmpDir, "Existing task");

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBe("plan_exists");
  });

  it("re-plans when prompt provided with existing tasks", async () => {
    store.createPlan(tmpDir, "docs/PRD.md");
    store.createTask(tmpDir, "Old task 1");
    store.createTask(tmpDir, "Old task 2");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute(
      { action: "plan", prompt: "focus on performance" },
      mockCtx,
      "agent",
    );

    expect(r.details?.error).toBeUndefined();
    const tasks = store.getTasks(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Task A");
  });

  it("rejects re-plan when tasks are in_progress", async () => {
    store.createPlan(tmpDir, "docs/PRD.md");
    const task = store.createTask(tmpDir, "Active task");
    store.startTask(tmpDir, task.id, "worker");

    const r = await planHandler.execute(
      { action: "plan", prompt: "re-plan" },
      mockCtx,
      "agent",
    );
    expect(r.details?.error).toBe("tasks_in_progress");
  });

  it("injects prompt into planning-progress.md Notes section", async () => {
    store.createPlan(tmpDir, "docs/PRD.md");
    store.createTask(tmpDir, "Old task");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    await planHandler.execute(
      { action: "plan", prompt: "ignore auth" },
      mockCtx,
      "agent",
    );

    const progressPath = path.join(store.getCrewDir(tmpDir), "planning-progress.md");
    const content = fs.readFileSync(progressPath, "utf-8");
    expect(content).toContain("Re-plan: ignore auth");
    const replanIdx = content.indexOf("Re-plan: ignore auth");
    const runIdx = content.indexOf("## Run:");
    expect(replanIdx).toBeLessThan(runIdx);
  });

  it("injects prompt on first plan with steering", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    await planHandler.execute(
      { action: "plan", prd: "docs/PRD.md", prompt: "focus on performance" },
      mockCtx,
      "agent",
    );

    const progressPath = path.join(store.getCrewDir(tmpDir), "planning-progress.md");
    const content = fs.readFileSync(progressPath, "utf-8");
    expect(content).toContain("Re-plan: focus on performance");
  });
});

describe("plan with prompt as spec", () => {
  let planHandler: typeof import("../../crew/handlers/plan.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.js");
  let state: typeof import("../../crew/state.js");
  let tmpDir: string;
  let mockCtx: any;

  const plannerOutput = `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n[{"title":"Task A","description":"Do A","dependsOn":[]}]\n\`\`\``;

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.js");
    store = await import("../../crew/store.js");
    state = await import("../../crew/state.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    // No PRD file created — prompt-as-spec path requires no discoverable PRD
    mockCtx = { cwd: tmpDir, hasUI: false, ui: {} };
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  it("creates plan from prompt when no PRD exists", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute(
      { action: "plan", prompt: "Find all bugs in error handling" },
      mockCtx,
      "agent",
    );

    expect(r.details?.error).toBeUndefined();
    expect(r.details?.prd).toBe("(prompt)");

    const plan = store.getPlan(tmpDir);
    expect(plan?.prd).toBe("(prompt)");
    expect(plan?.prompt).toBe("Find all bugs in error handling");

    const plannerTask = spawnAgents.mock.calls[0][0][0].task;
    expect(plannerTask).toContain("Find all bugs in error handling");
    expect(plannerTask).toContain("this request");
    expect(plannerTask).toContain("## Request");

    const progressPath = path.join(store.getCrewDir(tmpDir), "planning-progress.md");
    const content = fs.readFileSync(progressPath, "utf-8");
    expect(content).not.toContain("Re-plan:");
  });

  it("errors when no PRD and no prompt provided", async () => {
    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBe("no_prd");
    expect(r.content[0].text).toContain("prompt");
  });

  it("auto-discovered PRD takes priority over prompt", async () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild something");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute(
      { action: "plan", prompt: "focus on errors" },
      mockCtx,
      "agent",
    );

    expect(r.details?.error).toBeUndefined();
    expect(r.details?.prd).toBe("docs/PRD.md");

    const plannerTask = spawnAgents.mock.calls[0][0][0].task;
    expect(plannerTask).toContain("Build something");

    const progressPath = path.join(store.getCrewDir(tmpDir), "planning-progress.md");
    const content = fs.readFileSync(progressPath, "utf-8");
    expect(content).toContain("Re-plan: focus on errors");
  });

  it("prompt-based plan shows correct success label", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute(
      { action: "plan", prompt: "Scan for bugs" },
      mockCtx,
      "agent",
    );

    expect(r.content[0].text).toContain('"Scan for bugs"');
    expect(r.content[0].text).not.toContain("**(prompt)**");
  });
});

describe("plan transitive dependency pruning", () => {
  let planHandler: typeof import("../../crew/handlers/plan.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.js");
  let state: typeof import("../../crew/state.js");
  let tmpDir: string;
  let mockCtx: any;

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.js");
    store = await import("../../crew/store.js");
    state = await import("../../crew/state.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild something");

    mockCtx = { cwd: tmpDir, hasUI: false, ui: {} };
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  async function runPlanWithTasks(tasks: Array<{ title: string; description: string; dependsOn: string[] }>) {
    const output = `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);
    const response = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(response.details?.error).toBeUndefined();
    return store.getTasks(tmpDir);
  }

  it("prunes linear transitive dependencies after ID resolution", async () => {
    const tasks = await runPlanWithTasks([
      { title: "Task A", description: "A", dependsOn: [] },
      { title: "Task B", description: "B", dependsOn: ["Task A"] },
      { title: "Task C", description: "C", dependsOn: ["Task A", "Task B"] },
    ]);

    const byTitle = new Map(tasks.map(t => [t.title, t]));
    expect(byTitle.get("Task C")?.depends_on).toEqual([byTitle.get("Task B")!.id]);
  });

  it("prunes diamond transitive dependencies", async () => {
    const tasks = await runPlanWithTasks([
      { title: "Task A", description: "A", dependsOn: [] },
      { title: "Task B", description: "B", dependsOn: ["Task A"] },
      { title: "Task C", description: "C", dependsOn: ["Task A"] },
      { title: "Task D", description: "D", dependsOn: ["Task A", "Task B", "Task C"] },
    ]);

    const byTitle = new Map(tasks.map(t => [t.title, t]));
    expect(byTitle.get("Task D")?.depends_on).toEqual([
      byTitle.get("Task B")!.id,
      byTitle.get("Task C")!.id,
    ]);
  });

  it("keeps tasks with no dependencies unchanged", async () => {
    const tasks = await runPlanWithTasks([
      { title: "Task A", description: "A", dependsOn: [] },
      { title: "Task B", description: "B", dependsOn: [] },
    ]);

    expect(tasks.find(t => t.title === "Task A")?.depends_on).toEqual([]);
    expect(tasks.find(t => t.title === "Task B")?.depends_on).toEqual([]);
  });

  it("keeps single dependencies unchanged", async () => {
    const tasks = await runPlanWithTasks([
      { title: "Task A", description: "A", dependsOn: [] },
      { title: "Task B", description: "B", dependsOn: ["Task A"] },
    ]);

    const byTitle = new Map(tasks.map(t => [t.title, t]));
    expect(byTitle.get("Task B")?.depends_on).toEqual([byTitle.get("Task A")!.id]);
  });

  it("handles circular references without crashing", async () => {
    const tasks = await runPlanWithTasks([
      { title: "Task A", description: "A", dependsOn: ["Task B"] },
      { title: "Task B", description: "B", dependsOn: ["Task A"] },
    ]);

    expect(tasks).toHaveLength(2);
  });
});

describe("getPlanLabel", () => {
  let store: typeof import("../../crew/store.js");

  beforeEach(async () => {
    vi.resetModules();
    store = await import("../../crew/store.js");
  });

  it("returns prd path for file-based plans", () => {
    const plan: Plan = { prd: "docs/PRD.md", created_at: "", updated_at: "", task_count: 0, completed_count: 0 };
    expect(store.getPlanLabel(plan)).toBe("docs/PRD.md");
  });

  it("returns prompt text for prompt-based plans", () => {
    const plan: Plan = { prd: "(prompt)", prompt: "Find bugs", created_at: "", updated_at: "", task_count: 0, completed_count: 0 };
    expect(store.getPlanLabel(plan)).toBe("Find bugs");
  });

  it("truncates long prompts", () => {
    const longPrompt = "A".repeat(100);
    const plan: Plan = { prd: "(prompt)", prompt: longPrompt, created_at: "", updated_at: "", task_count: 0, completed_count: 0 };
    const label = store.getPlanLabel(plan);
    expect(label.length).toBe(60);
    expect(label).toMatch(/\.\.\.$/);
  });

  it("respects custom maxLen", () => {
    const plan: Plan = { prd: "(prompt)", prompt: "Short prompt that is long enough", created_at: "", updated_at: "", task_count: 0, completed_count: 0 };
    const label = store.getPlanLabel(plan, 20);
    expect(label.length).toBe(20);
    expect(label).toMatch(/\.\.\.$/);
  });
});

describe("plan with autoWork", () => {
  let planHandler: typeof import("../../crew/handlers/plan.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.js");
  let state: typeof import("../../crew/state.js");
  let tmpDir: string;
  let mockCtx: any;

  const plannerOutput = `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n[{"title":"Task A","description":"Do A","dependsOn":[]}]\n\`\`\``;

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.js");
    store = await import("../../crew/store.js");
    state = await import("../../crew/state.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild something");

    mockCtx = { cwd: tmpDir, hasUI: false, ui: {} };
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
    state.consumePendingAutoWork();
  });

  it("sets pendingAutoWork when autoWork is true", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    expect(state.isPendingAutoWork()).toBe(false);

    const r = await planHandler.execute(
      { action: "plan", autoWork: true },
      mockCtx,
      "agent",
    );

    expect(r.details?.error).toBeUndefined();
    expect(state.isPendingAutoWork()).toBe(true);
    expect(r.content[0].text).toContain("Workers will start automatically");
    expect(r.content[0].text).not.toContain("Next steps");
  });

  it("sets pendingAutoWork by default when autoWork is omitted", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute(
      { action: "plan" },
      mockCtx,
      "agent",
    );

    expect(r.details?.error).toBeUndefined();
    expect(state.isPendingAutoWork()).toBe(true);
    expect(r.content[0].text).toContain("Workers will start automatically");
  });

  it("does not set pendingAutoWork when autoWork is false", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutput,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute(
      { action: "plan", autoWork: false },
      mockCtx,
      "agent",
    );

    expect(r.details?.error).toBeUndefined();
    expect(state.isPendingAutoWork()).toBe(false);
    expect(r.content[0].text).toContain("Next steps");
    expect(r.content[0].text).not.toContain("Workers will start automatically");
  });
});
