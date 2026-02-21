import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, Function> = {};
    const proc: any = {
      pid: 12345,
      killed: false,
      exitCode: null,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
      kill: vi.fn(() => { proc.exitCode = 0; }),
      _handlers: handlers,
    };
    return proc;
  }),
}));

vi.mock("../../crew/store.js", () => ({
  getPlan: vi.fn(() => ({ prd: "docs/PRD.md" })),
  getCrewDir: vi.fn((cwd: string) => `${cwd}/.pi/messenger/crew`),
  getTask: vi.fn(() => null),
  getBaseCommit: vi.fn(() => "abc1234"),
  updateTask: vi.fn(),
  appendTaskProgress: vi.fn(),
}));

vi.mock("../../feed.js", () => ({
  logFeedEvent: vi.fn(),
}));

vi.mock("../../crew/utils/config.js", () => ({
  loadCrewConfig: vi.fn(() => ({
    concurrency: { workers: 4 },
    models: {},
    artifacts: { enabled: false },
    work: {},
    coordination: "chatty",
  })),
}));

vi.mock("../../crew/utils/discover.js", () => ({
  discoverCrewAgents: vi.fn(() => [{
    name: "crew-worker",
    description: "worker",
    systemPrompt: "# Crew Worker\nYou implement tasks.",
    tools: ["read", "write", "edit", "bash", "pi_messenger"],
    source: "extension",
    filePath: "/ext/crew-worker.md",
    crewRole: "worker",
    model: "claude-opus-4-5",
  }]),
}));

vi.mock("../../crew/live-progress.js", () => ({
  updateLiveWorker: vi.fn(),
  removeLiveWorker: vi.fn(),
}));

vi.mock("../../lib.js", async () => {
  let counter = 0;
  return {
    generateMemorableName: () => `TestWorker${++counter}`,
  };
});

function createTestCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-lobby-test-"));
  fs.mkdirSync(path.join(cwd, ".pi", "messenger", "crew"), { recursive: true });
  return cwd;
}

describe("lobby workers", () => {
  let lobby: typeof import("../../crew/lobby.js");
  let liveProgress: typeof import("../../crew/live-progress.js");

  beforeEach(async () => {
    vi.resetModules();
    lobby = await import("../../crew/lobby.js");
    liveProgress = await import("../../crew/live-progress.js");
  });

  it("spawns a lobby worker and registers it in live progress", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd");
    expect(worker).not.toBeNull();
    expect(worker!.name).toContain("TestWorker");
    expect(worker!.assignedTaskId).toBeNull();
    expect(worker!.cwd).toBe("/test/cwd");
    expect(liveProgress.updateLiveWorker).toHaveBeenCalledWith(
      "/test/cwd",
      expect.stringContaining("__lobby-"),
      expect.objectContaining({ agent: "crew-worker" }),
    );
  });

  it("returns null if no crew-worker agent is discovered", async () => {
    const discover = await import("../../crew/utils/discover.js");
    vi.mocked(discover.discoverCrewAgents).mockReturnValueOnce([]);
    const worker = lobby.spawnLobbyWorker("/test/cwd");
    expect(worker).toBeNull();
  });

  it("counts available lobby workers for a cwd", () => {
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(0);
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(1);
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(2);
    expect(lobby.getLobbyWorkerCount("/other/cwd")).toBe(0);
  });

  it("getAvailableLobbyWorkers returns only unassigned workers", () => {
    const w1 = lobby.spawnLobbyWorker("/test/cwd")!;
    lobby.spawnLobbyWorker("/test/cwd")!;
    expect(lobby.getAvailableLobbyWorkers("/test/cwd")).toHaveLength(2);

    w1.assignedTaskId = "task-1";
    expect(lobby.getAvailableLobbyWorkers("/test/cwd")).toHaveLength(1);
  });

  it("removeLobbyWorkerByIndex kills one unassigned lobby worker", () => {
    lobby.spawnLobbyWorker("/test/cwd");
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(2);

    const removed = lobby.removeLobbyWorkerByIndex("/test/cwd");
    expect(removed).toBe(true);
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(1);
  });

  it("removeLobbyWorkerByIndex returns false when no lobby workers exist", () => {
    expect(lobby.removeLobbyWorkerByIndex("/test/cwd")).toBe(false);
  });

  it("killLobbyWorkerForTask kills lobby worker assigned to a specific task", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-9";

    const killed = lobby.killLobbyWorkerForTask("/test/cwd", "task-9");
    expect(killed).toBe(true);
    const proc = worker.proc as any;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("killLobbyWorkerForTask returns false when no matching worker", () => {
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.killLobbyWorkerForTask("/test/cwd", "task-99")).toBe(false);
  });

  it("shutdownLobbyWorkers kills all lobby workers for a cwd", () => {
    lobby.spawnLobbyWorker("/test/cwd");
    lobby.spawnLobbyWorker("/test/cwd");
    lobby.spawnLobbyWorker("/other/cwd");

    lobby.shutdownLobbyWorkers("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(0);
    expect(lobby.getLobbyWorkerCount("/other/cwd")).toBe(1);
  });

  it("assignTaskToLobbyWorker marks worker as assigned", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    expect(worker.assignedTaskId).toBeNull();

    const assigned = lobby.assignTaskToLobbyWorker(worker, "task-3", "# Task 3\nDo stuff", "/tmp/test-inbox");
    expect(assigned).toBe(true);
    expect(worker.assignedTaskId).toBe("task-3");
    expect(lobby.getAvailableLobbyWorkers("/test/cwd")).toHaveLength(0);
  });

  it("assignTaskToLobbyWorker rejects already-assigned worker", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-1";
    const secondAssign = lobby.assignTaskToLobbyWorker(worker, "task-2", "prompt", "/tmp/test-inbox");
    expect(secondAssign).toBe(false);
    expect(worker.assignedTaskId).toBe("task-1");
  });

  it("manages keep-alive file lifecycle on spawn, assignment, direct assignment, and shutdown", async () => {
    const cwd = createTestCwd();
    const inboxDir = path.join(cwd, ".pi", "messenger", "inbox");

    const worker = lobby.spawnLobbyWorker(cwd)!;
    expect(worker.aliveFile).toBeTruthy();
    expect(fs.existsSync(worker.aliveFile!)).toBe(true);

    const assigned = lobby.assignTaskToLobbyWorker(worker, "task-keepalive", "# Task\nDo work", inboxDir);
    expect(assigned).toBe(true);
    expect(fs.existsSync(worker.aliveFile!)).toBe(false);

    const storeModule = await import("../../crew/store.js");
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-keepalive-direct", title: "Direct assign", status: "todo", attempt_count: 0,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const directWorker = lobby.spawnWorkerForTask(cwd, "task-keepalive-direct", "# Task prompt");
    expect(directWorker).not.toBeNull();
    expect(directWorker!.assignedTaskId).toBe("task-keepalive-direct");
    expect(directWorker!.aliveFile).toBeTruthy();
    expect(fs.existsSync(directWorker!.aliveFile!)).toBe(false);

    const idleWorker = lobby.spawnLobbyWorker(cwd)!;
    expect(idleWorker.aliveFile).toBeTruthy();
    expect(fs.existsSync(idleWorker.aliveFile!)).toBe(true);

    lobby.shutdownLobbyWorkers(cwd);
    expect(fs.existsSync(idleWorker.aliveFile!)).toBe(false);
  });

  it("cleanupUnassignedAliveFiles deletes only unassigned keep-alive files", () => {
    const cwd = createTestCwd();
    const unassigned = lobby.spawnLobbyWorker(cwd)!;
    const assigned = lobby.spawnLobbyWorker(cwd)!;
    assigned.assignedTaskId = "task-assigned";

    expect(fs.existsSync(unassigned.aliveFile!)).toBe(true);
    expect(fs.existsSync(assigned.aliveFile!)).toBe(true);

    lobby.cleanupUnassignedAliveFiles(cwd);

    expect(fs.existsSync(unassigned.aliveFile!)).toBe(false);
    expect(fs.existsSync(assigned.aliveFile!)).toBe(true);
  });

  it("shutdownLobbyWorkers sweeps stale keep-alive files", () => {
    const cwd = createTestCwd();
    const staleAlive = path.join(cwd, ".pi", "messenger", "crew", "lobby-stale.alive");
    fs.writeFileSync(staleAlive, "", { mode: 0o600 });
    expect(fs.existsSync(staleAlive)).toBe(true);

    lobby.shutdownLobbyWorkers(cwd);

    expect(fs.existsSync(staleAlive)).toBe(false);
  });

  it("builds chatty lobby prompt with PRD path", async () => {
    const { spawn } = await import("node:child_process");
    lobby.spawnLobbyWorker("/test/cwd");

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.length).toBe(1);
    const promptArg = calls[0][1]![calls[0][1]!.length - 1] as string;
    expect(promptArg).toContain("Crew Lobby");
    expect(promptArg).toContain("docs/PRD.md");
    expect(promptArg).toContain("Share Your Findings");
    expect(promptArg).toContain("Introduce yourself");
    expect(promptArg).toContain("at most 5 messages");
    expect(promptArg).toContain("TASK ASSIGNMENT");
  });

  it("close handler resets orphaned in_progress task to todo", async () => {
    const storeModule = await import("../../crew/store.js");
    const feedModule = await import("../../feed.js");

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-1";

    vi.mocked(storeModule.getTask).mockReturnValue({
      id: "task-1", title: "Test", status: "in_progress", attempt_count: 1,
      depends_on: [], description: "", created_at: "", milestone: false,
      assigned_to: worker.name,
    } as any);

    const proc = worker.proc as any;
    const closeHandler = proc._handlers["close"];
    expect(closeHandler).toBeDefined();

    closeHandler(1);

    expect(storeModule.updateTask).toHaveBeenCalledWith("/test/cwd", "task-1", {
      status: "todo",
      assigned_to: undefined,
    });
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-1", "system",
      expect.stringContaining("reset to todo"),
    );
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      "/test/cwd", worker.name, "task.reset", "task-1", "worker exited",
    );
  });

  it("close handler blocks task when max attempts exceeded", async () => {
    const storeModule = await import("../../crew/store.js");
    const configModule = await import("../../crew/utils/config.js");
    vi.mocked(configModule.loadCrewConfig).mockReturnValue({
      concurrency: { workers: 4 },
      models: {},
      artifacts: { enabled: false },
      work: { maxAttemptsPerTask: 3 },
      coordination: "chatty",
    } as any);

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-2";

    vi.mocked(storeModule.getTask).mockReturnValue({
      id: "task-2", title: "Flaky", status: "in_progress", attempt_count: 3,
      depends_on: [], description: "", created_at: "", milestone: false,
      assigned_to: worker.name,
    } as any);

    const proc = worker.proc as any;
    proc._handlers["close"](1);

    expect(storeModule.updateTask).toHaveBeenCalledWith("/test/cwd", "task-2", {
      status: "blocked",
      blocked_reason: expect.stringContaining("Max attempts"),
      assigned_to: undefined,
    });
  });

  it("close handler skips recovery if task already completed", async () => {
    const storeModule = await import("../../crew/store.js");
    vi.mocked(storeModule.getTask).mockReturnValue({
      id: "task-3", title: "Done", status: "done", attempt_count: 1,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-3";

    const proc = worker.proc as any;
    proc._handlers["close"](0);

    expect(storeModule.updateTask).not.toHaveBeenCalledWith(
      "/test/cwd", "task-3", expect.objectContaining({ status: "todo" }),
    );
  });

  it("close handler skips reset if task reassigned to another worker", async () => {
    const storeModule = await import("../../crew/store.js");

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-4";

    vi.mocked(storeModule.getTask).mockReturnValue({
      id: "task-4", title: "Reassigned", status: "in_progress", attempt_count: 2,
      depends_on: [], description: "", created_at: "", milestone: false,
      assigned_to: "SomeOtherWorker",
    } as any);

    const proc = worker.proc as any;
    proc._handlers["close"](0);

    expect(storeModule.updateTask).not.toHaveBeenCalledWith(
      "/test/cwd", "task-4", expect.objectContaining({ status: "todo" }),
    );
    expect(storeModule.updateTask).not.toHaveBeenCalledWith(
      "/test/cwd", "task-4", expect.objectContaining({ status: "blocked" }),
    );
  });

  it("exports token budgets that scale with coordination level", () => {
    const budgets = lobby.LOBBY_TOKEN_BUDGETS;
    expect(budgets.none).toBeLessThan(budgets.minimal);
    expect(budgets.minimal).toBeLessThan(budgets.moderate);
    expect(budgets.moderate).toBeLessThan(budgets.chatty);
  });

  it("spawnWorkerForTask spawns and immediately assigns", async () => {
    const storeModule = await import("../../crew/store.js");
    const feedModule = await import("../../feed.js");
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-5", title: "Build something", status: "todo", attempt_count: 0,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const worker = lobby.spawnWorkerForTask("/test/cwd", "task-5", "# Task prompt");

    expect(worker).not.toBeNull();
    expect(worker!.assignedTaskId).toBe("task-5");
    expect(storeModule.updateTask).toHaveBeenCalledWith("/test/cwd", "task-5", expect.objectContaining({
      status: "in_progress",
      assigned_to: worker!.name,
      attempt_count: 1,
    }));
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-5", "system",
      expect.stringContaining("Assigned to worker"),
    );
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      "/test/cwd", worker!.name, "task.start", "task-5", "Build something",
    );
  });

  it("spawnWorkerForTask returns null if task already claimed", async () => {
    const storeModule = await import("../../crew/store.js");
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-6", title: "Claimed", status: "in_progress", attempt_count: 1,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const worker = lobby.spawnWorkerForTask("/test/cwd", "task-6", "# prompt");
    expect(worker).toBeNull();
  });

  it("builds minimal lobby prompt without chat instructions", async () => {
    const config = await import("../../crew/utils/config.js");
    vi.mocked(config.loadCrewConfig).mockReturnValue({
      concurrency: { workers: 4 },
      models: {},
      artifacts: { enabled: false },
      work: {},
      coordination: "minimal",
    });

    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();

    lobby.spawnLobbyWorker("/test/cwd");

    const calls = vi.mocked(spawn).mock.calls;
    const promptArg = calls[0][1]![calls[0][1]!.length - 1] as string;
    expect(promptArg).toContain("Standing by for task assignment");
    expect(promptArg).not.toContain("Chat With Your Team");
  });
});
