/**
 * Crew - Worker Prompt Builder
 *
 * Assembles the full prompt sent to a worker when it's assigned a task.
 * Pure function: reads from store, returns a string.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Task } from "./types.js";
import type { CrewConfig } from "./utils/config.js";
import * as store from "./store.js";
import { buildDependencySection, buildCoordinationContext, buildCoordinationInstructions } from "./handlers/coordination.js";
import type { FileReservationContext } from "./utils/file-overlap.js";

export function buildWorkerPrompt(
  task: Task,
  prdPath: string,
  cwd: string,
  config: CrewConfig,
  concurrentTasks: Task[],
  fileReservationCtx?: FileReservationContext,
): string {
  const taskSpec = store.getTaskSpec(cwd, task.id);
  const planSpec = store.getPlanSpec(cwd);

  let prompt = `# Task Assignment

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**PRD:** ${prdPath}
${task.attempt_count >= 1 ? `**Attempt:** ${task.attempt_count + 1} (retry after previous attempt)` : ""}
${task.spawn_failure_count && task.spawn_failure_count > 0 ? `**Spawn failures:** ${task.spawn_failure_count}` : ""}

## Your Mission

Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete

`;

  // === Part 2: File Reservation Section (hard enforcement via prompt contract) ===
  // If the coordinator detected file claims, add an explicit RESERVED FILES section.
  // This transforms the advisory pattern into a hard contract: the worker's prompt
  // explicitly lists owned files and forbidden files with enforcement language.
  if (fileReservationCtx && (fileReservationCtx.ownedFiles.length > 0 || fileReservationCtx.othersReservations.length > 0)) {
    prompt += buildFileReservationSection(fileReservationCtx);
  }

  if (task.last_review) {
    prompt += `## ⚠️ Previous Review Feedback

**Verdict:** ${task.last_review.verdict}

${task.last_review.summary}

${task.last_review.issues.length > 0 ? `**Issues to fix:**\n${task.last_review.issues.map(i => `- ${i}`).join("\n")}\n` : ""}
${task.last_review.suggestions.length > 0 ? `**Suggestions:**\n${task.last_review.suggestions.map(s => `- ${s}`).join("\n")}\n` : ""}

**You MUST address the issues above in this attempt.**

`;
  }

  const progress = store.getTaskProgress(cwd, task.id);
  if (progress) {
    const lines = progress.trimEnd().split("\n");
    const capped = lines.length > 30 ? lines.slice(-30) : lines;
    const truncated = capped.join("\n");
    const omitted = lines.length > 30 ? `(${lines.length - 30} earlier entries omitted)\n` : "";
    prompt += `## Progress from Prior Attempts

${omitted}${truncated}

`;
  }

  if (task.depends_on.length > 0) {
    if (config.dependencies === "advisory" || config.coordination !== "none") {
      prompt += buildDependencySection(cwd, task, config);
    } else {
      prompt += `## Dependencies

This task depends on: ${task.depends_on.join(", ")}
These tasks are already complete - you can reference their implementations.

`;
    }

    // Inject handoff briefs from completed dependencies
    const handoffBriefs = buildHandoffBriefSection(cwd, task);
    if (handoffBriefs) {
      prompt += handoffBriefs;
    }
  }

  const coordContext = buildCoordinationContext(cwd, task, config, concurrentTasks);
  if (coordContext) {
    prompt += coordContext;
  }

  if (taskSpec && !taskSpec.includes("*Spec pending*")) {
    prompt += `## Task Specification

${taskSpec}

`;
  }

  if (planSpec && !planSpec.includes("*Spec pending*")) {
    const truncatedSpec = planSpec.length > 2000
      ? planSpec.slice(0, 2000) + `\n\n[Spec truncated - read full spec from .pi/messenger/crew/plan.md]`
      : planSpec;
    prompt += `## Plan Context

${truncatedSpec}
`;
  }

  const coordInstructions = buildCoordinationInstructions(config);
  if (coordInstructions) {
    prompt += coordInstructions;
  }

  return prompt;
}

/**
 * Build a section containing handoff briefs from completed dependency tasks.
 * Reads handoff artifacts from {crewDir}/artifacts/{depId}-handoff.md for each
 * done dependency.
 */
function buildHandoffBriefSection(cwd: string, task: Task): string | null {
  if (task.depends_on.length === 0) return null;

  const crewDir = store.getCrewDir(cwd);
  const briefs: string[] = [];

  for (const depId of task.depends_on) {
    const dep = store.getTask(cwd, depId);
    if (!dep || dep.status !== "done") continue;

    const handoffPath = path.join(crewDir, "artifacts", `${depId}-handoff.md`);
    if (!fs.existsSync(handoffPath)) continue;

    try {
      const content = fs.readFileSync(handoffPath, "utf-8").trim();
      if (content.length > 0) {
        briefs.push(`### ${depId}: ${dep.title}\n\n${content}`);
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (briefs.length === 0) return null;

  return `## Handoff Briefs from Dependencies\n\n${briefs.join("\n\n---\n\n")}\n\n`;
}

// =============================================================================
// File Reservation Section Builder (Part 2 — hard enforcement via prompt contract)
// =============================================================================

/**
 * Build the RESERVED FILES section for a worker prompt.
 *
 * This turns the file reservation system from advisory to hard: the worker's
 * prompt explicitly lists which files they own (may edit) and which files are
 * owned by concurrent workers (must NOT edit without coordination). The worker
 * understands this is a contract — violating it causes merge conflicts and
 * will result in task reset.
 */
function buildFileReservationSection(ctx: FileReservationContext): string {
  let section = `## ⚠️ File Reservations — Hard Enforcement

This section is generated by the crew coordinator based on file analysis.
It is a **hard contract** — not advisory. The orchestrator checks git diffs.

`;

  if (ctx.ownedFiles.length > 0) {
    section += `### ✅ Your Reserved Files (you MAY edit these)

These files were detected in your task spec. You own them for this wave:

${ctx.ownedFiles.map(f => `- \`${f}\``).join("\n")}

**You may also create new files not listed here** (new files don't conflict).

`;
  } else {
    section += `### ✅ Your Reserved Files

No specific files were detected in your task spec. You may create new files freely.
Check the task spec and reserve files via \`pi_messenger({ action: "reserve", paths: [...] })\` before editing.

`;
  }

  if (ctx.othersReservations.length > 0) {
    const allOtherFiles = ctx.othersReservations.flatMap(r => r.files);
    if (allOtherFiles.length > 0) {
      section += `### ⛔ Files Reserved by Concurrent Workers (DO NOT edit)

These files are owned by other workers running in parallel. Editing them will
cause merge conflicts, trigger a task reset, and waste the entire wave:

${ctx.othersReservations
  .filter(r => r.files.length > 0)
  .map(r => r.files.map(f => `- \`${f}\` — reserved by ${r.taskId}`).join("\n"))
  .join("\n")}

**If you genuinely need to edit a reserved file:**
1. Message the owning worker via \`pi_messenger({ action: "send", to: "<worker>", message: "..." })\`
2. Coordinate the change — don't write over them unilaterally

`;
    }
  }

  return section;
}
