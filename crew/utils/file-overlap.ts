/**
 * Crew - File Overlap Detection
 *
 * Extracts file paths mentioned in task specs and detects when concurrent
 * tasks would write to the same files. Used to serialize overlapping tasks
 * before dispatch (Part 1 of hard file reservation enforcement).
 */

import type { Task } from "../types.js";

// =============================================================================
// File Path Extraction
// =============================================================================

// Extensions we care about — source and config files
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "c", "cpp", "h", "hpp",
  "json", "yaml", "yml", "toml",
  "md", "mdx",
  "sh", "bash",
  "css", "scss", "sass", "less",
  "html", "vue", "svelte",
]);

/**
 * Extract file paths mentioned in a task spec string.
 *
 * Recognizes:
 * - Backtick-quoted paths: `src/auth.ts`
 * - Quoted paths: "src/auth.ts" or 'src/auth.ts'
 * - Plain path-like tokens: src/auth.ts (at word boundaries)
 *
 * Returns deduplicated list of relative paths (no leading ./  or /).
 */
export function extractFilePathsFromSpec(spec: string): string[] {
  if (!spec) return [];

  const found = new Set<string>();

  // Pattern 1: backtick-quoted paths
  const backtickRe = /`([^`\s]+)`/g;
  for (const match of spec.matchAll(backtickRe)) {
    const candidate = normalizeCandidate(match[1]);
    if (candidate) found.add(candidate);
  }

  // Pattern 2: double or single-quoted paths
  const quotedRe = /["']([^"'\s]{4,100})["']/g;
  for (const match of spec.matchAll(quotedRe)) {
    const candidate = normalizeCandidate(match[1]);
    if (candidate) found.add(candidate);
  }

  // Pattern 3: plain path tokens at word boundaries (must contain / to avoid false positives)
  // Matches things like: src/auth.ts, crew/handlers/work.ts, tests/crew/foo.test.ts
  const plainRe = /(?:^|[\s(\[,])([a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)+\.[a-zA-Z]{1,8})(?=$|[\s)\],:.])/gm;
  for (const match of spec.matchAll(plainRe)) {
    const candidate = normalizeCandidate(match[1]);
    if (candidate) found.add(candidate);
  }

  return [...found];
}

function normalizeCandidate(raw: string): string | null {
  // Strip leading ./ or /
  let p = raw.replace(/^\.\//, "").replace(/^\/+/, "");

  // Must contain at least one slash (prevents matching bare filenames like "foo.ts")
  // OR be a recognizable path segment
  if (!p.includes("/")) return null;

  // Extract extension
  const lastDot = p.lastIndexOf(".");
  if (lastDot === -1) return null;
  const ext = p.slice(lastDot + 1).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return null;

  // Must not contain spaces or unusual chars
  if (/[\s<>|\\:]/.test(p)) return null;

  // Limit length sanity check
  if (p.length > 200) return null;

  return p;
}

// =============================================================================
// Overlap Detection and Serialization
// =============================================================================

export interface TaskFileClaim {
  taskId: string;
  files: string[];
}

/**
 * Build file claims for a list of tasks by extracting paths from their specs.
 *
 * @param tasks - tasks to build claims for
 * @param specMap - map from taskId to spec content
 */
export function buildFileClaims(
  tasks: Task[],
  specMap: Map<string, string>,
): TaskFileClaim[] {
  return tasks.map(task => ({
    taskId: task.id,
    files: extractFilePathsFromSpec(specMap.get(task.id) ?? ""),
  }));
}

/**
 * Detect which tasks conflict (share at least one file) with which other tasks.
 *
 * Returns a map from taskId -> array of taskIds it conflicts with.
 */
export function detectFileOverlaps(claims: TaskFileClaim[]): Map<string, string[]> {
  // file -> first task that claimed it
  const fileOwner = new Map<string, string>();
  // taskId -> conflict list
  const conflicts = new Map<string, string[]>();

  for (const claim of claims) {
    for (const file of claim.files) {
      const owner = fileOwner.get(file);
      if (owner && owner !== claim.taskId) {
        // Conflict: claim.taskId fights with owner
        const ownerConflicts = conflicts.get(owner) ?? [];
        if (!ownerConflicts.includes(claim.taskId)) {
          conflicts.set(owner, [...ownerConflicts, claim.taskId]);
        }
        const myConflicts = conflicts.get(claim.taskId) ?? [];
        if (!myConflicts.includes(owner)) {
          conflicts.set(claim.taskId, [...myConflicts, owner]);
        }
      } else if (!owner) {
        fileOwner.set(file, claim.taskId);
      }
    }
  }

  return conflicts;
}

/**
 * Serialize overlapping tasks: tasks that share files with a higher-priority
 * task (earlier in the list) are deferred to the next wave.
 *
 * Returns { dispatch: taskIds to run now, defer: taskIds to skip this wave }.
 *
 * The first task to claim a file "wins"; any later task touching the same
 * file is deferred. This is the core Part 1 enforcement.
 */
export function serializeOverlappingTasks(
  tasks: Task[],
  specMap: Map<string, string>,
): { dispatch: string[]; defer: string[]; overlapLog: OverlapLogEntry[] } {
  const claimedFiles = new Map<string, string>(); // file -> winning taskId
  const dispatch: string[] = [];
  const defer: string[] = [];
  const overlapLog: OverlapLogEntry[] = [];

  for (const task of tasks) {
    const files = extractFilePathsFromSpec(specMap.get(task.id) ?? "");
    const overlappingFiles = files.filter(f => claimedFiles.has(f));

    if (overlappingFiles.length > 0) {
      defer.push(task.id);
      overlapLog.push({
        deferredTaskId: task.id,
        conflictingFiles: overlappingFiles,
        conflictsWith: [...new Set(overlappingFiles.map(f => claimedFiles.get(f)!))],
      });
    } else {
      dispatch.push(task.id);
      // Claim all files for this task
      for (const f of files) {
        claimedFiles.set(f, task.id);
      }
    }
  }

  return { dispatch, defer, overlapLog };
}

export interface OverlapLogEntry {
  deferredTaskId: string;
  conflictingFiles: string[];
  conflictsWith: string[];
}

// =============================================================================
// Reserved Files Summary (for worker prompts — Part 2)
// =============================================================================

export interface FileReservationContext {
  /** Files this worker owns (extracted from its own spec) */
  ownedFiles: string[];
  /** Files owned by OTHER concurrent workers */
  othersReservations: Array<{ taskId: string; files: string[] }>;
}

/**
 * Build the file reservation context for a worker prompt.
 *
 * @param taskId - the task being assigned
 * @param claims - all task file claims for this wave
 */
export function buildFileReservationContext(
  taskId: string,
  claims: TaskFileClaim[],
): FileReservationContext {
  const ownedFiles = claims.find(c => c.taskId === taskId)?.files ?? [];
  const othersReservations = claims
    .filter(c => c.taskId !== taskId && c.files.length > 0)
    .map(c => ({ taskId: c.taskId, files: c.files }));

  return { ownedFiles, othersReservations };
}
