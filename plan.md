# Auto-Review in Work Handler — Implementation Plan

## Overview

Add automatic reviewer passes after each worker completes a task in the work handler. When a task gets a `NEEDS_WORK` verdict, it's reset to `todo` for retry with the review feedback injected into the worker's next prompt (this plumbing already exists via `task.last_review` → `buildWorkerPrompt`).

## Design Principles

- **Minimal footprint**: Reuse the existing `reviewImplementation()` from `review.ts` rather than duplicating logic
- **Respect existing config**: `config.review.enabled` + `config.review.maxIterations` already exist and control behavior
- **Fit the autonomous loop naturally**: Review happens between worker completion and wave result reporting, so tasks that need rework become ready in the next wave
- **No new config keys needed**: Everything we need is already in `CrewConfig`

## Architecture

```
Worker completes task (status: "done")
  → if review.enabled && reviewer agent exists && task.review_count < maxIterations
    → spawn reviewer with git diff context
    → parse verdict
    → SHIP: task stays "done" ✅
    → NEEDS_WORK: reset to "todo", store feedback in last_review, increment review_count
    → MAJOR_RETHINK: block task with review context
  → otherwise: task stays "done" (no review)
```

The review-then-retry loop happens **across waves** in autonomous mode, not within a single wave. This is cleaner — the next wave picks up reset tasks naturally via `getReadyTasks()`.

## Files to Modify

### 1. `crew/types.ts` — Add `review_count` field
- Add `review_count?: number` to the `Task` interface
- This tracks how many times a task has been reviewed (separate from `attempt_count` which tracks worker attempts)

### 2. `crew/handlers/review.ts` — Export `reviewImplementation`
- Change `reviewImplementation` from a private function to a named export
- No logic changes — just make it reusable from the work handler

### 3. `crew/handlers/work.ts` — Add auto-review after worker completion
This is the core change. After the worker results processing loop (lines 175-221) builds the `succeeded` array:

**a)** Import `reviewImplementation` from `review.ts`, `parseVerdict` from verdict utils, and `discoverCrewAgents` for reviewer detection.

**b)** After the results processing loop, add a new review phase:

```typescript
// Auto-review succeeded tasks
if (config.review.enabled && succeeded.length > 0) {
  const hasReviewer = discoverCrewAgents(cwd).some(a => a.name === "crew-reviewer");
  if (hasReviewer) {
    const reviewable = succeeded.filter(taskId => {
      const task = store.getTask(cwd, taskId);
      return task && (task.review_count ?? 0) < config.review.maxIterations;
    });

    // Spawn reviewers in parallel for all reviewable tasks
    if (reviewable.length > 0) {
      const reviewTasks = reviewable.map(taskId => {
        const task = store.getTask(cwd, taskId)!;
        // Build review prompt (same as review.ts reviewImplementation)
        return {
          agent: "crew-reviewer",
          task: buildReviewPrompt(task, cwd),
          taskId,
          modelOverride: config.models?.reviewer,
        };
      });

      const reviewResults = await spawnAgents(reviewTasks, cwd, { signal, ... });

      for (const rr of reviewResults) {
        const taskId = rr.taskId;
        if (!taskId) continue;

        if (rr.exitCode !== 0) {
          // Reviewer crashed — task stays done, log it
          store.appendTaskProgress(cwd, taskId, "system", "Auto-review failed, task stays done");
          continue;
        }

        const verdict = parseVerdict(rr.output);
        const task = store.getTask(cwd, taskId)!;
        const reviewCount = (task.review_count ?? 0) + 1;

        // Store review feedback
        store.updateTask(cwd, taskId, {
          last_review: {
            verdict: verdict.verdict,
            summary: verdict.summary,
            issues: verdict.issues,
            suggestions: verdict.suggestions,
            reviewed_at: new Date().toISOString(),
          },
          review_count: reviewCount,
        });
        store.appendTaskProgress(cwd, taskId, "system",
          `Auto-review #${reviewCount}: ${verdict.verdict} — ${verdict.summary.split("\n")[0].slice(0, 120)}`);

        if (verdict.verdict === "SHIP") {
          // Task stays done — already in succeeded array
        } else if (verdict.verdict === "NEEDS_WORK") {
          // Reset to todo for retry in next wave
          store.updateTask(cwd, taskId, {
            status: "todo",
            completed_at: undefined,
            assigned_to: undefined,
          });
          // Move from succeeded to failed so wave result is accurate
          succeeded.splice(succeeded.indexOf(taskId), 1);
          failed.push(taskId);
          logFeedEvent(cwd, "crew-reviewer", "task.needs_work", taskId, verdict.summary.split("\n")[0]);
        } else {
          // MAJOR_RETHINK — block the task
          store.blockTask(cwd, taskId, `Reviewer: ${verdict.summary.split("\n")[0]}`);
          succeeded.splice(succeeded.indexOf(taskId), 1);
          blocked.push(taskId);
          logFeedEvent(cwd, "crew-reviewer", "task.major_rethink", taskId, verdict.summary.split("\n")[0]);
        }
      }
    }
  }
}
```

**c)** Extract the review prompt building into a local helper `buildReviewPrompt(task, cwd)` that mirrors the prompt in `review.ts:reviewImplementation` — gets git diff, commit log, task spec, and assembles the review prompt. This avoids coupling tightly to the review handler's internal function signature.

### 4. `crew/store.ts` — No changes needed
- `updateTask` already accepts partial updates, so `review_count` will be stored naturally once added to the `Task` type

### 5. `crew/prompt.ts` — No changes needed
- Already handles `task.last_review` in worker prompts (lines 44-57)
- When a NEEDS_WORK task gets retried, the worker automatically sees the review feedback

## What We're NOT Doing (and why)

1. **Not adding a review-within-wave retry loop**: The worker gets re-assigned in the next wave via the existing autonomous loop. Keeps the wave boundary clean and avoids complex nested async loops.

2. **Not modifying the review handler**: We build the review prompt inline in `work.ts` rather than calling `reviewImplementation()` directly, because `reviewImplementation` returns a formatted result string meant for the user — we need raw verdict data. However, we do export it for potential future use.

3. **Not adding new config keys**: `review.enabled` and `review.maxIterations` already exist and are sufficient. The `review_count` on the task tracks iteration progress.

4. **Not reviewing lobby-assigned tasks**: Lobby workers complete asynchronously and their results arrive via a different path. Auto-review for lobby workers would be a separate follow-up.

## Testing Strategy

- Unit test: Mock `spawnAgents` to return reviewer output with each verdict type, verify task state transitions
- Integration test: Run a small plan with auto-review enabled, verify the NEEDS_WORK → retry → SHIP flow across waves
- Config test: Verify `review.enabled: false` skips review entirely
- Edge cases: reviewer crash, maxIterations exceeded, all tasks SHIP on first pass

## Summary of Changes

| File | Change | Lines |
|------|--------|-------|
| `crew/types.ts` | Add `review_count?: number` to `Task` | ~1 line |
| `crew/handlers/review.ts` | Export `reviewImplementation` | ~1 line |
| `crew/handlers/work.ts` | Add auto-review phase after worker results | ~60 lines |
| Total | | ~62 lines |
