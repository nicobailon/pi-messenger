import { describe, expect, it } from "vitest";
import { PiAdapter } from "../../crew/utils/adapters/pi.js";
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
// Adapter Factory
// =============================================================================

describe("getAdapter", () => {
  it("returns PiAdapter for 'pi'", () => {
    const adapter = getAdapter("pi");
    expect(adapter.name).toBe("pi");
    expect(adapter.getCommand()).toBe("pi");
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
});
