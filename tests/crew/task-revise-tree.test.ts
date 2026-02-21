import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

vi.mock("../../crew/agents.js", () => ({
  spawnAgents: vi.fn(),
}));

describe("executeReviseTree", () => {
  let executeReviseTree: typeof import("../../crew/handlers/revise.js").executeReviseTree;
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.js");
  let state: typeof import("../../crew/state.js");
  let liveProgress: typeof import("../../crew/live-progress.js");
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/handlers/revise.js");
    executeReviseTree = mod.executeReviseTree;
    store = await import("../../crew/store.js");
    state = await import("../../crew/state.js");
    liveProgress = await import("../../crew/live-progress.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    store.createPlan(tmpDir, "docs/PRD.md");
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD");
  });

  afterEach(() => {
    state.autonomousState.active = false;
    state.autonomousState.cwd = null;
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  it("rejects when __reviser__ already running", async () => {
    const t1 = store.createTask(tmpDir, "Root task");
    liveProgress.updateLiveWorker(tmpDir, "__reviser__", {
      taskId: "__reviser__", agent: "p", name: "R",
      progress: { toolCallCount: 0, tokens: 0, currentTool: undefined, currentToolArgs: undefined, recentTools: [] },
      startedAt: Date.now(),
    });
    const r = await executeReviseTree(tmpDir, t1.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("already running");
    liveProgress.removeLiveWorker(tmpDir, "__reviser__");
  });

  it("rejects during planning", async () => {
    const t1 = store.createTask(tmpDir, "Root");
    state.startPlanningRun(tmpDir, 3);
    const r = await executeReviseTree(tmpDir, t1.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("planning");
    state.clearPlanningState(tmpDir);
  });

  it("rejects during autonomous work", async () => {
    const t1 = store.createTask(tmpDir, "Root");
    state.autonomousState.active = true;
    state.autonomousState.cwd = tmpDir;
    const r = await executeReviseTree(tmpDir, t1.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("autonomous");
  });

  it("rejects when subtree has live workers", async () => {
    const t1 = store.createTask(tmpDir, "Root");
    const t2 = store.createTask(tmpDir, "Child", undefined, [t1.id]);
    store.startTask(tmpDir, t2.id, "worker");
    liveProgress.updateLiveWorker(tmpDir, t2.id, {
      taskId: t2.id, agent: "p", name: "W",
      progress: { toolCallCount: 0, tokens: 0, currentTool: undefined, currentToolArgs: undefined, recentTools: [] },
      startedAt: Date.now(),
    });
    const r = await executeReviseTree(tmpDir, t1.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("live workers");
    liveProgress.removeLiveWorker(tmpDir, t2.id);
  });

  it("revises subtree: updates specs and resets non-done tasks", async () => {
    const t1 = store.createTask(tmpDir, "Root", "root spec");
    const t2 = store.createTask(tmpDir, "Child", "child spec", [t1.id]);
    const t3 = store.createTask(tmpDir, "Grandchild", "gc spec", [t2.id]);
    store.startTask(tmpDir, t1.id, "w");
    store.completeTask(tmpDir, t1.id, "done");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: `\`\`\`tasks-json
[
  {"id": "${t2.id}", "title": "Updated Child", "spec": "new child spec", "dependsOn": ["${t1.id}"]},
  {"id": "${t3.id}", "title": "Updated GC", "spec": "new gc spec", "dependsOn": ["${t2.id}"]}
]
\`\`\``,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await executeReviseTree(tmpDir, t1.id, "improve", "agent");
    expect(r.success).toBe(true);
    expect(r.message).toContain("2 dependents");

    expect(store.getTask(tmpDir, t2.id)?.title).toBe("Updated Child");
    expect(store.getTask(tmpDir, t2.id)?.status).toBe("todo");
    expect(store.getTaskSpec(tmpDir, t2.id)).toContain("new child spec");

    expect(store.getTask(tmpDir, t3.id)?.title).toBe("Updated GC");
    expect(store.getTask(tmpDir, t3.id)?.status).toBe("todo");
  });

  it("creates new tasks from entries without id", async () => {
    const t1 = store.createTask(tmpDir, "Root", "spec");
    const t2 = store.createTask(tmpDir, "Child", "spec", [t1.id]);

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: `\`\`\`tasks-json
[
  {"id": "${t2.id}", "title": "Child", "spec": "updated child", "dependsOn": ["${t1.id}"]},
  {"title": "New Task", "spec": "brand new spec", "dependsOn": ["${t2.id}"]}
]
\`\`\``,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await executeReviseTree(tmpDir, t1.id, undefined, "agent");
    expect(r.success).toBe(true);

    const allTasks = store.getTasks(tmpDir);
    const newTask = allTasks.find(t => t.title === "New Task");
    expect(newTask).toBeDefined();
    expect(store.getTaskSpec(tmpDir, newTask!.id)).toContain("brand new spec");
  });

  it("rejects if returned ID is outside subtree", async () => {
    const t1 = store.createTask(tmpDir, "Root", "spec");
    const t2 = store.createTask(tmpDir, "Child", "spec", [t1.id]);
    const t_outside = store.createTask(tmpDir, "Outside", "spec");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: `\`\`\`tasks-json
[
  {"id": "${t_outside.id}", "title": "Hijack", "spec": "bad", "dependsOn": []}
]
\`\`\``,
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await executeReviseTree(tmpDir, t1.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("outside the subtree");
  });
});

describe("getTransitiveDependents", () => {
  let store: typeof import("../../crew/store.js");
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    store = await import("../../crew/store.js");
    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    store.createPlan(tmpDir, "PRD.md");
  });

  it("returns linear chain dependents", () => {
    const t1 = store.createTask(tmpDir, "A");
    const t2 = store.createTask(tmpDir, "B", undefined, [t1.id]);
    const t3 = store.createTask(tmpDir, "C", undefined, [t2.id]);

    const deps = store.getTransitiveDependents(tmpDir, t1.id);
    expect(deps.map(d => d.id).sort()).toEqual([t2.id, t3.id].sort());
  });

  it("returns diamond dependency dependents", () => {
    const t1 = store.createTask(tmpDir, "Root");
    const t2 = store.createTask(tmpDir, "Left", undefined, [t1.id]);
    const t3 = store.createTask(tmpDir, "Right", undefined, [t1.id]);
    const t4 = store.createTask(tmpDir, "Merge", undefined, [t2.id, t3.id]);

    const deps = store.getTransitiveDependents(tmpDir, t1.id);
    expect(deps.map(d => d.id).sort()).toEqual([t2.id, t3.id, t4.id].sort());
  });

  it("returns empty for isolated task", () => {
    store.createTask(tmpDir, "A");
    const t2 = store.createTask(tmpDir, "B");
    const deps = store.getTransitiveDependents(tmpDir, t2.id);
    expect(deps).toEqual([]);
  });
});
