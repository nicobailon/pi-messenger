/**
 * Crew - Orphan Reconciler
 *
 * Detects tasks stuck in active states (assigned / starting / in_progress)
 * that have exceeded the heartbeat timeout, then either resets them to "todo"
 * for retry or marks them "blocked" when maxRetries is exhausted.
 *
 * Called at the top of the work handler before selecting ready tasks.
 */

import { getTasks, updateTask } from "./store.js";

// =============================================================================
// Types
// =============================================================================

export interface ReconcileOptions {
  /** Milliseconds a task may stay in an active state without progress. Default: 30_000 */
  heartbeatTimeoutMs?: number;
  /** Maximum attempts before a task is permanently blocked. Default: 3 */
  maxRetries?: number;
}

export interface ReconcileResult {
  /** Task IDs that were reset to "todo" for retry */
  reset: string[];
  /** Task IDs that were either fresh, or blocked due to exhausted retries */
  skipped: string[];
}

// =============================================================================
// Implementation
// =============================================================================

const ACTIVE_STATUSES = new Set(["assigned", "starting", "in_progress"]);

/**
 * Scan all tasks and reset/block any orphans whose heartbeat has expired.
 *
 * Staleness is measured from `updated_at` — every state transition sets this
 * field, so it reflects when the task last changed state (e.g. became
 * "assigned" or "in_progress").
 */
export function reconcileOrphans(
  cwd: string,
  options: ReconcileOptions = {}
): ReconcileResult {
  const { heartbeatTimeoutMs = 30_000, maxRetries = 3 } = options;
  const tasks = getTasks(cwd);
  const reset: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  for (const task of tasks) {
    // Only check tasks that should have active workers
    if (!ACTIVE_STATUSES.has(task.status)) continue;

    const lastUpdated = task.updated_at ? new Date(task.updated_at).getTime() : 0;
    const staleSince = now - lastUpdated;

    if (staleSince <= heartbeatTimeoutMs) {
      // Task is fresh — leave it alone
      skipped.push(task.id);
      continue;
    }

    // Task is stale — decide whether to retry or permanently block
    const nextAttempt = (task.attempt_count ?? 0) + 1;
    if (nextAttempt > maxRetries) {
      // Exhausted retries — mark blocked
      updateTask(cwd, task.id, {
        status: "blocked",
        blocked_reason: `Heartbeat timeout after ${task.attempt_count} attempts`,
        assigned_to: undefined,
      });
      skipped.push(task.id);
    } else {
      // Reset for retry
      updateTask(cwd, task.id, {
        status: "todo",
        attempt_count: nextAttempt,
        assigned_to: undefined,
        started_at: undefined,
      });
      reset.push(task.id);
    }
  }

  return { reset, skipped };
}
