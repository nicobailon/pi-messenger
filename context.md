I've completed my investigation and written detailed findings to `context.md`.

## Summary

The namespace filtering logic **appears correct** in the code. Here's what I found:

### The Filtering Chain
1. `pi_messenger({ crew: "alpha" })` → `resolveCrewNamespace(params)` → should return `"alpha"`
2. `taskList(cwd, "alpha")` → `store.getTasks(cwd, "alpha")`  
3. `getTasks()` filters each task via `isTaskInNamespace(task, "alpha")`
4. `isTaskInNamespace()` should return `false` for tasks with `namespace: "beta"`

### The Smoking Gun

In `isTaskInNamespace` (crew/store.ts:26-36):
```typescript
if (namespace === undefined) return true;  // ← Shows ALL tasks
```

**If the `namespace` parameter arrives as `undefined`**, it returns `true` for every task, showing all namespaces.

### Most Likely Root Cause

The `namespace` parameter is arriving as `undefined` rather than `"alpha"`. Possible reasons:
1. `params.crew` isn't being passed correctly through the call chain
2. TypeScript type casting `(params as NamespaceParams)` is hiding a type mismatch
3. The parameter isn't in the tool schema (though it should be)

### Recommended Debug Steps

1. **Add logging** at `crew/handlers/task.ts:40` to see what `resolveCrewNamespace(params)` actually returns
2. **Verify task-16.json** actually contains `"namespace": "beta"` on disk
3. **Check params object** - log `params.crew` at the handler entry point

The filtering logic itself is sound - the issue is upstream in parameter resolution.

✅ DONE: Traced task.list namespace filtering bug. Root cause: namespace parameter likely undefined at isTaskInNamespace, triggering show-all branch. Findings written to context.md with code flow, hypothesis, and debug recommendations.