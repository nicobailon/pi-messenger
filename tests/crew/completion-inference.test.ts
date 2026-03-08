import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getChangedFiles } from "../../crew/completion-inference.js";

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
