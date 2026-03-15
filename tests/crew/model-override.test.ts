import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pushModelArgs, spawnAgents } from "../../crew/agents.js";
import { resolveModel, type ModelResolution } from "../../crew/utils/model.js";
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

function writeCrewConfig(cwd: string, config: Record<string, unknown>): void {
  const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
}

describe("crew/model override", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockProcess(0));
  });

  describe("resolveModel (5-arg with ModelResolution)", () => {
    it("follows task -> param -> role -> default -> agent priority", () => {
      const r1 = resolveModel("task-m", "param-m", "role-m", "default-m", "agent-m");
      expect(r1).toEqual({ model: "task-m", source: "task" });

      const r2 = resolveModel(undefined, "param-m", "role-m", "default-m", "agent-m");
      expect(r2).toEqual({ model: "param-m", source: "param" });

      const r3 = resolveModel(undefined, undefined, "role-m", "default-m", "agent-m");
      expect(r3).toEqual({ model: "role-m", source: "role" });

      const r4 = resolveModel(undefined, undefined, undefined, "default-m", "agent-m");
      expect(r4).toEqual({ model: "default-m", source: "default" });

      const r5 = resolveModel(undefined, undefined, undefined, undefined, "agent-m");
      expect(r5).toEqual({ model: "agent-m", source: "agent" });
    });

    it("returns { model: undefined, source: 'none' } when all inputs are undefined", () => {
      expect(resolveModel(undefined, undefined, undefined, undefined, undefined))
        .toEqual({ model: undefined, source: "none" });
    });

    it("defaultModel fills the gap between role config and agent fallback", () => {
      // No role config, but defaultModel set — should pick defaultModel
      const r = resolveModel(undefined, undefined, undefined, "anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5");
      expect(r).toEqual({ model: "anthropic/claude-opus-4-6", source: "default" });
    });

    it("backward compat: modelOverride maps to taskModel position", () => {
      // Simulates: task.taskModel ?? task.modelOverride as first arg
      const modelOverride = "override-model";
      const r = resolveModel(modelOverride, undefined, "role-m", "default-m", "agent-m");
      expect(r).toEqual({ model: "override-model", source: "task" });
    });
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
    writeCrewConfig(dirs.cwd, { models: { worker: null } });

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

  it("spawnAgents uses defaultModel when no role config exists", async () => {
    writeWorkerAgent(dirs.cwd, "agent-default-model");
    writeCrewConfig(dirs.cwd, { defaultModel: "anthropic/claude-opus-4-6" });

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const args = spawnMock.mock.calls[0][1] as string[];
    // pushModelArgs splits "anthropic/claude-opus-4-6" into --provider + --model
    const providerIdx = args.indexOf("--provider");
    const modelIdx = args.indexOf("--model");
    expect(providerIdx).toBeGreaterThan(-1);
    expect(args[providerIdx + 1]).toBe("anthropic");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("claude-opus-4-6");
  });

  it("spawnAgents uses paramModel when passed on AgentTask", async () => {
    writeWorkerAgent(dirs.cwd, "agent-default-model");

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
      paramModel: "anthropic/claude-sonnet-4-6",
    }], dirs.cwd);

    const args = spawnMock.mock.calls[0][1] as string[];
    // pushModelArgs splits "anthropic/claude-sonnet-4-6" into --provider + --model
    const providerIdx = args.indexOf("--provider");
    const modelIdx = args.indexOf("--model");
    expect(providerIdx).toBeGreaterThan(-1);
    expect(args[providerIdx + 1]).toBe("anthropic");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("claude-sonnet-4-6");
  });

  it("spawnAgents splits provider/model into --provider and --model flags", async () => {
    writeWorkerAgent(dirs.cwd, "zai/glm-5");
    writeCrewConfig(dirs.cwd, { models: { worker: null } });

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const args = spawnMock.mock.calls[0][1] as string[];
    const providerIdx = args.indexOf("--provider");
    const modelIdx = args.indexOf("--model");

    expect(providerIdx).toBeGreaterThan(-1);
    expect(args[providerIdx + 1]).toBe("zai");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("glm-5");
  });

  describe("pushModelArgs", () => {
    it("splits provider/model into separate flags", () => {
      const args: string[] = [];
      pushModelArgs(args, "zai/glm-5");
      expect(args).toEqual(["--provider", "zai", "--model", "glm-5"]);
    });

    it("passes plain model as --model only", () => {
      const args: string[] = [];
      pushModelArgs(args, "claude-sonnet-4");
      expect(args).toEqual(["--model", "claude-sonnet-4"]);
    });

    it("splits on first slash only for openrouter-style IDs", () => {
      const args: string[] = [];
      pushModelArgs(args, "openrouter/anthropic/claude-3-5-sonnet");
      expect(args).toEqual(["--provider", "openrouter", "--model", "anthropic/claude-3-5-sonnet"]);
    });
  });
});
