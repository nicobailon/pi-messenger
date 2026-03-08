import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  detectConflicts,
  checkWaveConflicts,
  getTaskChangedFiles,
  parseDiffHunks,
  type ConflictResult,
} from "../../crew/conflict-detector.js";
import { execSync } from "node:child_process";

let testDir: string;

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function setupGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-test-"));
  git("init", dir);
  git("config user.email 'test@test.com'", dir);
  git("config user.name 'Test'", dir);

  // Create initial files and commit
  fs.writeFileSync(path.join(dir, "fileA.ts"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
  fs.writeFileSync(path.join(dir, "fileB.ts"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
  git("add -A", dir);
  git("commit -m 'initial'", dir);

  return dir;
}

function setupCrewTaskMetadata(dir: string, taskId: string, baseCommit: string, headCommit?: string): void {
  const tasksDir = path.join(dir, ".pi", "messenger", "crew", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, `${taskId}.json`),
    JSON.stringify({
      id: taskId,
      title: `Task ${taskId}`,
      status: "done",
      depends_on: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      base_commit: baseCommit,
      attempt_count: 1,
    })
  );
}

beforeEach(() => {
  testDir = setupGitRepo();
});

afterEach(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("crew/conflict-detector", () => {
  describe("getTaskChangedFiles", () => {
    it("returns files changed since base commit", () => {
      const baseCommit = git("rev-parse HEAD", testDir);

      // Make changes
      fs.writeFileSync(path.join(testDir, "fileA.ts"), "CHANGED\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      git("add -A", testDir);
      git("commit -m 'change fileA'", testDir);

      const files = getTaskChangedFiles(testDir, baseCommit);
      expect(files).toEqual(["fileA.ts"]);
    });

    it("returns empty array when no changes", () => {
      const baseCommit = git("rev-parse HEAD", testDir);
      const files = getTaskChangedFiles(testDir, baseCommit);
      expect(files).toEqual([]);
    });
  });

  describe("parseDiffHunks", () => {
    it("parses hunk ranges from git diff output", () => {
      const diffOutput = `diff --git a/fileA.ts b/fileA.ts
index abc..def 100644
--- a/fileA.ts
+++ b/fileA.ts
@@ -1,3 +1,3 @@
-line1
+CHANGED
 line2
 line3`;

      const hunks = parseDiffHunks(diffOutput, "fileA.ts");
      expect(hunks.length).toBeGreaterThan(0);
      expect(hunks[0].file).toBe("fileA.ts");
      // Hunk starts at line 1 with 3 lines context
      expect(hunks[0].lines[0]).toBe(1);
      expect(hunks[0].lines[1]).toBe(3);
    });
  });

  describe("detectConflicts", () => {
    it("returns no conflict when tasks touch different files", () => {
      const baseCommit = git("rev-parse HEAD", testDir);

      // Simulate task-1 changing fileA
      fs.writeFileSync(path.join(testDir, "fileA.ts"), "CHANGED\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      git("add -A", testDir);
      git("commit -m 'task-1 changes fileA'", testDir);
      const commitA = git("rev-parse HEAD", testDir);

      // Simulate task-2 changing fileB
      fs.writeFileSync(path.join(testDir, "fileB.ts"), "ALPHA\nbeta\ngamma\ndelta\nepsilon\n");
      git("add -A", testDir);
      git("commit -m 'task-2 changes fileB'", testDir);
      const commitB = git("rev-parse HEAD", testDir);

      // Set up task metadata
      setupCrewTaskMetadata(testDir, "task-1", baseCommit);
      setupCrewTaskMetadata(testDir, "task-2", baseCommit);

      const result = detectConflicts(testDir, "task-1", "task-2");
      expect(result.hasConflict).toBe(false);
      expect(result.conflictingFiles).toEqual([]);
      expect(result.overlappingHunks).toEqual([]);
    });

    it("detects conflict when tasks touch same file with overlapping hunks", () => {
      const baseCommit = git("rev-parse HEAD", testDir);

      // Both tasks modify the same lines in fileA
      // We simulate this by having both base_commits point to the initial commit
      // and then making both changes in sequence
      fs.writeFileSync(path.join(testDir, "fileA.ts"), "CHANGED_BY_A\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      git("add -A", testDir);
      git("commit -m 'task-1 changes fileA line 1'", testDir);

      fs.writeFileSync(path.join(testDir, "fileA.ts"), "CHANGED_BY_A\nCHANGED_BY_B\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      git("add -A", testDir);
      git("commit -m 'task-2 changes fileA line 2'", testDir);

      // Both tasks have the same base commit (the initial one)
      setupCrewTaskMetadata(testDir, "task-1", baseCommit);
      setupCrewTaskMetadata(testDir, "task-2", baseCommit);

      const result = detectConflicts(testDir, "task-1", "task-2");
      expect(result.hasConflict).toBe(true);
      expect(result.conflictingFiles).toContain("fileA.ts");
      expect(result.overlappingHunks.length).toBeGreaterThan(0);
    });
  });

  describe("checkWaveConflicts", () => {
    it("checks all pairs of completed tasks for conflicts", () => {
      const baseCommit = git("rev-parse HEAD", testDir);

      // task-1 changes fileA
      fs.writeFileSync(path.join(testDir, "fileA.ts"), "CHANGED_BY_1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      git("add -A", testDir);
      git("commit -m 'task-1'", testDir);

      // task-2 changes fileB (no conflict with task-1)
      fs.writeFileSync(path.join(testDir, "fileB.ts"), "CHANGED_BY_2\nbeta\ngamma\ndelta\nepsilon\n");
      git("add -A", testDir);
      git("commit -m 'task-2'", testDir);

      // task-3 changes fileA (conflict with task-1)
      fs.writeFileSync(path.join(testDir, "fileA.ts"), "CHANGED_BY_1\nCHANGED_BY_3\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      git("add -A", testDir);
      git("commit -m 'task-3'", testDir);

      setupCrewTaskMetadata(testDir, "task-1", baseCommit);
      setupCrewTaskMetadata(testDir, "task-2", baseCommit);
      setupCrewTaskMetadata(testDir, "task-3", baseCommit);

      const results = checkWaveConflicts(testDir, ["task-1", "task-2", "task-3"]);
      // Should find conflict between task-1 and task-3
      const conflicting = results.filter(r => r.hasConflict);
      expect(conflicting.length).toBeGreaterThan(0);
      
      const t1t3 = conflicting.find(r =>
        (r.taskA === "task-1" && r.taskB === "task-3") ||
        (r.taskA === "task-3" && r.taskB === "task-1")
      );
      expect(t1t3).toBeDefined();
      expect(t1t3!.conflictingFiles).toContain("fileA.ts");

      // task-1 and task-2 should NOT conflict
      const t1t2 = results.find(r =>
        (r.taskA === "task-1" && r.taskB === "task-2") ||
        (r.taskA === "task-2" && r.taskB === "task-1")
      );
      expect(t1t2).toBeDefined();
      expect(t1t2!.hasConflict).toBe(false);
    });
  });
});
