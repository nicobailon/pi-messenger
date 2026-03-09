/**
 * Stuck Detection Timer — shared utility for monitoring worker output activity.
 *
 * Used by both lobby.ts (pre-claimed workers) and agents.ts (directly spawned workers)
 * to detect and report when a worker goes silent for too long.
 */

import * as store from "../store.js";
import { logFeedEvent } from "../../feed.js";

export interface StuckTimerConfig {
  /** Timeout in ms before a worker is considered stuck. 0 disables. */
  stuckTimeoutMs: number;
  /** Working directory for store/feed operations */
  cwd: string;
  /** Worker name for feed events */
  workerName: string;
  /** Task ID for progress/feed attribution. Use a getter for lobby workers whose task assignment changes after timer creation. */
  taskId: string | (() => string);
}

export interface StuckTimer {
  /** Call when the worker produces output to reset the timer */
  onOutput(): void;
  /** Call when the worker process exits to clean up */
  clear(): void;
}

/**
 * Create a stuck detection timer that fires a warning when a worker
 * produces no output for `stuckTimeoutMs` milliseconds.
 *
 * Returns a no-op timer if stuckTimeoutMs <= 0.
 */
export function createStuckTimer(config: StuckTimerConfig): StuckTimer {
  if (config.stuckTimeoutMs <= 0) {
    return { onOutput() {}, clear() {} };
  }

  let lastOutputTimestamp = Date.now();
  let stuckWarned = false;

  const interval = setInterval(() => {
    const silentMs = Date.now() - lastOutputTimestamp;
    if (silentMs >= config.stuckTimeoutMs && !stuckWarned) {
      stuckWarned = true;
      const resolvedTaskId = typeof config.taskId === "function" ? config.taskId() : config.taskId;
      if (resolvedTaskId) {
        store.appendTaskProgress(config.cwd, resolvedTaskId, "system",
          `Worker appears stuck (no output for ${Math.round(silentMs / 1000)}s)`);
      }
      logFeedEvent(config.cwd, config.workerName, "stuck", resolvedTaskId, "No output detected");
    }
  }, Math.min(config.stuckTimeoutMs, 60_000));

  return {
    onOutput() {
      lastOutputTimestamp = Date.now();
      stuckWarned = false;
    },
    clear() {
      clearInterval(interval);
    },
  };
}
