/**
 * Tests for file reservation enforcement in the work handler and worker prompts.
 * Covers Part 1 (file overlap detection → task deferral) and
 * Part 2 (RESERVED FILES section in worker prompts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock };
});

vi.mock("../../crew/agents.js", () => ({
  resolveModel: vi.fn((m?: string) => m),
  resolveModelForTaskRole: vi.fn((_role: string, taskModel?: string) => taskModel),
  selectCrewAgentForRole: vi.fn((agents: Array<{ name: string }>) =>
    agents.find(a => a.name === "crew-worker")
  ),
  spawnAgents: vi.fn(),
}));

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function writeAgent(cwd: string, name: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\ncrewRole: worker\n---\nYou are ${name}.\n`);
}

function makeResult(taskId: string, agent = "crew-worker") {
  return {
    agent,
    exitCode: 0,
    output: "",
    truncated: false,
    progress: { agent, status: "completed" as const, recentTools: [], toolCallCount: 0, tokens: 0, durationMs: 0 },
    taskId,
    wasGracefullyShutdown: false,
  };
}

// =============================================================================
// Part 1: Work Handler — File Overlap Detection and Task Deferral
// =============================================================================

describe("crew/work file overlap deferral", () => {
  let workHandler: typeof import("../../crew/handlers/work.js");
  let store: typeof import("../../crew/store.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    homedirMock.mockReturnValue(dirs.root);
    store = await import("../../crew/store.js");
    store.createPlan(cwd, "docs/PRD.md");
    workHandler = await import("../../crew/handlers/work.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;
    writeAgent(cwd, "crew-worker");
  });

  it("dispatches both tasks when they touch different files", async () => {
    const task1 = store.createTask(cwd, "Auth feature", "Modify `src/auth.ts` to add login");
    const task2 = store.createTask(cwd, "Store feature", "Modify `src/store.ts` to add cache");

    const dispatched: string[] = [];
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        const tid = t.taskId ?? "";
        dispatched.push(tid);
        store.updateTask(cwd, tid, { status: "done" });
      }
      return tasks.map(t => makeResult(t.taskId ?? "")) as any;
    });

    const response = await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    expect(response.details.succeeded).toContain(task1.id);
    expect(response.details.succeeded).toContain(task2.id);
    expect(dispatched).toHaveLength(2);
  });

  it("defers the second task when both tasks share a file", async () => {
    const task1 = store.createTask(cwd, "Add auth to work handler", "Edit `crew/handlers/work.ts` to add dispatch logic");
    const task2 = store.createTask(cwd, "Refactor work handler", "Modify `crew/handlers/work.ts` for serialization");

    const dispatched: string[] = [];
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        const tid = t.taskId ?? "";
        dispatched.push(tid);
        store.updateTask(cwd, tid, { status: "done" });
      }
      return tasks.map(t => makeResult(t.taskId ?? "")) as any;
    });

    await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    // Only the first task should have been dispatched
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBe(task1.id);

    // task2 should still be "todo" (deferred, not dispatched)
    const task2State = store.getTask(cwd, task2.id);
    expect(task2State?.status).toBe("todo");
  });

  it("deferred task is picked up in the next wave", async () => {
    const task1 = store.createTask(cwd, "First edit to work.ts", "Modify `crew/handlers/work.ts`");
    const task2 = store.createTask(cwd, "Second edit to work.ts", "Also modify `crew/handlers/work.ts`");

    let wave = 0;
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      wave++;
      for (const t of tasks) {
        const tid = t.taskId ?? "";
        store.updateTask(cwd, tid, { status: "done" });
      }
      return tasks.map(t => makeResult(t.taskId ?? "")) as any;
    });

    // Wave 1: only task1 dispatched (task2 deferred due to overlap)
    await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );
    expect(wave).toBe(1);
    expect(store.getTask(cwd, task1.id)?.status).toBe("done");
    expect(store.getTask(cwd, task2.id)?.status).toBe("todo");

    // Wave 2: task2 now available (task1 done, no more overlap)
    await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );
    expect(wave).toBe(2);
    expect(store.getTask(cwd, task2.id)?.status).toBe("done");
  });

  it("records deferral reason in task progress log", async () => {
    const task1 = store.createTask(cwd, "Edit auth", "Modify `src/auth.ts`");
    const task2 = store.createTask(cwd, "Also edit auth", "Also modify `src/auth.ts`");

    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) store.updateTask(cwd, t.taskId ?? "", { status: "done" });
      return tasks.map(t => makeResult(t.taskId ?? "")) as any;
    });

    await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    const progress = store.getTaskProgress(cwd, task2.id);
    expect(progress).toBeTruthy();
    expect(progress).toMatch(/[Ff]ile overlap|[Dd]eferred/);
    expect(progress).toContain("src/auth.ts");
  });

  it("tasks with no file mentions in specs are all dispatched (no false deferrals)", async () => {
    const task1 = store.createTask(cwd, "General task 1", "Implement the auth feature without specific file references");
    const task2 = store.createTask(cwd, "General task 2", "Implement the store feature without specific file references");

    const dispatched: string[] = [];
    spawnAgents.mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        dispatched.push(t.taskId ?? "");
        store.updateTask(cwd, t.taskId ?? "", { status: "done" });
      }
      return tasks.map(t => makeResult(t.taskId ?? "")) as any;
    });

    await workHandler.execute(
      { action: "work" } as any,
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    // Both tasks should be dispatched when no file paths are in specs
    expect(dispatched).toHaveLength(2);
  });
});

// =============================================================================
// Part 2: Worker Prompt — RESERVED FILES Section
// =============================================================================

describe("buildWorkerPrompt file reservation section", () => {
  let buildWorkerPrompt: typeof import("../../crew/prompt.js").buildWorkerPrompt;
  let cwd: string;

  const makeConfig = () => ({
    concurrency: { workers: 2, max: 10 },
    truncation: {
      planners: { bytes: 204800, lines: 5000 },
      workers: { bytes: 204800, lines: 5000 },
      reviewers: { bytes: 102400, lines: 2000 },
      analysts: { bytes: 102400, lines: 2000 },
    },
    artifacts: { enabled: false, cleanupDays: 7 },
    memory: { enabled: false },
    planSync: { enabled: false },
    review: { enabled: true, maxIterations: 3 },
    planning: { maxPasses: 3 },
    work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false, shutdownGracePeriodMs: 30000 },
    dependencies: "strict" as const,
    coordination: "none" as const,
    messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
  });

  function makeTask(id: string): import("../../crew/types.js").Task {
    return {
      id,
      title: `Task ${id}`,
      status: "in_progress",
      depends_on: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      attempt_count: 0,
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    homedirMock.mockReturnValue(dirs.root);
    const mod = await import("../../crew/prompt.js");
    buildWorkerPrompt = mod.buildWorkerPrompt;
  });

  it("includes RESERVED FILES section when fileReservationCtx has owned files", () => {
    const task = makeTask("task-1");
    const ctx = {
      ownedFiles: ["src/auth.ts", "src/auth.test.ts"],
      othersReservations: [],
    };

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, makeConfig(), [], ctx);

    expect(prompt).toContain("## ⚠️ File Reservations");
    expect(prompt).toContain("Your Reserved Files");
    expect(prompt).toContain("`src/auth.ts`");
    expect(prompt).toContain("`src/auth.test.ts`");
  });

  it("includes other workers' reserved files as DO NOT EDIT list", () => {
    const task = makeTask("task-1");
    const ctx = {
      ownedFiles: ["src/auth.ts"],
      othersReservations: [
        { taskId: "task-2", files: ["src/store.ts", "src/types.ts"] },
      ],
    };

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, makeConfig(), [], ctx);

    expect(prompt).toContain("⛔");
    expect(prompt).toContain("`src/store.ts`");
    expect(prompt).toContain("`src/types.ts`");
    expect(prompt).toContain("task-2");
    expect(prompt).toContain("DO NOT edit");
  });

  it("does NOT include file reservation section when ctx is undefined", () => {
    const task = makeTask("task-1");
    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, makeConfig(), []);

    expect(prompt).not.toContain("## ⚠️ File Reservations");
    expect(prompt).not.toContain("Your Reserved Files");
  });

  it("does NOT include section when ctx has no owned files and no others", () => {
    const task = makeTask("task-1");
    const ctx = {
      ownedFiles: [],
      othersReservations: [],
    };

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, makeConfig(), [], ctx);

    expect(prompt).not.toContain("## ⚠️ File Reservations");
  });

  it("reservation section appears before task specification in prompt", () => {
    const task = makeTask("task-1");
    // Write a spec file to trigger task specification section
    const dirs = createTempCrewDirs();
    fs.writeFileSync(
      path.join(dirs.tasksDir, "task-1.md"),
      "## Spec\nBuild the auth module."
    );

    const ctx = {
      ownedFiles: ["src/auth.ts"],
      othersReservations: [],
    };

    // Use the dirs.cwd where spec was written
    homedirMock.mockReturnValue(dirs.root);
    const prompt = buildWorkerPrompt(task, "docs/PRD.md", dirs.cwd, makeConfig(), [], ctx);

    const reservationIdx = prompt.indexOf("## ⚠️ File Reservations");
    const specIdx = prompt.indexOf("## Task Specification");

    if (reservationIdx !== -1 && specIdx !== -1) {
      expect(reservationIdx).toBeLessThan(specIdx);
    }
  });

  it("handles single-task scenario (no concurrent workers) gracefully", () => {
    const task = makeTask("task-1");
    const ctx = {
      ownedFiles: ["crew/handlers/work.ts"],
      othersReservations: [],
    };

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", cwd, makeConfig(), [], ctx);

    expect(prompt).toContain("`crew/handlers/work.ts`");
    // No "DO NOT edit" section when no concurrent workers
    expect(prompt).not.toContain("⛔");
  });
});
