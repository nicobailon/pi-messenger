✅ DONE: Comprehensive analysis of crew namespacing bug written to context.md

## Key Findings

**Root Cause**: Crew namespaces are runtime-only, not persisted to disk. All tasks share:
- Single storage directory: `<cwd>/.pi/messenger/crew/tasks/`
- Global task ID sequence (task-1, task-2, ...)
- No crew field in Task or Plan schemas

**How Task IDs Are Generated**:
1. `allocateTaskId(cwd)` scans ALL `task-*.json` files in shared directory
2. Finds highest number, increments by 1
3. Returns `task-N` with NO crew prefix

**How task.list Works**:
1. `taskList(cwd)` calls `store.getTasks(cwd)`
2. `getTasks()` reads ALL `.json` files from shared tasks directory
3. Returns every task found, sorted by ID number
4. NO filtering by crew namespace

**Why Isolation is Failing**:
- No crew parameter passed to storage functions
- No crew field stored in task objects
- Runtime namespace prefixes (e.g., `beta::task-1`) are stripped before storage
- All crews read from the same directory

**Where to Fix**:
- `crew/types.ts` - Add crew field to Plan and Task
- `crew/store.ts:173-206` - createTask needs crew param
- `crew/store.ts:245-262` - getTasks needs crew filtering
- `crew/id-allocator.ts:14-30` - allocateTaskId needs crew-aware scanning
- `crew/handlers/task.ts:64-107` - taskCreate must extract and pass crew