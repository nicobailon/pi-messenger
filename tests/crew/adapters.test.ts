import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PiAdapter } from "../../crew/utils/adapters/pi.js";
import { ClaudeAdapter } from "../../crew/utils/adapters/claude.js";
import { getAdapter, resolveRuntime } from "../../crew/utils/adapters/index.js";
import { buildRuntimeSpawn, RUNTIME_ALLOWLIST } from "../../crew/runtime-spawn.js";
import type { SpawnTask, AdapterConfig, ProgressEvent } from "../../crew/utils/adapters/types.js";
import type { CrewConfig } from "../../crew/utils/config.js";

// =============================================================================
// PiAdapter.buildArgs
// =============================================================================

describe("PiAdapter.buildArgs", () => {
  const adapter = new PiAdapter();

  it("builds minimal args for a simple prompt", () => {
    const task: SpawnTask = { prompt: "Fix the bug" };
    const config: AdapterConfig = { extensionDir: "/ext/dir" };
    const args = adapter.buildArgs(task, config);

    expect(args).toEqual([
      "--mode", "json",
      "--no-session", "-p",
      "--extension", "/ext/dir",
      "Fix the bug",
    ]);
  });

  it("includes model with provider prefix", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { model: "anthropic/claude-sonnet-4-20250514", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--provider");
    expect(args).toContain("anthropic");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-20250514");
  });

  it("includes model without provider prefix", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { model: "claude-sonnet-4-20250514", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-20250514");
    expect(args).not.toContain("--provider");
  });

  it("includes thinking flag", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { thinking: "high", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--thinking");
    expect(args).toContain("high");
  });

  it("skips thinking when model has thinking suffix", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { model: "claude-sonnet-4-20250514:high", thinking: "high", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).not.toContain("--thinking");
  });

  it("separates builtin tools and extension paths", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = {
      tools: ["read", "bash", "/path/to/custom.ts"],
      extensionDir: "/ext",
    };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--tools");
    const toolsIdx = args.indexOf("--tools");
    expect(args[toolsIdx + 1]).toBe("read,bash");

    const extIdxs = args.reduce<number[]>((acc, v, i) => {
      if (v === "--extension") acc.push(i);
      return acc;
    }, []);
    // Custom extension + the main extension dir
    expect(extIdxs.length).toBe(2);
  });

  it("appends system prompt path when provided", () => {
    const task: SpawnTask = { prompt: "hello", systemPromptPath: "/tmp/prompt.md" };
    const config: AdapterConfig = { extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("/tmp/prompt.md");
  });

  it("prompt is always the last argument", () => {
    const task: SpawnTask = { prompt: "Fix the bug" };
    const config: AdapterConfig = { model: "gpt-4o", thinking: "high", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args[args.length - 1]).toBe("Fix the bug");
  });
});

// =============================================================================
// PiAdapter.parseProgressEvent
// =============================================================================

describe("PiAdapter.parseProgressEvent", () => {
  const adapter = new PiAdapter();

  it("parses tool_execution_start as tool_call", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "ls" },
    });
    const event = adapter.parseProgressEvent(line);
    expect(event).toEqual({
      type: "tool_call",
      toolName: "bash",
      args: { command: "ls" },
    });
  });

  it("parses tool_execution_end as tool_result", () => {
    const line = JSON.stringify({ type: "tool_result" });
    const event = adapter.parseProgressEvent(line);
    expect(event).toEqual({ type: "tool_result" });
  });

  it("parses message_end with usage as message", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 100, output: 50 },
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Done!" }],
      },
    });
    const event = adapter.parseProgressEvent(line);
    expect(event).toMatchObject({
      type: "message",
      tokens: { input: 100, output: 50 },
      model: "claude-sonnet-4-20250514",
      content: "Done!",
    });
  });

  it("parses error message", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", errorMessage: "Rate limited" },
    });
    const event = adapter.parseProgressEvent(line);
    expect(event).toEqual({ type: "error", errorMessage: "Rate limited" });
  });

  it("returns null for empty lines", () => {
    expect(adapter.parseProgressEvent("")).toBeNull();
    expect(adapter.parseProgressEvent("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(adapter.parseProgressEvent("not json")).toBeNull();
  });
});

// =============================================================================
// PiAdapter.supportsFeature
// =============================================================================

describe("PiAdapter.supportsFeature", () => {
  const adapter = new PiAdapter();

  it("supports all features", () => {
    expect(adapter.supportsFeature("streaming")).toBe(true);
    expect(adapter.supportsFeature("thinking")).toBe(true);
    expect(adapter.supportsFeature("tool-restriction")).toBe(true);
    expect(adapter.supportsFeature("extension-loading")).toBe(true);
    expect(adapter.supportsFeature("system-prompt-file")).toBe(true);
    expect(adapter.supportsFeature("system-prompt-inline")).toBe(true);
  });
});

// =============================================================================
// ClaudeAdapter.buildArgs
// =============================================================================

describe("ClaudeAdapter.buildArgs", () => {
  const adapter = new ClaudeAdapter();

  it("builds minimal args for a simple prompt", () => {
    const task: SpawnTask = { prompt: "Fix the bug" };
    const config: AdapterConfig = { extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toEqual([
      "--print", "--output-format", "stream-json", "--verbose",
      "-p", "Fix the bug",
    ]);
  });

  it("strips provider prefix from model", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { model: "anthropic/claude-sonnet-4-20250514", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-20250514");
    expect(args).not.toContain("anthropic/claude-sonnet-4-20250514");
  });

  it("passes model without prefix as-is", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { model: "claude-sonnet-4-20250514", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("claude-sonnet-4-20250514");
  });

  it("includes inline system prompt", () => {
    const task: SpawnTask = { prompt: "hello", systemPrompt: "You are a helpful assistant" };
    const config: AdapterConfig = { extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).toContain("--system-prompt");
    expect(args).toContain("You are a helpful assistant");
  });

  it("does not include --thinking or --tools or --extension", () => {
    const task: SpawnTask = { prompt: "hello" };
    const config: AdapterConfig = { thinking: "high", tools: ["read"], extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);

    expect(args).not.toContain("--thinking");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--extension");
  });

  it("prompt is last after -p", () => {
    const task: SpawnTask = { prompt: "Fix it" };
    const config: AdapterConfig = { model: "claude-sonnet-4-20250514", extensionDir: "/ext" };
    const args = adapter.buildArgs(task, config);
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toBe("Fix it");
    expect(pIdx + 1).toBe(args.length - 1);
  });
});

// =============================================================================
// ClaudeAdapter.parseProgressEvent
// =============================================================================

describe("ClaudeAdapter.parseProgressEvent", () => {
  const adapter = new ClaudeAdapter();

  it("returns null for system events", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    expect(adapter.parseProgressEvent(line)).toBeNull();
  });

  it("returns null for user events", () => {
    const line = JSON.stringify({ type: "user" });
    expect(adapter.parseProgressEvent(line)).toBeNull();
  });

  it("parses assistant tool_use as tool_call", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const event = adapter.parseProgressEvent(line);
    expect(event).toEqual({
      type: "tool_call",
      toolName: "Bash",
      args: { command: "ls" },
    });
  });

  it("parses assistant text as message with tokens", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Done!" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const event = adapter.parseProgressEvent(line);
    expect(event).toMatchObject({
      type: "message",
      tokens: { input: 100, output: 50 },
      model: "claude-sonnet-4-20250514",
      content: "Done!",
    });
  });

  it("parses error result", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "API rate limit exceeded",
    });
    const event = adapter.parseProgressEvent(line);
    expect(event).toEqual({ type: "error", errorMessage: "API rate limit exceeded" });
  });

  it("returns null for successful result", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    expect(adapter.parseProgressEvent(line)).toBeNull();
  });
});

// =============================================================================
// ClaudeAdapter.supportsFeature
// =============================================================================

describe("ClaudeAdapter.supportsFeature", () => {
  const adapter = new ClaudeAdapter();

  it("supports streaming and inline system prompt", () => {
    expect(adapter.supportsFeature("streaming")).toBe(true);
    expect(adapter.supportsFeature("system-prompt-inline")).toBe(true);
  });

  it("does not support thinking, tool-restriction, extension-loading, system-prompt-file", () => {
    expect(adapter.supportsFeature("thinking")).toBe(false);
    expect(adapter.supportsFeature("tool-restriction")).toBe(false);
    expect(adapter.supportsFeature("extension-loading")).toBe(false);
    expect(adapter.supportsFeature("system-prompt-file")).toBe(false);
  });
});

// =============================================================================
// Adapter Factory
// =============================================================================

describe("getAdapter", () => {
  it("returns PiAdapter for 'pi'", () => {
    const adapter = getAdapter("pi");
    expect(adapter.name).toBe("pi");
    expect(adapter.getCommand()).toBe("pi");
  });

  it("returns ClaudeAdapter for 'claude'", () => {
    const adapter = getAdapter("claude");
    expect(adapter.name).toBe("claude");
    expect(adapter.getCommand()).toBe("claude");
  });

  it("throws for unknown runtime", () => {
    expect(() => getAdapter("unknown")).toThrow(/Unknown runtime/);
  });
});

describe("resolveRuntime", () => {
  const baseConfig = {
    concurrency: { workers: 2, max: 10 },
    truncation: {
      planners: { bytes: 204800, lines: 5000 },
      workers: { bytes: 204800, lines: 5000 },
      reviewers: { bytes: 102400, lines: 2000 },
      analysts: { bytes: 102400, lines: 2000 },
    },
    artifacts: { enabled: true, cleanupDays: 7 },
    memory: { enabled: false },
    planSync: { enabled: false },
    review: { enabled: true, maxIterations: 3 },
    planning: { maxPasses: 1 },
    work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false },
    dependencies: "advisory" as const,
    coordination: "chatty" as const,
    messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
  } satisfies CrewConfig;

  it("defaults to 'pi' when no runtime config", () => {
    expect(resolveRuntime(baseConfig, "worker")).toBe("pi");
  });

  it("returns configured runtime for role", () => {
    const config = { ...baseConfig, runtime: { worker: "claude" } };
    expect(resolveRuntime(config, "worker")).toBe("claude");
  });

  it("defaults to 'pi' for unconfigured role", () => {
    const config = { ...baseConfig, runtime: { worker: "claude" } };
    expect(resolveRuntime(config, "planner")).toBe("pi");
  });
});

// =============================================================================
// buildRuntimeSpawn
// =============================================================================

describe("buildRuntimeSpawn", () => {
  it("throws for unknown runtime", () => {
    expect(() =>
      buildRuntimeSpawn("unknown", { prompt: "hi" }, { extensionDir: "/ext" }, {}),
    ).toThrow(/Unknown runtime/);
  });

  it("returns correct structure for pi runtime", () => {
    const result = buildRuntimeSpawn(
      "pi",
      { prompt: "Fix it" },
      { extensionDir: "/ext" },
      { HOME: "/home/user" },
    );

    expect(result.command).toBe("pi");
    expect(result.adapter.name).toBe("pi");
    expect(result.args).toContain("Fix it");
    expect(result.args).toContain("--mode");
    expect(result.env).toHaveProperty("HOME", "/home/user");
    expect(result.warnings).toEqual([]);
  });

  it("pi generates no warnings for supported features", () => {
    const result = buildRuntimeSpawn(
      "pi",
      { prompt: "hello" },
      { thinking: "high", tools: ["read"], extensionDir: "/ext" },
      {},
    );
    expect(result.warnings).toEqual([]);
  });

  it("claude generates warnings for unsupported features", () => {
    const result = buildRuntimeSpawn(
      "claude",
      { prompt: "hello" },
      { thinking: "high", tools: ["read"], extensionDir: "/ext" },
      {},
      { skipCommandCheck: true },
    );
    expect(result.command).toBe("claude");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes("thinking"))).toBe(true);
    expect(result.warnings.some(w => w.includes("tool restriction"))).toBe(true);
    expect(result.warnings.some(w => w.includes("extension"))).toBe(true);
  });

  it("claude always warns about extension loading (extensionDir is always passed)", () => {
    const result = buildRuntimeSpawn(
      "claude",
      { prompt: "hello" },
      { extensionDir: "/ext" },
      {},
      { skipCommandCheck: true },
    );
    expect(result.warnings).toEqual([
      "claude: extension loading not supported, custom tools unavailable",
    ]);
  });
});

// =============================================================================
// buildCliInstructions
// =============================================================================

import { buildCliInstructions } from "../../crew/prompt.js";

describe("buildCliInstructions", () => {
  it("returns null for pi runtime", () => {
    expect(buildCliInstructions("pi", "pre-claimed")).toBeNull();
  });

  it("returns null when runtime is undefined", () => {
    expect(buildCliInstructions(undefined, "pre-claimed")).toBeNull();
  });

  it("includes pre-claimed instruction for claude", () => {
    const result = buildCliInstructions("claude", "pre-claimed");
    expect(result).toContain("do NOT call task.start");
    expect(result).toContain("pi-messenger-cli");
  });

  it("includes unclaimed instruction", () => {
    const result = buildCliInstructions("claude", "unclaimed");
    expect(result).toContain("must start the task first");
    expect(result).toContain("task.start");
  });

  it("always includes task.done instructions", () => {
    const result = buildCliInstructions("claude", "pre-claimed");
    expect(result).toContain("task.done");
    expect(result).toContain("summary");
  });
});

// =============================================================================
// registerSpawnedWorker + getMessengerRegistryDir
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSpawnedWorker, getMessengerRegistryDir } from "../../store.js";

describe("registerSpawnedWorker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "register-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a valid registration file", () => {
    registerSpawnedWorker(tmpDir, "/project", "TestBot", 12345, "claude-sonnet-4-20250514", "crew-abc123");

    const regPath = path.join(tmpDir, "TestBot.json");
    expect(fs.existsSync(regPath)).toBe(true);

    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    expect(reg.name).toBe("TestBot");
    expect(reg.pid).toBe(12345);
    expect(reg.sessionId).toBe("crew-abc123");
    expect(reg.cwd).toBe("/project");
    expect(reg.model).toBe("claude-sonnet-4-20250514");
    expect(reg.isHuman).toBe(false);
    expect(reg.session).toEqual({ toolCalls: 0, tokens: 0, filesModified: [] });
    expect(reg.activity.lastActivityAt).toBeDefined();
  });

  it("uses atomic write (no partial reads)", () => {
    registerSpawnedWorker(tmpDir, "/project", "AtomicBot", 99, "model", "sess");

    // .tmp file should not exist after completion
    const tmpFile = path.join(tmpDir, ".AtomicBot.tmp");
    expect(fs.existsSync(tmpFile)).toBe(false);

    // Final file should exist
    const finalFile = path.join(tmpDir, "AtomicBot.json");
    expect(fs.existsSync(finalFile)).toBe(true);
  });
});

describe("getMessengerRegistryDir", () => {
  it("uses PI_MESSENGER_DIR when set", () => {
    const original = process.env.PI_MESSENGER_DIR;
    process.env.PI_MESSENGER_DIR = "/custom/messenger";
    try {
      const dir = getMessengerRegistryDir();
      expect(dir).toBe(path.join("/custom/messenger", "registry"));
    } finally {
      if (original) process.env.PI_MESSENGER_DIR = original;
      else delete process.env.PI_MESSENGER_DIR;
    }
  });

  it("defaults to ~/.pi/agent/messenger/registry", () => {
    const original = process.env.PI_MESSENGER_DIR;
    delete process.env.PI_MESSENGER_DIR;
    try {
      const dir = getMessengerRegistryDir();
      expect(dir).toBe(path.join(os.homedir(), ".pi", "agent", "messenger", "registry"));
    } finally {
      if (original) process.env.PI_MESSENGER_DIR = original;
    }
  });
});
