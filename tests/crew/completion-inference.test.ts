import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getChangedFiles, inferTaskCompletion } from "../../crew/completion-inference.js";
import * as crewStore from "../../crew/store.js";

// =============================================================================
// getChangedFiles
// =============================================================================

describe("getChangedFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-files-test-"));
    // Init a git repo
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "initial.txt"), "initial content");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects committed changes", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "new content");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add file"], { cwd: tmpDir, stdio: "ignore" });

    const files = getChangedFiles(tmpDir, baseCommit);
    expect(files).toContain("new-file.txt");
  });

  it("detects untracked files", () => {
    fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "untracked");
    const files = getChangedFiles(tmpDir);
    expect(files).toContain("untracked.txt");
  });

  it("returns empty for no changes", () => {
    const files = getChangedFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("handles non-git directory gracefully", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    try {
      const files = getChangedFiles(nonGitDir);
      expect(files).toEqual([]);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// inferTaskCompletion — reservedPaths scoping
// =============================================================================

describe("inferTaskCompletion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inference-test-"));
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "initial.txt"), "initial");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" });

    // Create crew store dirs
    const crewDir = path.join(tmpDir, ".pi", "messenger", "crew");
    fs.mkdirSync(crewDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("scopes to reservedPaths when provided", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Create changes in two different paths
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "mine.ts"), "my change");
    fs.writeFileSync(path.join(tmpDir, "other.ts"), "other change");

    // Mock crew store to return a task that's in_progress
    const task = {
      id: "task-1", title: "Test", status: "in_progress" as const,
      base_commit: baseCommit, attempt_count: 1,
    };
    vi.spyOn(crewStore, "getTask").mockReturnValue(task as any);
    vi.spyOn(crewStore, "updateTask").mockImplementation(() => {});
    vi.spyOn(crewStore, "appendTaskProgress").mockImplementation(() => {});

    // With reservedPaths scoping to src/ — should only count src/mine.ts
    const result = inferTaskCompletion({
      cwd: tmpDir,
      taskId: "task-1",
      workerName: "worker-1",
      exitCode: 0,
      baseCommit,
      reservedPaths: ["src/"],
    });

    expect(result).toBe(true);
    // Verify the summary only mentions 1 file (scoped), not 2
    const updateCall = vi.mocked(crewStore.updateTask).mock.calls[0];
    expect(updateCall[2].summary).toContain("1 file(s) changed");
    expect(updateCall[2].summary).toContain("src/mine.ts");
  });

  it("does not false-positive on file-path prefix collisions", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Create a file that looks like a prefix match but isn't the reserved file
    fs.writeFileSync(path.join(tmpDir, "store.ts"), "other worker's change");

    const task = {
      id: "task-1", title: "Test", status: "in_progress" as const,
      base_commit: baseCommit, attempt_count: 1,
    };
    vi.spyOn(crewStore, "getTask").mockReturnValue(task as any);

    // Reserved "store" (a file, no trailing slash) — store.ts should NOT match
    const result = inferTaskCompletion({
      cwd: tmpDir,
      taskId: "task-1",
      workerName: "worker-1",
      exitCode: 0,
      baseCommit,
      reservedPaths: ["store"],
    });

    expect(result).toBe(false);
  });

  it("returns false when no reserved files changed", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    // Create change only in other.ts
    fs.writeFileSync(path.join(tmpDir, "other.ts"), "other change");

    const task = {
      id: "task-1", title: "Test", status: "in_progress" as const,
      base_commit: baseCommit, attempt_count: 1,
    };
    vi.spyOn(crewStore, "getTask").mockReturnValue(task as any);

    // Reserved to src/ but change is in other.ts — should return false
    const result = inferTaskCompletion({
      cwd: tmpDir,
      taskId: "task-1",
      workerName: "worker-1",
      exitCode: 0,
      baseCommit,
      reservedPaths: ["src/"],
    });

    expect(result).toBe(false);
  });

  it("falls back to repo-wide when no reservedPaths (single worker)", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    fs.writeFileSync(path.join(tmpDir, "any-file.ts"), "change");

    const task = {
      id: "task-1", title: "Test", status: "in_progress" as const,
      base_commit: baseCommit, attempt_count: 1,
    };
    vi.spyOn(crewStore, "getTask").mockReturnValue(task as any);
    vi.spyOn(crewStore, "updateTask").mockImplementation(() => {});
    vi.spyOn(crewStore, "appendTaskProgress").mockImplementation(() => {});

    // No reservedPaths, single worker — should use all changed files
    const result = inferTaskCompletion({
      cwd: tmpDir,
      taskId: "task-1",
      workerName: "worker-1",
      exitCode: 0,
      baseCommit,
      activeWorkerCount: 1,
    });

    expect(result).toBe(true);
  });

  it("returns false when no reservedPaths with multiple active workers", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    fs.writeFileSync(path.join(tmpDir, "any-file.ts"), "change");

    const task = {
      id: "task-1", title: "Test", status: "in_progress" as const,
      base_commit: baseCommit, attempt_count: 1,
    };
    vi.spyOn(crewStore, "getTask").mockReturnValue(task as any);

    // No reservedPaths + multiple workers active — should NOT infer completion
    const result = inferTaskCompletion({
      cwd: tmpDir,
      taskId: "task-1",
      workerName: "worker-1",
      exitCode: 0,
      baseCommit,
      activeWorkerCount: 3,
    });

    expect(result).toBe(false);
  });

  it("defaults to single-worker behavior when activeWorkerCount omitted", () => {
    const { execFileSync } = require("node:child_process");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();

    fs.writeFileSync(path.join(tmpDir, "any-file.ts"), "change");

    const task = {
      id: "task-1", title: "Test", status: "in_progress" as const,
      base_commit: baseCommit, attempt_count: 1,
    };
    vi.spyOn(crewStore, "getTask").mockReturnValue(task as any);
    vi.spyOn(crewStore, "updateTask").mockImplementation(() => {});
    vi.spyOn(crewStore, "appendTaskProgress").mockImplementation(() => {});

    // No activeWorkerCount — defaults to 1, should still infer
    const result = inferTaskCompletion({
      cwd: tmpDir,
      taskId: "task-1",
      workerName: "worker-1",
      exitCode: 0,
      baseCommit,
      // activeWorkerCount intentionally omitted
    });

    expect(result).toBe(true);
  });
});
