import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

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

describe("crew/graceful shutdown", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    vi.restoreAllMocks();
  });

  it("raceTimeout returns true when promise resolves before timeout and false on timeout", async () => {
    const { raceTimeout } = await import("../../crew/agents.js");

    const fast = raceTimeout(new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    }), 100);
    const slow = raceTimeout(new Promise<void>(() => {}), 5);

    await expect(fast).resolves.toBe(true);
    await expect(slow).resolves.toBe(false);
  });

  it("abort signal writes shutdown inbox message and marks wasGracefullyShutdown", async () => {
    vi.resetModules();

    const spawnMock = vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        exitCode: number | null;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      proc.pid = 4242;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.exitCode = null;
      proc.kill = (signal?: NodeJS.Signals) => {
        proc.killed = true;
        proc.exitCode = signal === "SIGKILL" ? 137 : 143;
        queueMicrotask(() => {
          proc.emit("exit", proc.exitCode);
          proc.emit("close", proc.exitCode);
        });
        return true;
      };
      return proc;
    });

    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { spawnAgents } = await import("../../crew/agents.js");

    writeWorkerAgent(dirs.cwd);

    fs.writeFileSync(path.join(dirs.crewDir, "config.json"), JSON.stringify({
      work: {
        shutdownGracePeriodMs: 1,
      },
    }, null, 2));

    const messengerDirs = createDirs(dirs.cwd);
    const workerName = "worker-test";
    fs.mkdirSync(path.join(messengerDirs.inbox, workerName), { recursive: true });
    fs.writeFileSync(path.join(messengerDirs.registry, `${workerName}.json`), JSON.stringify({
      name: workerName,
      pid: 4242,
    }, null, 2));

    const controller = new AbortController();
    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "execute task",
      taskId: "task-1",
    }], dirs.cwd, {
      signal: controller.signal,
      messengerDirs: { registry: messengerDirs.registry, inbox: messengerDirs.inbox },
    });

    controller.abort();
    const results = await resultPromise;

    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("task-1");
    expect(results[0].wasGracefullyShutdown).toBe(true);
    expect(results[0].exitCode).toBe(143);

    const inboxFiles = fs.readdirSync(path.join(messengerDirs.inbox, workerName));
    expect(inboxFiles.some(f => f.endsWith("-shutdown.json"))).toBe(true);

    const shutdownFile = inboxFiles.find(f => f.endsWith("-shutdown.json"))!;
    const shutdownPayload = JSON.parse(
      fs.readFileSync(path.join(messengerDirs.inbox, workerName, shutdownFile), "utf-8")
    );
    expect(shutdownPayload.text).toContain("SHUTDOWN REQUESTED");
    expect(shutdownPayload.from).toBe("crew-orchestrator");

    expect(fs.existsSync(path.join(messengerDirs.registry, `${workerName}.json`))).toBe(false);
  });

  it("result processing uses taskId and graceful shutdown branches correctly", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      store.updateTask(dirs.cwd, task.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "running" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: task.id,
        wasGracefullyShutdown: true,
      }];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([task.id]);
    expect(response.details.blocked).toEqual([]);
  });

  it("graceful non-zero exit with done task is credited as success; crash blocks in autonomous mode", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    let call = 0;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      call++;
      if (call === 1) {
        store.updateTask(dirs.cwd, t1.id, { status: "done" });
        return [{
          agent: "crew-worker",
          exitCode: 1,
          output: "",
          truncated: false,
          progress: {
            agent: "crew-worker",
            status: "failed" as const,
            recentTools: [],
            toolCallCount: 0,
            tokens: 0,
            durationMs: 0,
          },
          taskId: t1.id,
          wasGracefullyShutdown: true,
          error: "terminated",
        }];
      }

      store.updateTask(dirs.cwd, t2.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t2.id,
        wasGracefullyShutdown: false,
        error: "crash",
      }];
    });

    const first = await workHandler.execute(
      { action: "work", concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(first.details.succeeded).toEqual([t1.id]);

    const second = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(second.details.blocked).toEqual([t2.id]);
    expect(store.getTask(dirs.cwd, t2.id)?.status).toBe("blocked");
  });

  it("autonomous mode stops with manual reason when signal is aborted", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");
    const state = await import("../../crew/state.js");

    state.autonomousState.active = false;
    state.autonomousState.cwd = null;
    state.autonomousState.waveNumber = 0;
    state.autonomousState.waveHistory = [];
    state.autonomousState.startedAt = null;
    state.autonomousState.stoppedAt = null;
    state.autonomousState.stopReason = null;
    state.autonomousState.concurrency = 2;
    state.autonomousState.autoOverlayPending = false;

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      store.updateTask(dirs.cwd, task.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: task.id,
        wasGracefullyShutdown: true,
      }];
    });

    const controller = new AbortController();
    controller.abort();

    const appendEntry = vi.fn();
    const response = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      appendEntry,
      controller.signal,
    );

    expect(state.autonomousState.active).toBe(false);
    expect(state.autonomousState.stopReason).toBe("manual");
    expect(appendEntry).toHaveBeenCalledWith("crew-state", state.autonomousState);
    expect(response.content[0].text).toContain("Autonomous mode stopped (cancelled).");
  });

  it("clamps fractional concurrency and passes all ready tasks to spawnAgents", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const state = await import("../../crew/state.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    store.createTask(dirs.cwd, "Task one", "Desc one");
    store.createTask(dirs.cwd, "Task two", "Desc two");
    store.createTask(dirs.cwd, "Task three", "Desc three");

    const spawnSpy = vi.spyOn(agents, "spawnAgents").mockResolvedValue([]);

    await workHandler.execute(
      { action: "work", concurrency: 1.8 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(state.autonomousState.concurrency).toBe(1);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const workerTasks = spawnSpy.mock.calls[0][0] as Array<{ taskId: string }>;
    expect(workerTasks).toHaveLength(3);
  });

  it("reconciles completed_count before returning from a no-ready wave", async () => {
    const store = await import("../../crew/store.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    store.startTask(dirs.cwd, t1.id, "WorkerA");
    store.completeTask(dirs.cwd, t1.id, "Done");
    store.startTask(dirs.cwd, t2.id, "WorkerB");
    store.completeTask(dirs.cwd, t2.id, "Done");

    store.updatePlan(dirs.cwd, { completed_count: 0 });
    expect(store.getPlan(dirs.cwd)?.completed_count).toBe(0);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(store.getPlan(dirs.cwd)?.completed_count).toBe(2);
    expect(response.content[0].text).toContain("All tasks are done");
  });

  it("reconciles completed_count after worker results are processed", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) {
          store.updateTask(dirs.cwd, t.taskId, { status: "done" });
        }
      }
      return tasks.map(t => ({
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
        taskId: t.taskId,
      }));
    });

    const response = await workHandler.execute(
      { action: "work", concurrency: 2 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(store.getPlan(dirs.cwd)?.completed_count).toBe(2);
    expect(response.content[0].text).toContain("**Progress:** 2/2");
    expect(response.details.succeeded).toEqual([t1.id, t2.id]);
  });

  it("auto-blocks tasks that exceed maxAttemptsPerTask before assigning to workers", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Flaky task", "Keeps failing");

    store.updateTask(dirs.cwd, t1.id, { attempt_count: 5 });

    const spawnSpy = vi.spyOn(agents, "spawnAgents").mockImplementation(async () => []);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, t1.id);
    expect(reloaded?.status).toBe("blocked");
    expect(reloaded?.blocked_reason).toContain("Max attempts");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain("No ready tasks");
  });

  it("worker exit 0 with task still in_progress resets to todo", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Abandoned task", "Worker forgot task.done");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, "Worker");
      }
      return tasks.map(t => ({
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "running" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t.taskId,
      }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, t1.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([t1.id]);
  });

  it("graceful shutdown with non-zero exit and in_progress task resets to todo and reports failed", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Interrupted task", "Graceful non-zero");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, "Worker");
      }
      return tasks.map(t => ({
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t.taskId,
        wasGracefullyShutdown: true,
        error: "terminated",
      }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, t1.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([t1.id]);
    expect(response.details.blocked).toEqual([]);
  });
});
