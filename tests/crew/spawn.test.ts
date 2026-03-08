import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../crew/reconcile.js", () => ({
  reconcileOrphans: vi.fn(),
}));

vi.mock("../../crew/store.js", () => ({
  getPlan: vi.fn(() => ({ prd: "docs/PRD.md", task_count: 1, completed_count: 0, created_at: "", updated_at: "" })),
  getCrewDir: vi.fn(() => "/test/cwd/.pi/messenger/crew"),
  getPlanLabel: vi.fn(() => "plan"),
  updateTask: vi.fn(),
  appendTaskProgress: vi.fn(),
  getBaseCommit: vi.fn(() => undefined),
  getReadyTasks: vi.fn(() => []),
  getTasks: vi.fn(() => []),
  getTask: vi.fn(),
}));

vi.mock("../../crew/prompt.js", () => ({
  buildWorkerPrompt: vi.fn(() => "prompt"),
}));

vi.mock("../../crew/utils/config.js", () => ({
  loadCrewConfig: vi.fn(() => ({
    concurrency: { workers: 4 },
    dependencies: "strict",
    work: {},
    models: {},
  })),
}));

vi.mock("../../crew/utils/discover.js", () => ({
  discoverCrewSkills: vi.fn(() => []),
}));

vi.mock("../../crew/lobby.js", () => ({
  getAvailableLobbyWorkers: vi.fn(() => []),
  spawnWorkerForTask: vi.fn(() => ({ name: "worker-1" })),
  assignTaskToLobbyWorker: vi.fn(),
}));

vi.mock("../../feed.js", () => ({
  logFeedEvent: vi.fn(),
}));

import { spawnSingleWorker, spawnWorkersForReadyTasks } from "../../crew/spawn.js";
import { getPlan, getCrewDir, getReadyTasks, getTask, updateTask, getBaseCommit, appendTaskProgress } from "../../crew/store.js";
import { reconcileOrphans } from "../../crew/reconcile.js";

describe("crew.spawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reconciles orphans before selecting ready tasks in spawnWorkersForReadyTasks", () => {
    vi.mocked(getReadyTasks).mockReturnValue([
      {
        id: "task-1",
        title: "Task One",
        status: "todo",
        depends_on: [],
        created_at: "",
        updated_at: "",
        attempt_count: 0,
      } as any,
    ]);

    vi.mocked(getPlan).mockReturnValue({
      prd: "docs/PRD.md",
      task_count: 1,
      completed_count: 0,
      created_at: "",
      updated_at: "",
    } as any);

    vi.mocked(getCrewDir).mockReturnValue("/test/cwd/.pi/messenger/crew");

    const result = spawnWorkersForReadyTasks("/test/cwd", 1);

    expect(reconcileOrphans).toHaveBeenCalledWith("/test/cwd", { heartbeatTimeoutMs: 30_000, maxRetries: 3 });
    expect(result.assigned).toBe(1);
  });

  it("reconciles orphans before spawning a single task", async () => {
    vi.mocked(getPlan).mockReturnValue({
      prd: "docs/PRD.md",
      task_count: 1,
      completed_count: 0,
      created_at: "",
      updated_at: "",
    } as any);
    vi.mocked(getCrewDir).mockReturnValue("/test/cwd/.pi/messenger/crew");
    vi.mocked(getTask).mockReturnValue({
      id: "task-2",
      title: "Task Two",
      status: "todo",
      depends_on: [],
      created_at: "",
      updated_at: "",
      attempt_count: 0,
    } as any);
    vi.mocked(getBaseCommit).mockReturnValue("abc123");
    vi.mocked(getReadyTasks).mockReturnValue([
      {
        id: "task-2",
        title: "Task Two",
        status: "todo",
        depends_on: [],
        created_at: "",
        updated_at: "",
        attempt_count: 0,
      } as any,
    ]);

    const result = spawnSingleWorker("/test/cwd", "task-2");

    expect(reconcileOrphans).toHaveBeenCalledWith("/test/cwd", { heartbeatTimeoutMs: 30_000, maxRetries: 3 });
    expect(result).toEqual({ name: "worker-1" });
  });
});
