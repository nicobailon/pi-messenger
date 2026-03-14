import { describe, expect, it } from "vitest";
import {
  extractFilePathsFromSpec,
  buildFileClaims,
  detectFileOverlaps,
  serializeOverlappingTasks,
  buildFileReservationContext,
  type TaskFileClaim,
} from "../../crew/utils/file-overlap.js";
import type { Task } from "../../crew/types.js";

// =============================================================================
// Helpers
// =============================================================================

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    depends_on: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attempt_count: 0,
  };
}

// =============================================================================
// extractFilePathsFromSpec
// =============================================================================

describe("extractFilePathsFromSpec", () => {
  it("extracts backtick-quoted paths", () => {
    const spec = "Modify `src/auth.ts` to add auth handling and update `tests/auth.test.ts`";
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("tests/auth.test.ts");
  });

  it("extracts plain path tokens with slashes", () => {
    const spec = "Create crew/utils/file-overlap.ts with overlap detection logic";
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).toContain("crew/utils/file-overlap.ts");
  });

  it("extracts double-quoted paths", () => {
    const spec = `Edit the file "src/store.ts" to add the new field`;
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).toContain("src/store.ts");
  });

  it("extracts paths in various formats from a realistic spec", () => {
    const spec = `
## Task
Implement file overlap detection.

Files to modify:
- \`crew/handlers/work.ts\` — add serialization logic
- \`crew/prompt.ts\` — add RESERVED FILES section

Create new files:
- crew/utils/file-overlap.ts
`;
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).toContain("crew/handlers/work.ts");
    expect(paths).toContain("crew/prompt.ts");
    expect(paths).toContain("crew/utils/file-overlap.ts");
  });

  it("does NOT extract bare filenames without directory segments", () => {
    const spec = "Modify handler.ts to fix the bug";
    const paths = extractFilePathsFromSpec(spec);
    // No slash → should not be extracted (avoids false positives)
    expect(paths).not.toContain("handler.ts");
  });

  it("does NOT extract non-source extensions", () => {
    const spec = "See docs/design.pdf for details about src/auth.ts";
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).not.toContain("docs/design.pdf");
    expect(paths).toContain("src/auth.ts");
  });

  it("returns empty array for empty spec", () => {
    expect(extractFilePathsFromSpec("")).toEqual([]);
    expect(extractFilePathsFromSpec("No file paths here.")).toEqual([]);
  });

  it("deduplicates paths mentioned multiple times", () => {
    const spec = "Modify `src/auth.ts` then update src/auth.ts again";
    const paths = extractFilePathsFromSpec(spec);
    const count = paths.filter(p => p === "src/auth.ts").length;
    expect(count).toBe(1);
  });

  it("strips leading ./ from paths", () => {
    const spec = "Edit `./src/auth.ts`";
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("./src/auth.ts");
  });

  it("handles nested directory paths", () => {
    const spec = "Update `crew/handlers/work.ts` and `crew/utils/config.ts`";
    const paths = extractFilePathsFromSpec(spec);
    expect(paths).toContain("crew/handlers/work.ts");
    expect(paths).toContain("crew/utils/config.ts");
  });
});

// =============================================================================
// detectFileOverlaps
// =============================================================================

describe("detectFileOverlaps", () => {
  it("returns empty map when no overlaps", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts"] },
      { taskId: "task-2", files: ["src/store.ts"] },
    ];
    const result = detectFileOverlaps(claims);
    expect(result.size).toBe(0);
  });

  it("detects overlap between two tasks sharing a file", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts", "src/types.ts"] },
      { taskId: "task-2", files: ["src/auth.ts", "src/store.ts"] },
    ];
    const result = detectFileOverlaps(claims);
    expect(result.has("task-1")).toBe(true);
    expect(result.get("task-1")).toContain("task-2");
    expect(result.has("task-2")).toBe(true);
    expect(result.get("task-2")).toContain("task-1");
  });

  it("handles three-way overlap", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts"] },
      { taskId: "task-2", files: ["src/auth.ts"] },
      { taskId: "task-3", files: ["src/auth.ts"] },
    ];
    const result = detectFileOverlaps(claims);
    // task-1 owns the file; task-2 and task-3 conflict with task-1
    expect(result.get("task-1")).toContain("task-2");
    expect(result.get("task-1")).toContain("task-3");
  });

  it("tasks with no files don't conflict", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: [] },
      { taskId: "task-2", files: [] },
    ];
    const result = detectFileOverlaps(claims);
    expect(result.size).toBe(0);
  });
});

// =============================================================================
// serializeOverlappingTasks
// =============================================================================

describe("serializeOverlappingTasks", () => {
  it("dispatches all tasks when no overlaps", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2")];
    const specMap = new Map([
      ["task-1", "Modify `src/auth.ts`"],
      ["task-2", "Modify `src/store.ts`"],
    ]);
    const { dispatch, defer } = serializeOverlappingTasks(tasks, specMap);
    expect(dispatch).toEqual(["task-1", "task-2"]);
    expect(defer).toEqual([]);
  });

  it("defers second task when it shares a file with the first", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2")];
    const specMap = new Map([
      ["task-1", "Modify `crew/handlers/work.ts` to add serialization"],
      ["task-2", "Update `crew/handlers/work.ts` with new dispatch logic"],
    ]);
    const { dispatch, defer, overlapLog } = serializeOverlappingTasks(tasks, specMap);
    expect(dispatch).toEqual(["task-1"]);
    expect(defer).toEqual(["task-2"]);
    expect(overlapLog).toHaveLength(1);
    expect(overlapLog[0].deferredTaskId).toBe("task-2");
    expect(overlapLog[0].conflictingFiles).toContain("crew/handlers/work.ts");
    expect(overlapLog[0].conflictsWith).toContain("task-1");
  });

  it("preserves non-conflicting tasks alongside conflicting ones", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2"), makeTask("task-3")];
    const specMap = new Map([
      ["task-1", "Modify `src/auth.ts`"],
      ["task-2", "Modify `src/auth.ts`"], // conflicts with task-1
      ["task-3", "Modify `src/store.ts`"], // no conflict
    ]);
    const { dispatch, defer } = serializeOverlappingTasks(tasks, specMap);
    expect(dispatch).toContain("task-1");
    expect(dispatch).toContain("task-3");
    expect(defer).toEqual(["task-2"]);
  });

  it("handles tasks with no file mentions in specs (no conflict, dispatch all)", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2")];
    const specMap = new Map([
      ["task-1", "Implement the auth feature"],
      ["task-2", "Implement the store feature"],
    ]);
    const { dispatch, defer } = serializeOverlappingTasks(tasks, specMap);
    expect(dispatch).toEqual(["task-1", "task-2"]);
    expect(defer).toEqual([]);
  });

  it("handles empty task list", () => {
    const { dispatch, defer, overlapLog } = serializeOverlappingTasks([], new Map());
    expect(dispatch).toEqual([]);
    expect(defer).toEqual([]);
    expect(overlapLog).toEqual([]);
  });

  it("handles missing spec (no entry in map) — task dispatched without file claims", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2")];
    const specMap = new Map([
      ["task-1", "Modify `src/auth.ts`"],
      // task-2 has no spec
    ]);
    const { dispatch, defer } = serializeOverlappingTasks(tasks, specMap);
    expect(dispatch).toEqual(["task-1", "task-2"]);
    expect(defer).toEqual([]);
  });

  it("logs overlap reason including file names and conflicting task IDs", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2")];
    const specMap = new Map([
      ["task-1", "Edit `crew/handlers/work.ts`"],
      ["task-2", "Also edit `crew/handlers/work.ts`"],
    ]);
    const { overlapLog } = serializeOverlappingTasks(tasks, specMap);
    expect(overlapLog[0]).toMatchObject({
      deferredTaskId: "task-2",
      conflictingFiles: ["crew/handlers/work.ts"],
      conflictsWith: ["task-1"],
    });
  });
});

// =============================================================================
// buildFileClaims
// =============================================================================

describe("buildFileClaims", () => {
  it("builds claims from task specs", () => {
    const tasks = [makeTask("task-1"), makeTask("task-2")];
    const specMap = new Map([
      ["task-1", "Modify `src/auth.ts`"],
      ["task-2", "Modify `src/store.ts`"],
    ]);
    const claims = buildFileClaims(tasks, specMap);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({ taskId: "task-1", files: ["src/auth.ts"] });
    expect(claims[1]).toEqual({ taskId: "task-2", files: ["src/store.ts"] });
  });

  it("returns empty files array for tasks with no spec", () => {
    const tasks = [makeTask("task-1")];
    const claims = buildFileClaims(tasks, new Map());
    expect(claims[0].files).toEqual([]);
  });
});

// =============================================================================
// buildFileReservationContext
// =============================================================================

describe("buildFileReservationContext", () => {
  it("returns owned files for the requested task", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts"] },
      { taskId: "task-2", files: ["src/store.ts"] },
    ];
    const ctx = buildFileReservationContext("task-1", claims);
    expect(ctx.ownedFiles).toEqual(["src/auth.ts"]);
  });

  it("returns others reservations excluding the requested task", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts"] },
      { taskId: "task-2", files: ["src/store.ts"] },
      { taskId: "task-3", files: ["src/types.ts"] },
    ];
    const ctx = buildFileReservationContext("task-1", claims);
    expect(ctx.othersReservations).toHaveLength(2);
    expect(ctx.othersReservations[0]).toEqual({ taskId: "task-2", files: ["src/store.ts"] });
    expect(ctx.othersReservations[1]).toEqual({ taskId: "task-3", files: ["src/types.ts"] });
  });

  it("excludes tasks with no files from othersReservations", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts"] },
      { taskId: "task-2", files: [] }, // no files — should be excluded
    ];
    const ctx = buildFileReservationContext("task-1", claims);
    expect(ctx.othersReservations).toHaveLength(0);
  });

  it("returns empty context when only one task", () => {
    const claims: TaskFileClaim[] = [
      { taskId: "task-1", files: ["src/auth.ts"] },
    ];
    const ctx = buildFileReservationContext("task-1", claims);
    expect(ctx.ownedFiles).toEqual(["src/auth.ts"]);
    expect(ctx.othersReservations).toHaveLength(0);
  });
});
