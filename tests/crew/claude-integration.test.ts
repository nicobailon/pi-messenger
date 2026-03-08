/**
 * Integration tests for Claude Code adapter, pre-registration, and completion inference.
 * V3.15 + V4.8 of spec 002-multi-runtime-support.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { buildRuntimeSpawn } from "../../crew/runtime-spawn.js";
import { registerSpawnedWorker, getMessengerRegistryDir } from "../../store.js";
import { getChangedFiles, inferTaskCompletion } from "../../crew/completion-inference.js";

describe("Claude Code spawn integration", () => {
  it("builds correct Claude Code args with model and system prompt", () => {
    const result = buildRuntimeSpawn(
      "claude",
      {
        prompt: "Implement the auth module",
        systemPrompt: "You are a careful developer",
      },
      {
        model: "anthropic/claude-sonnet-4-20250514",
        extensionDir: "/some/ext",
      },
      { HOME: "/home/test", PI_CREW_WORKER: "1", PI_AGENT_NAME: "TestBot" },
      { skipCommandCheck: true },
    );

    expect(result.command).toBe("claude");
    expect(result.args).toContain("--print");
    expect(result.args).toContain("--output-format");
    expect(result.args).toContain("stream-json");
    expect(result.args).toContain("--verbose");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("claude-sonnet-4-20250514");
    expect(result.args).toContain("--system-prompt");
    expect(result.args).toContain("You are a careful developer");
    expect(result.args).toContain("-p");
    expect(result.args).toContain("Implement the auth module");

    // Must NOT contain pi-specific flags
    expect(result.args).not.toContain("--mode");
    expect(result.args).not.toContain("json");
    expect(result.args).not.toContain("--no-session");
    expect(result.args).not.toContain("--extension");

    // Env should be passed through
    expect(result.env).toHaveProperty("PI_CREW_WORKER", "1");
    expect(result.env).toHaveProperty("PI_AGENT_NAME", "TestBot");
  });

  it("generates correct warnings for Claude unsupported features", () => {
    const result = buildRuntimeSpawn(
      "claude",
      { prompt: "hello" },
      {
        model: "claude-sonnet-4-20250514",
        thinking: "high",
        tools: ["read", "bash"],
        extensionDir: "/ext",
      },
      {},
      { skipCommandCheck: true },
    );

    expect(result.warnings).toHaveLength(3);
    expect(result.warnings).toContain("claude: thinking flag not supported, skipping");
    expect(result.warnings).toContain("claude: tool restriction not supported, skipping");
    expect(result.warnings).toContain("claude: extension loading not supported, custom tools unavailable");
  });
});

describe("Spawner pre-registration integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preregistration-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates registration in correct dir with correct schema", () => {
    registerSpawnedWorker(tmpDir, "/project/cwd", "ClaudeWorker", 42, "claude-sonnet-4-20250514", "crew-abc");

    const regPath = path.join(tmpDir, "ClaudeWorker.json");
    expect(fs.existsSync(regPath)).toBe(true);

    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    expect(reg).toMatchObject({
      name: "ClaudeWorker",
      pid: 42,
      sessionId: "crew-abc",
      cwd: "/project/cwd",
      model: "claude-sonnet-4-20250514",
      isHuman: false,
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
    });
    expect(reg.startedAt).toBeDefined();
    expect(reg.activity.lastActivityAt).toBeDefined();
  });

  it("getMessengerRegistryDir matches index.ts derivation", () => {
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

describe("Completion inference integration (V4.8)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inference-test-"));
    // Init a git repo with initial commit
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "content");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getChangedFiles detects committed + untracked together", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Add committed change
    fs.writeFileSync(path.join(tmpDir, "committed.txt"), "new");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add"], { cwd: tmpDir, stdio: "ignore" });

    // Add untracked file
    fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "untracked");

    const files = getChangedFiles(tmpDir, baseCommit);
    expect(files).toContain("committed.txt");
    expect(files).toContain("untracked.txt");
  });

  it("getChangedFiles with working tree modifications", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Modify existing file but don't commit
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "modified content");

    const files = getChangedFiles(tmpDir, baseCommit);
    expect(files).toContain("existing.txt");
  });
});
