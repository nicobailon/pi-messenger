/**
 * Crew - Worker Prompt Builder
 *
 * Assembles the full prompt sent to a worker when it's assigned a task.
 * Pure function: reads from store, returns a string.
 */

import type { Task } from "./types.js";
import type { CrewConfig } from "./utils/config.js";
import * as store from "./store.js";
import { buildDependencySection, buildCoordinationContext, buildCoordinationInstructions } from "./handlers/coordination.js";

export function buildWorkerPrompt(
  task: Task,
  prdPath: string,
  cwd: string,
  config: CrewConfig,
  concurrentTasks: Task[],
): string {
  const taskSpec = store.getTaskSpec(cwd, task.id);
  const planSpec = store.getPlanSpec(cwd);

  let prompt = `# Task Assignment

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**PRD:** ${prdPath}
${task.attempt_count >= 1 ? `**Attempt:** ${task.attempt_count + 1} (retry after previous attempt)` : ""}

## Your Mission

Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete

`;

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
