/**
 * Crew - Completion Inference
 *
 * Centralized logic to infer whether a worker completed its task,
 * even when the worker didn't explicitly call task.done.
 * Shared by both lobby.ts close handler AND work.ts result processing.
 */

import { execFileSync } from "node:child_process";
import * as store from "./store.js";
import { logFeedEvent } from "../feed.js";
import { pathMatchesReservation } from "../lib.js";

export interface InferenceContext {
  cwd: string;
  taskId: string;
  workerName: string;
  exitCode: number | null;
  baseCommit?: string;
  /** Worker's reserved file paths — when provided, scopes attribution to these paths only */
  reservedPaths?: string[];
  /** Number of currently in_progress tasks. When > 1 and no reservedPaths, inference returns false. */
  activeWorkerCount?: number;
}

/**
 * Try to infer that a task was completed based on exit code and git state.
 *
 * Returns true if the task is confirmed done (either already done or inferred).
 * Returns false if the task is NOT done and should be handled by the caller.
 */
export function inferTaskCompletion(ctx: InferenceContext): boolean {
  const task = store.getTask(ctx.cwd, ctx.taskId);
  if (!task) return false;

  // Already done — nothing to infer
  if (task.status === "done") return true;

  // Already blocked — not our problem
  if (task.status === "blocked") return false;

  // Only infer for exit 0 + in_progress tasks
  if (ctx.exitCode !== 0 || task.status !== "in_progress") return false;

  // Check if there are actual code changes to attribute
  const allChangedFiles = getChangedFiles(ctx.cwd, ctx.baseCommit);

  // Scope to reserved paths when available (concurrency-safe)
  let changedFiles: string[];
  if (ctx.reservedPaths && ctx.reservedPaths.length > 0) {
    changedFiles = allChangedFiles.filter(f =>
      ctx.reservedPaths!.some(rp => pathMatchesReservation(f, rp))
    );
  } else {
    // Multi-worker guard: repo-wide diff is unreliable when multiple workers are active
    // because one worker's commits could be falsely attributed to another's task.
    if ((ctx.activeWorkerCount ?? 1) > 1) {
      logFeedEvent(ctx.cwd, ctx.workerName, "message", ctx.taskId,
        `Skipping inference: no reservedPaths with ${ctx.activeWorkerCount} active workers`);
      return false;
    }
    changedFiles = allChangedFiles;
    if (changedFiles.length > 0) {
      // Warn: repo-wide attribution may include other workers' changes
      logFeedEvent(ctx.cwd, ctx.workerName, "message", ctx.taskId,
        `D'6 inference: repo-wide diff (worker had no file reservations). ` +
        `${changedFiles.length} file(s) may include other workers' changes.`);
    }
  }

  if (changedFiles.length === 0) return false;

  // Infer completion: exit 0 + has code changes + task still in_progress
  const summary = `Inferred complete: ${changedFiles.length} file(s) changed (${changedFiles.slice(0, 3).join(", ")}${changedFiles.length > 3 ? "..." : ""})`;

  store.updateTask(ctx.cwd, ctx.taskId, {
    status: "done",
    completed_at: new Date().toISOString(),
    summary,
  });
  store.appendTaskProgress(ctx.cwd, ctx.taskId, "system",
    `Completion inferred by D'6 lifecycle: worker ${ctx.workerName} exited 0 with changes`);
  logFeedEvent(ctx.cwd, ctx.workerName, "task.done", ctx.taskId, summary);

  return true;
}

/**
 * Get files changed since a base commit (or just working tree changes).
 * Combines committed + working tree + new untracked files.
 */
export function getChangedFiles(cwd: string, baseCommit?: string): string[] {
  const files = new Set<string>();

  try {
    if (baseCommit) {
      // Committed changes since base
      const committed = execFileSync("git", ["diff", "--name-only", baseCommit, "HEAD"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (committed) committed.split("\n").forEach((f) => files.add(f));

      // Working tree changes since base
      const working = execFileSync("git", ["diff", "--name-only", baseCommit], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (working) working.split("\n").forEach((f) => files.add(f));
    } else {
      // No base commit — just HEAD diff
      const headDiff = execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (headDiff) headDiff.split("\n").forEach((f) => files.add(f));
    }

    // Always include untracked files
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (untracked) untracked.split("\n").forEach((f) => files.add(f));
  } catch {
    // Not a git repo or git not available
  }

  return [...files];
}
