# Task Namespace Investigation

## Summary

**CRITICAL BUG FOUND**: `executeTaskAction` does NOT accept namespace, and handlers in `task.ts` do NOT pass namespace to it. This breaks multi-crew isolation.

## 1. `allocateTaskId` in `crew/id-allocator.ts`

**Does NOT take namespace parameter.**

```typescript
export function allocateTaskId(cwd: string): string {
  const tasksDir = path.join(cwd, ".pi", "messenger", "crew", "tasks");
  // Scans for task-N.json files, returns task-{maxN+1}
}
```

**Is this a problem?**

Not necessarily. The design allows:
- Task IDs are globally sequential: `task-1`, `task-2`, `task-3`, etc.
- Each task has a `namespace` field
- As long as filtering by namespace happens consistently, global IDs are fine

**BUT**: This only works if all task lookups filter by namespace.

---

## 2. `executeTaskAction` in `crew/task-actions.ts`

**DOES NOT accept namespace parameter:**

```typescript
export function executeTaskAction(
  cwd: string,
  action: TaskAction,
  taskId: string,
  agentName: string,
  reason?: string,
  options?: TaskActionOptions,
): TaskActionResult
```

**Inside the function:**

```typescript
const task = store.getTask(cwd, taskId);  // ❌ NO NAMESPACE FILTER
```

All task lookups call `store.getTask(cwd, taskId)` without namespace.

---

## 3. Handlers in `crew/handlers/task.ts`

**Handlers correctly resolve namespace:**

```typescript
const crewNamespace = resolveCrewNamespace(params);
```

**BUT: They do NOT pass namespace to `executeTaskAction`:**

### taskStart (line ~290)
```typescript
function taskStart(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const id = params.id;
  const agentName = state.agentName || "unknown";
  const actionResult = executeTaskAction(cwd, "start", id, agentName);  // ❌ NO NAMESPACE
}
```

### taskBlock (line ~406)
```typescript
function taskBlock(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const actionResult = executeTaskAction(cwd, "block", id, state.agentName || "unknown", params.reason);  // ❌ NO NAMESPACE
}
```

### taskUnblock (line ~431)
```typescript
function taskUnblock(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const actionResult = executeTaskAction(cwd, "unblock", id, state.agentName || "unknown");  // ❌ NO NAMESPACE
}
```

### taskReset (line ~484)
```typescript
function taskReset(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const cascade = params.cascade ?? false;
  const action = cascade ? "cascade-reset" : "reset";
  const actionResult = executeTaskAction(cwd, action, id, state.agentName || "unknown");  // ❌ NO NAMESPACE
}
```

**Notice:** All handlers receive `_namespace` (underscore prefix = unused parameter) but don't pass it to `executeTaskAction`.

---

## 4. The Bug

### Scenario:
- Crew "alpha" creates task-1
- Crew "beta" creates task-1
- Both tasks exist as separate files with different namespaces

### What happens when beta tries to start task-1:
1. `taskStart` resolves namespace = "beta"
2. Calls `executeTaskAction(cwd, "start", "task-1", "worker-beta")`
3. Inside `executeTaskAction`: `store.getTask(cwd, "task-1")` **WITHOUT namespace**
4. `store.getTask` might return the WRONG task (e.g., from "alpha" instead of "beta")

### Result:
**Multi-crew isolation is broken.**

---

## 5. The Fix

### Required changes:

1. **`crew/task-actions.ts`**: Add namespace parameter to `executeTaskAction`:
   ```typescript
   export function executeTaskAction(
     cwd: string,
     action: TaskAction,
     taskId: string,
     agentName: string,
     namespace: string,  // ← ADD THIS
     reason?: string,
     options?: TaskActionOptions,
   ): TaskActionResult
   ```

2. **Inside `executeTaskAction`**: Pass namespace to all `store.getTask()` calls:
   ```typescript
   const task = store.getTask(cwd, taskId, namespace);
   ```

3. **`crew/handlers/task.ts`**: Update all call sites:
   ```typescript
   // taskStart
   const actionResult = executeTaskAction(cwd, "start", id, agentName, namespace);
   
   // taskBlock
   const actionResult = executeTaskAction(cwd, "block", id, agentName, namespace, params.reason);
   
   // taskUnblock
   const actionResult = executeTaskAction(cwd, "unblock", id, agentName, namespace);
   
   // taskReset
   const actionResult = executeTaskAction(cwd, action, id, agentName, namespace);
   ```

4. **Note**: The function signature changes because namespace comes before optional parameters.
   New signature:
   ```typescript
   executeTaskAction(cwd, action, taskId, agentName, namespace, reason?, options?)
   ```

---

## 6. Additional Checks Needed

After fixing `executeTaskAction`, verify these store functions also accept namespace:
- `store.startTask(cwd, taskId, agentName)` → needs namespace
- `store.blockTask(cwd, taskId, reason)` → needs namespace
- `store.unblockTask(cwd, taskId)` → needs namespace
- `store.resetTask(cwd, taskId, cascade)` → needs namespace
- `store.deleteTask(cwd, taskId)` → needs namespace

---

## 7. Files to Show

<file_map>
crew/
├── id-allocator.ts        # allocateTaskId - NO namespace (by design, global IDs)
├── task-actions.ts        # executeTaskAction - MISSING namespace parameter ❌
└── handlers/
    └── task.ts            # All handlers - do NOT pass namespace to executeTaskAction ❌
</file_map>

<file_contents>

### crew/task-actions.ts (lines 1-110)

```typescript
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
  const task = store.getTask(cwd, taskId);  // ❌ NO NAMESPACE
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
        const unmetDependencies = task.depends_on.filter(depId => store.getTask(cwd, depId)?.status !== "done");  // ❌ NO NAMESPACE
        if (unmetDependencies.length > 0) {
          return {
            success: false,
            error: "unmet_dependencies",
            message: `Unmet dependencies: ${unmetDependencies.join(", ")}`,
            unmetDependencies,
          };
        }
      }
      const started = store.startTask(cwd, taskId, agentName);  // ❌ NO NAMESPACE
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
      const blocked = store.blockTask(cwd, taskId, reason);  // ❌ NO NAMESPACE
      if (!blocked) return { success: false, error: "block_failed", message: `Failed to block ${taskId}` };
      logFeedEvent(cwd, agentName, "task.block", taskId, reason);
      return { success: true, message: `Blocked ${taskId}`, task: blocked };
    }

    case "unblock": {
      if (task.status !== "blocked") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not blocked` };
      }
      const unblocked = store.unblockTask(cwd, taskId);  // ❌ NO NAMESPACE
      if (!unblocked) return { success: false, error: "unblock_failed", message: `Failed to unblock ${taskId}` };
      logFeedEvent(cwd, agentName, "task.unblock", taskId, unblocked.title);
      return { success: true, message: `Unblocked ${taskId}`, task: unblocked };
    }

    case "reset": {
      const resetTasks = store.resetTask(cwd, taskId, false);  // ❌ NO NAMESPACE
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, task.title);
      return { success: true, message: `Reset ${taskId}`, resetTasks };
    }

    case "cascade-reset": {
      const resetTasks = store.resetTask(cwd, taskId, true);  // ❌ NO NAMESPACE
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, `cascade (${resetTasks.length} tasks)`);
      return { success: true, message: `Reset ${taskId} + ${Math.max(0, resetTasks.length - 1)} dependents`, resetTasks };
    }

    case "delete": {
      if (task.status === "in_progress" && options?.isWorkerActive?.(taskId)) {
        return { success: false, error: "active_worker", message: `Cannot delete ${taskId} while its worker is active` };
      }
      if (!store.deleteTask(cwd, taskId)) return { success: false, error: "delete_failed", message: `Failed to delete ${taskId}` };  // ❌ NO NAMESPACE
      logFeedEvent(cwd, agentName, "task.delete", taskId, task.title);
      return { success: true, message: `Deleted ${taskId}` };
    }

    case "stop": {
      if (task.status !== "in_progress") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not in_progress` };
      }
      if (options?.isWorkerActive?.(taskId)) {
        killWorkerByTask(cwd, taskId);
        store.appendTaskProgress(cwd, taskId, agentName, "Worker stopped by user");  // ❌ NO NAMESPACE
      } else {
        store.appendTaskProgress(cwd, taskId, agentName, "Task unassigned (no active worker)");  // ❌ NO NAMESPACE
      }
      store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });  // ❌ NO NAMESPACE
      logFeedEvent(cwd, agentName, "task.reset", taskId, "stopped");
      return { success: true, message: `Stopped ${taskId}` };
    }
  }
}
```

### crew/handlers/task.ts - Call sites (excerpt)

```typescript
// Line ~290 - taskStart
function taskStart(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.start", { mode: "task.start", error: "missing_id" });
  }

  const agentName = state.agentName || "unknown";
  const actionResult = executeTaskAction(cwd, "start", id, agentName);  // ❌ NO NAMESPACE
  // ...
}

// Line ~406 - taskBlock
function taskBlock(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.block", { mode: "task.block", error: "missing_id" });
  }

  if (!params.reason) {
    return result("Error: reason required for task.block", { mode: "task.block", error: "missing_reason" });
  }

  const actionResult = executeTaskAction(cwd, "block", id, state.agentName || "unknown", params.reason);  // ❌ NO NAMESPACE
  // ...
}

// Line ~431 - taskUnblock
function taskUnblock(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.unblock", { mode: "task.unblock", error: "missing_id" });
  }

  const actionResult = executeTaskAction(cwd, "unblock", id, state.agentName || "unknown");  // ❌ NO NAMESPACE
  // ...
}

// Line ~484 - taskReset
function taskReset(cwd: string, params: CrewParams, state: MessengerState, _namespace: string) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for task.reset", { mode: "task.reset", error: "missing_id" });
  }

  const cascade = params.cascade ?? false;
  const action = cascade ? "cascade-reset" : "reset";
  const actionResult = executeTaskAction(cwd, action, id, state.agentName || "unknown");  // ❌ NO NAMESPACE
  // ...
}
```

</file_contents>

---

## Conclusion

**Does it matter?** YES.

The current design:
- Global sequential task IDs are fine (task-1, task-2, etc.)
- Each task has a `namespace` field for filtering
- **BUT**: `executeTaskAction` doesn't accept or use namespace for lookups
- **Result**: Multi-crew task isolation is completely broken

**The fix is straightforward** but requires:
1. Adding namespace parameter to `executeTaskAction`
2. Threading namespace through all store calls inside `executeTaskAction`
3. Updating all call sites in `task.ts` to pass the resolved namespace
