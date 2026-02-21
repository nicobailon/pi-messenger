import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModel, spawnAgents } from "../../crew/agents.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type MockProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProcess(exitCode: number): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => true);

  queueMicrotask(() => {
    proc.exitCode = exitCode;
    proc.emit("exit", exitCode);
    proc.emit("close", exitCode);
  });

  return proc;
}

function writeWorkerAgent(cwd: string, model?: string): void {
  const modelLine = model ? `model: ${model}\n` : "";
  const content = `---
name: crew-worker
description: Test worker
crewRole: worker
${modelLine}---
You are a test worker.
`;

  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("crew/model override", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockProcess(0));
  });

  it("resolveModel follows task -> params -> config -> agent priority", () => {
    expect(resolveModel("task-model", "param-model", "config-model", "agent-model")).toBe("task-model");
    expect(resolveModel(undefined, "param-model", "config-model", "agent-model")).toBe("param-model");
    expect(resolveModel(undefined, undefined, "config-model", "agent-model")).toBe("config-model");
    expect(resolveModel(undefined, undefined, undefined, "agent-model")).toBe("agent-model");
  });

  it("resolveModel returns undefined when all inputs are undefined", () => {
    expect(resolveModel(undefined, undefined, undefined, undefined)).toBeUndefined();
  });

  it("spawnAgents passes resolved model override in spawn args", async () => {
    writeWorkerAgent(dirs.cwd, "agent-default-model");

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
      modelOverride: "wave-override-model",
    }], dirs.cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    const modelFlagIndex = args.indexOf("--model");

    expect(modelFlagIndex).toBeGreaterThan(-1);
    expect(args[modelFlagIndex + 1]).toBe("wave-override-model");
  });

  it("spawnAgents falls back to agent model when no override is provided", async () => {
    writeWorkerAgent(dirs.cwd, "agent-default-model");

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const args = spawnMock.mock.calls[0][1] as string[];
    const modelFlagIndex = args.indexOf("--model");

    expect(modelFlagIndex).toBeGreaterThan(-1);
    expect(args[modelFlagIndex + 1]).toBe("agent-default-model");
  });
});
