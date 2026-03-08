/**
 * Crew - Conflict Detector
 *
 * Detects when two agents modify overlapping code regions by analyzing
 * git diffs from each task's base_commit.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface DiffHunk {
  file: string;
  lines: [number, number]; // [start, end]
}

export interface ConflictResult {
  hasConflict: boolean;
  conflictingFiles: string[];
  taskA: string;
  taskB: string;
  overlappingHunks: Array<{
    file: string;
    linesA: [number, number]; // start, end
    linesB: [number, number];
  }>;
}

// =============================================================================
// Git Helpers
// =============================================================================

/**
 * Get files changed by a task (using git diff between two commits).
 */
export function getTaskChangedFiles(cwd: string, baseCommit: string, endCommit: string = "HEAD"): string[] {
  try {
    const output = execSync(`git diff --name-only ${baseCommit}..${endCommit}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Parse diff hunks from git diff output for a specific file.
 * Extracts @@ line ranges from unified diff format.
 */
export function parseDiffHunks(diffOutput: string, file: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  // Match @@ -old_start,old_count +new_start,new_count @@
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;

  while ((match = hunkRegex.exec(diffOutput)) !== null) {
    const start = parseInt(match[1], 10);
    const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const end = start + Math.max(count - 1, 0);
    hunks.push({ file, lines: [start, end] });
  }

  return hunks;
}

/**
 * Get diff hunks for all files changed between two commits.
 */
function getDiffHunks(cwd: string, baseCommit: string, endCommit: string = "HEAD"): DiffHunk[] {
  const files = getTaskChangedFiles(cwd, baseCommit, endCommit);
  const allHunks: DiffHunk[] = [];

  for (const file of files) {
    try {
      const diffOutput = execSync(`git diff ${baseCommit}..${endCommit} -- "${file}"`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
      const hunks = parseDiffHunks(diffOutput, file);
      allHunks.push(...hunks);
    } catch {
      // If diff fails for a file, treat the whole file as changed
      allHunks.push({ file, lines: [1, 999999] });
    }
  }

  return allHunks;
}

/**
 * Check if two line ranges overlap.
 */
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

// =============================================================================
// Task Metadata Helpers
// =============================================================================

interface TaskMeta {
  id: string;
  base_commit?: string;
  head_commit?: string;
}

function loadTaskMeta(cwd: string, taskId: string): TaskMeta | null {
  const taskPath = path.join(cwd, ".pi", "messenger", "crew", "tasks", `${taskId}.json`);
  try {
    const raw = fs.readFileSync(taskPath, "utf-8");
    return JSON.parse(raw) as TaskMeta;
  } catch {
    return null;
  }
}

// =============================================================================
// Conflict Detection
// =============================================================================

/**
 * Detect conflicts between two tasks' changes by comparing their git diffs
 * from their respective base commits.
 */
export function detectConflicts(cwd: string, taskA: string, taskB: string): ConflictResult {
  const noConflict: ConflictResult = {
    hasConflict: false,
    conflictingFiles: [],
    taskA,
    taskB,
    overlappingHunks: [],
  };

  const metaA = loadTaskMeta(cwd, taskA);
  const metaB = loadTaskMeta(cwd, taskB);

  if (!metaA?.base_commit || !metaB?.base_commit) {
    return noConflict;
  }

  // Use head_commit if available, otherwise fall back to HEAD
  const endA = metaA.head_commit ?? "HEAD";
  const endB = metaB.head_commit ?? "HEAD";

  // Get diff hunks for each task
  const hunksA = getDiffHunks(cwd, metaA.base_commit, endA);
  const hunksB = getDiffHunks(cwd, metaB.base_commit, endB);

  if (hunksA.length === 0 || hunksB.length === 0) {
    return noConflict;
  }

  // Find files changed by both tasks
  const filesA = new Set(hunksA.map(h => h.file));
  const filesB = new Set(hunksB.map(h => h.file));
  const sharedFiles = [...filesA].filter(f => filesB.has(f));

  if (sharedFiles.length === 0) {
    return noConflict;
  }

  // Check for overlapping hunks in shared files
  const overlappingHunks: ConflictResult["overlappingHunks"] = [];
  const conflictingFiles = new Set<string>();

  for (const file of sharedFiles) {
    const fileHunksA = hunksA.filter(h => h.file === file);
    const fileHunksB = hunksB.filter(h => h.file === file);

    for (const hA of fileHunksA) {
      for (const hB of fileHunksB) {
        if (rangesOverlap(hA.lines, hB.lines)) {
          conflictingFiles.add(file);
          overlappingHunks.push({
            file,
            linesA: hA.lines,
            linesB: hB.lines,
          });
        }
      }
    }
  }

  return {
    hasConflict: overlappingHunks.length > 0,
    conflictingFiles: [...conflictingFiles],
    taskA,
    taskB,
    overlappingHunks,
  };
}

/**
 * Check all completed tasks in current wave for conflicts.
 * Compares each pair of completed tasks.
 */
export function checkWaveConflicts(cwd: string, completedTaskIds: string[]): ConflictResult[] {
  const results: ConflictResult[] = [];

  for (let i = 0; i < completedTaskIds.length; i++) {
    for (let j = i + 1; j < completedTaskIds.length; j++) {
      results.push(detectConflicts(cwd, completedTaskIds[i], completedTaskIds[j]));
    }
  }

  return results;
}
