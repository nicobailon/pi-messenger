import { logFeedEvent } from "../feed.js";
import * as store from "./store.js";
import { loadCrewConfig } from "./utils/config.js";
import { killWorkerByTask } from "./registry.js";
import type { Task } from "./types.js";

export type TaskAction = "start" | "block" | "unblock" | "reset" | "cascade-reset" | "delete" | "stop";

export interface TaskActionOptions {
  isWorkerActive?: (taskId: string) => boolean;
}

export interface TaskActionResult {
  success: boolean;
  message: string;
  error?: string;
  task?: Task;
  resetTasks?: Task[];
  unmetDependencies?: string[];
}

export function executeTaskAction(
  cwd: string,
  action: TaskAction,
  taskId: string,
  agentName: string,
  reason?: string,
  options?: TaskActionOptions,
): TaskActionResult {
  const task = store.getTask(cwd, taskId);
  if (!task) return { success: false, error: "not_found", message: `Task ${taskId} not found` };

  switch (action) {
    case "start": {
      if (task.milestone) {
        return { success: false, error: "milestone_not_startable", message: `Task ${taskId} is a milestone and cannot be started manually` };
      }
      if (task.status === "in_progress" && task.assigned_to === agentName) {
        return { success: true, message: `Already started ${taskId}`, task };
      }
      if (task.status !== "todo") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not todo` };
      }
      const config = loadCrewConfig(store.getCrewDir(cwd));
      if (config.dependencies !== "advisory") {
        const unmetDependencies = task.depends_on.filter(depId => store.getTask(cwd, depId)?.status !== "done");
        if (unmetDependencies.length > 0) {
          return {
            success: false,
            error: "unmet_dependencies",
            message: `Unmet dependencies: ${unmetDependencies.join(", ")}`,
            unmetDependencies,
          };
        }
      }
      const started = store.startTask(cwd, taskId, agentName);
      if (!started) return { success: false, error: "start_failed", message: `Failed to start ${taskId}` };
      logFeedEvent(cwd, agentName, "task.start", taskId, started.title);
      return { success: true, message: `Started ${taskId}`, task: started };
    }

    case "block": {
      if (task.status !== "in_progress") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} must be in_progress to block` };
      }
      if (!reason) {
        return { success: false, error: "missing_reason", message: `Reason required to block ${taskId}` };
      }
      const blocked = store.blockTask(cwd, taskId, reason);
      if (!blocked) return { success: false, error: "block_failed", message: `Failed to block ${taskId}` };
      logFeedEvent(cwd, agentName, "task.block", taskId, reason);
      return { success: true, message: `Blocked ${taskId}`, task: blocked };
    }

    case "unblock": {
      if (task.status !== "blocked") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not blocked` };
      }
      const unblocked = store.unblockTask(cwd, taskId);
      if (!unblocked) return { success: false, error: "unblock_failed", message: `Failed to unblock ${taskId}` };
      logFeedEvent(cwd, agentName, "task.unblock", taskId, unblocked.title);
      return { success: true, message: `Unblocked ${taskId}`, task: unblocked };
    }

    case "reset": {
      const resetTasks = store.resetTask(cwd, taskId, false);
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, task.title);
      return { success: true, message: `Reset ${taskId}`, resetTasks };
    }

    case "cascade-reset": {
      const resetTasks = store.resetTask(cwd, taskId, true);
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, `cascade (${resetTasks.length} tasks)`);
      return { success: true, message: `Reset ${taskId} + ${Math.max(0, resetTasks.length - 1)} dependents`, resetTasks };
    }

    case "delete": {
      if (task.status === "in_progress" && options?.isWorkerActive?.(taskId)) {
        return { success: false, error: "active_worker", message: `Cannot delete ${taskId} while its worker is active` };
      }
      if (!store.deleteTask(cwd, taskId)) return { success: false, error: "delete_failed", message: `Failed to delete ${taskId}` };
      logFeedEvent(cwd, agentName, "task.delete", taskId, task.title);
      return { success: true, message: `Deleted ${taskId}` };
    }

    case "stop": {
      if (task.status !== "in_progress") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not in_progress` };
      }
      if (options?.isWorkerActive?.(taskId)) {
        killWorkerByTask(cwd, taskId);
        store.appendTaskProgress(cwd, taskId, agentName, "Worker stopped by user");
      } else {
        store.appendTaskProgress(cwd, taskId, agentName, "Task unassigned (no active worker)");
      }
      store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
      logFeedEvent(cwd, agentName, "task.reset", taskId, "stopped");
      return { success: true, message: `Stopped ${taskId}` };
    }
  }
}
