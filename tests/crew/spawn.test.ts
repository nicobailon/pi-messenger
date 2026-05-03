import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock };
});

const lobbyMock = vi.hoisted(() => {
  let counter = 0;
  return {
    getAvailableLobbyWorkers: vi.fn(() => [] as Array<{ name: string; lobbyId: string }>),
    assignTaskToLobbyWorker: vi.fn(() => true),
    spawnWorkerForTask: vi.fn(() => {
      counter++;
      return { name: `SpawnedWorker${counter}`, lobbyId: `lobby-${counter}` };
    }),
    _reset: () => { counter = 0; },
  };
});

vi.mock("../../crew/lobby.js", () => ({
  getAvailableLobbyWorkers: lobbyMock.getAvailableLobbyWorkers,
  assignTaskToLobbyWorker: lobbyMock.assignTaskToLobbyWorker,
  spawnWorkerForTask: lobbyMock.spawnWorkerForTask,
}));

vi.mock("../../crew/utils/discover.js", () => ({
  discoverCrewSkills: vi.fn(() => []),
}));

vi.mock("../../feed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../feed.js")>();
  return { ...actual, logFeedEvent: vi.fn() };
});

function writeProjectConfig(crewDir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(crewDir, { recursive: true });
  fs.writeFileSync(path.join(crewDir, "config.json"), JSON.stringify(config, null, 2));
}

describe("spawnWorkersForReadyTasks concurrency cap", () => {
  let dirs: TempCrewDirs;
  let spawn: typeof import("../../crew/spawn.js");
  let store: typeof import("../../crew/store.js");

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    lobbyMock._reset();
    lobbyMock.getAvailableLobbyWorkers.mockReturnValue([]);

    vi.resetModules();
    store = await import("../../crew/store.js");
    spawn = await import("../../crew/spawn.js");

    store.createPlan(dirs.cwd, "docs/PRD.md", "Test Plan");
    for (let i = 0; i < 5; i++) {
      store.createTask(dirs.cwd, `Task ${i + 1}`);
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("respects config.concurrency.max when caller requests more workers", () => {
    writeProjectConfig(dirs.crewDir, { concurrency: { workers: 1, max: 1 } });

    const result = spawn.spawnWorkersForReadyTasks(dirs.cwd, 5);

    expect(result.assigned).toBe(1);
    expect(lobbyMock.spawnWorkerForTask).toHaveBeenCalledTimes(1);
  });

  it("uses the caller limit when it is lower than config.concurrency.max", () => {
    writeProjectConfig(dirs.crewDir, { concurrency: { workers: 2, max: 10 } });

    const result = spawn.spawnWorkersForReadyTasks(dirs.cwd, 2);

    expect(result.assigned).toBe(2);
    expect(lobbyMock.spawnWorkerForTask).toHaveBeenCalledTimes(2);
  });

  it("caps lobby assignments by config.concurrency.max", () => {
    writeProjectConfig(dirs.crewDir, { concurrency: { workers: 1, max: 1 } });

    lobbyMock.getAvailableLobbyWorkers.mockReturnValue([
      { name: "Lobby1", lobbyId: "lb-1" } as any,
      { name: "Lobby2", lobbyId: "lb-2" } as any,
      { name: "Lobby3", lobbyId: "lb-3" } as any,
    ]);

    const result = spawn.spawnWorkersForReadyTasks(dirs.cwd, 5);

    expect(result.assigned).toBe(1);
    expect(lobbyMock.assignTaskToLobbyWorker).toHaveBeenCalledTimes(1);
    expect(lobbyMock.spawnWorkerForTask).not.toHaveBeenCalled();
  });
});
