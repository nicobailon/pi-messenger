/**
 * Crew - Orphan Reconciliation
 *
 * Scans tasks in "in_progress", "starting", or "assigned" status and resets
 * any that have a stale or missing lease (orphaned workers).
 *
 * Called before each work wave to ensure no tasks are stuck in a transient state.
 */

import * as store from "./store.js";
import { readLeases, deleteLease, isLeaseStale, isProcessAlive } from "./leases.js";
import { logFeedEvent } from "../feed.js";

/** Statuses that represent "in-flight" work requiring an active lease. */
const IN_FLIGHT_STATUSES = new Set(["in_progress", "starting", "assigned"]);

export interface ReconcileResult {
  /** Task IDs that were reset to "todo". */
  reset: string[];
  /** Task IDs that were skipped (healthy lease found). */
  skipped: string[];
}

/** Per-(cwd, namespace) in-flight deduplication to prevent concurrent reconciliation. */
const _inFlight = new Map<string, Promise<ReconcileResult>>();

/**
 * Reconcile orphaned tasks.
 *
 * A task is considered orphaned if it is in an in-flight status AND:
 *   - Has no lease record, OR
 *   - Its lease heartbeat is stale (>= HEARTBEAT_TIMEOUT_MS), OR
 *   - Its lease references a PID that is no longer alive.
 *
 * Orphaned tasks are reset to "todo" and their leases are deleted.
 *
 * @param cwd        Working directory (project root).
 * @param namespace  Optional namespace filter; undefined = all namespaces.
 */
export async function reconcileOrphanedTasks(
  cwd: string,
  namespace?: string,
): Promise<ReconcileResult> {
  const key = `${cwd}:${namespace ?? ''}`;
  const existing = _inFlight.get(key);
  if (existing) return existing;

  const promise = _reconcileImpl(cwd, namespace);
  _inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    _inFlight.delete(key);
  }
}

async function _reconcileImpl(cwd: string, namespace?: string): Promise<ReconcileResult> {
  const tasks = store.getTasks(cwd, namespace);
  const leases = readLeases(cwd);
  const reset: string[] = [];
  const skipped: string[] = [];

  for (const task of tasks) {
    if (!IN_FLIGHT_STATUSES.has(task.status)) continue;

    const lease = leases.find(l => l.taskId === task.id);

    const isOrphaned =
      !lease ||
      (lease.pid !== null && !isProcessAlive(lease.pid)) ||
      isLeaseStale(lease);

    if (isOrphaned) {
      const previousStatus = task.status;

      // Reset task to todo
      store.updateTask(cwd, task.id, {
        status: "todo",
        assigned_to: undefined,
        started_at: undefined,
      });

      // Clean up the stale lease
      if (lease) {
        deleteLease(cwd, task.id);
      }

      // Emit a feed event for observability
      logFeedEvent(
        cwd,
        "crew-reconciler",
        "task.reset",
        task.id,
        `Reconciler: orphaned from ${previousStatus} — ${
          lease
            ? `stale heartbeat (${lease.heartbeatAt ?? "never"})`
            : "no lease found"
        }`,
      );

      reset.push(task.id);
    } else {
      skipped.push(task.id);
    }
  }

  return { reset, skipped };
}
