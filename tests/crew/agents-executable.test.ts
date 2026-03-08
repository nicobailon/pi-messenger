/**
 * Tests for crew/agents.ts — executable resolution and ENOENT guard.
 *
 * These tests mirror the equivalent lobby.test.ts reliability section,
 * covering the agents (task-oriented) spawn path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnAgents } from "../../crew/agents.js";
import * as store from "../../crew/store.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

type MockProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  exitCode: number | null;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProcess(exitCode: number): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 99999;
  proc.kill = vi.fn(() => true);

  queueMicrotask(() => {
    proc.exitCode = exitCode;
    proc.emit("exit", exitCode);
    proc.emit("close", exitCode);
  });

  return proc;
}

/** Create a minimal crew-worker agent config file in the temp dir. */
function writeWorkerAgent(cwd: string): void {
  const content = `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a test worker.
`;
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("crew/agents — executable resolution & ENOENT guard", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockProcess(0));
    execSyncMock.mockReset();
    // Simulate no `which` result by default
    execSyncMock.mockImplementation(() => { throw new Error("which: pi not found"); });
    // Ensure no leftover env var bleeds across tests
    delete process.env.PI_CREW_EXECUTABLE;
  });

  // ── Executable resolution ────────────────────────────────────────────────

  it("defaults to 'pi' when neither env var nor config.work.executable is set", async () => {
    writeWorkerAgent(dirs.cwd);

    await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-1" }], dirs.cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe("pi");
  });

  it("uses which pi path when available via shared resolver fallback", async () => {
    writeWorkerAgent(dirs.cwd);
    execSyncMock.mockReturnValueOnce("/which/pi/path\n");

    await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-2" }], dirs.cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe("/which/pi/path");
  });

  it("uses PI_CREW_EXECUTABLE env var as the spawned executable", async () => {
    writeWorkerAgent(dirs.cwd);
    process.env.PI_CREW_EXECUTABLE = "my-custom-pi";

    try {
      await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-1" }], dirs.cwd);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toBe("my-custom-pi");
    } finally {
      delete process.env.PI_CREW_EXECUTABLE;
    }
  });

  it("uses config.work.executable when env var is absent", async () => {
    writeWorkerAgent(dirs.cwd);

    // Write a crew.json that sets work.executable
    const crewConfigPath = path.join(dirs.crewDir, "config.json");
    fs.writeFileSync(
      crewConfigPath,
      JSON.stringify({ work: { executable: "helios-pi" } }),
    );

    await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-1" }], dirs.cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe("helios-pi");
  });

  it("PI_CREW_EXECUTABLE takes priority over config.work.executable", async () => {
    writeWorkerAgent(dirs.cwd);
    process.env.PI_CREW_EXECUTABLE = "env-pi";

    const crewConfigPath = path.join(dirs.crewDir, "config.json");
    fs.writeFileSync(
      crewConfigPath,
      JSON.stringify({ work: { executable: "config-pi" } }),
    );

    try {
      await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-1" }], dirs.cwd);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toBe("env-pi");
    } finally {
      delete process.env.PI_CREW_EXECUTABLE;
    }
  });

  it("loads configured git package extensions from settings.json and still loads pi-messenger", async () => {
    writeWorkerAgent(dirs.cwd);
    const originalHome = process.env.HOME;
    process.env.HOME = dirs.root;

    try {
      const settingsPath = path.join(dirs.root, ".pi", "agent", "settings.json");
      const packageExtensionPath = path.join(
        dirs.root,
        ".pi",
        "agent",
        "git",
        "github.com",
        "acme",
        "pi-extra",
        "index.ts",
      );
      fs.mkdirSync(path.dirname(packageExtensionPath), { recursive: true });
      fs.writeFileSync(packageExtensionPath, "export {};\n");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ packages: ["git:github.com/acme/pi-extra"] }),
      );

      await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-ext" }], dirs.cwd);

      const args = spawnMock.mock.calls[0][1] as string[];
      const extensionValues: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--extension" && args[i + 1]) {
          extensionValues.push(args[i + 1]);
        }
      }

      expect(extensionValues).toContain(packageExtensionPath);
      expect(extensionValues.some(ext => path.basename(ext) === "pi-messenger")).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  // ── ENOENT / spawn error guard ───────────────────────────────────────────

  it("registers an 'error' handler on the spawned process to prevent crash", async () => {
    writeWorkerAgent(dirs.cwd);

    // Capture the mock proc before spawnAgents resolves
    let capturedProc: MockProcess | null = null;
    spawnMock.mockImplementationOnce((..._args: unknown[]) => {
      const proc = createMockProcess(0);
      capturedProc = proc;
      return proc;
    });

    await spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-1" }], dirs.cwd);

    expect(capturedProc).not.toBeNull();
    // Must have a registered 'error' listener (otherwise Node crashes on ENOENT)
    expect((capturedProc as MockProcess).listenerCount("error")).toBeGreaterThan(0);
  });

  it("error handler does not throw when ENOENT fires", async () => {
    writeWorkerAgent(dirs.cwd);

    let capturedProc: MockProcess | null = null;
    spawnMock.mockImplementationOnce((..._args: unknown[]) => {
      // Return a proc that never closes on its own (so spawnAgents stays open)
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.exitCode = null;
      proc.pid = 88888;
      proc.kill = vi.fn();
      capturedProc = proc;
      // Emit close after error, as Node.js does
      queueMicrotask(() => {
        proc.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }));
        proc.exitCode = -2;
        proc.emit("close", -2);
      });
      return proc;
    });

    // spawnAgents must resolve without throwing
    await expect(
      spawnAgents([{ agent: "crew-worker", task: "do work", taskId: "task-1" }], dirs.cwd),
    ).resolves.not.toThrow();

    expect(capturedProc).not.toBeNull();
    expect((capturedProc as MockProcess).listenerCount("error")).toBeGreaterThan(0);
  });

  it("spawn failure persists metadata, increments spawn_failure_count, and resets the preassigned task", async () => {
    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task two", "Desc two");
    store.updateTask(dirs.cwd, task.id, {
      status: "in_progress",
      assigned_to: "LaunchWorker",
      started_at: new Date().toISOString(),
      base_commit: "abc12345",
    });

    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.exitCode = null;
      proc.pid = 77777;
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT", syscall: "spawn", path: "pi" }));
        proc.exitCode = 1;
        proc.emit("close", 1);
      });
      return proc;
    });

    const results = await spawnAgents(
      [{ agent: "crew-worker", task: "do work", taskId: task.id, workerName: "LaunchWorker" }],
      dirs.cwd,
    );

    expect(results).toHaveLength(1);
    expect(results[0].exitCode).toBe(1);
    expect(results[0].error).toContain("ENOENT");
    expect(results[0].progress.error).toContain("ENOENT");
    expect(results[0].artifactPaths?.metadata).toBeTruthy();

    const metadata = JSON.parse(fs.readFileSync(results[0].artifactPaths!.metadata, "utf-8"));
    expect(metadata.error).toContain("ENOENT");
    expect(metadata.spawnFailure.code).toBe("ENOENT");
    expect(metadata.spawnFailure.workerName).toBe("LaunchWorker");

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(reloaded?.started_at).toBeUndefined();
    expect(reloaded?.base_commit).toBeUndefined();
    expect(reloaded?.spawn_failure_count).toBe(1);

    expect(store.getTaskProgress(dirs.cwd, task.id)).toContain("Worker launch failed for LaunchWorker");
  });

  it("spawn failure results in a failed AgentResult (not a crash)", async () => {
    writeWorkerAgent(dirs.cwd);

    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as MockProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.exitCode = null;
      proc.pid = 77777;
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }));
        proc.exitCode = -2;
        proc.emit("close", -2);
      });
      return proc;
    });

    const results = await spawnAgents(
      [{ agent: "crew-worker", task: "do work", taskId: "task-2" }],
      dirs.cwd,
    );

    expect(results).toHaveLength(1);
    expect(results[0].exitCode).not.toBe(0);
    expect(results[0].progress.status).toBe("failed");
  });
});
