/**
 * Crew - Worker Prompt Builder
 *
 * Assembles the full prompt sent to a worker when it's assigned a task.
 * Pure function: reads from store, returns a string.
 */

import type { Task } from "./types.js";
import type { CrewConfig } from "./utils/config.js";
import type { CrewSkillInfo } from "./utils/discover.js";
import * as store from "./store.js";
import { buildDependencySection, buildCoordinationContext, buildCoordinationInstructions } from "./handlers/coordination.js";

export type AssignmentMode = "pre-claimed" | "unclaimed";

export function buildWorkerPrompt(
  task: Task,
  prdPath: string,
  cwd: string,
  config: CrewConfig,
  concurrentTasks: Task[],
  skills?: CrewSkillInfo[],
  runtime?: string,
  assignmentMode?: AssignmentMode,
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

  // CLI instructions for non-pi runtimes
  const cliInstructions = buildCliInstructions(runtime, assignmentMode);
  if (cliInstructions) {
    prompt += cliInstructions;
  }

  const skillsSection = buildSkillsSection(skills, task.skills);
  if (skillsSection) {
    prompt += skillsSection;
  }

  return prompt;
}

/**
 * Build CLI usage instructions for non-pi runtimes.
 * These instructions tell the worker how to interact with the mesh
 * via pi-messenger-cli instead of pi_messenger tool calls.
 */
export function buildCliInstructions(
  runtime?: string,
  assignmentMode?: AssignmentMode,
): string | null {
  if (!runtime || runtime === "pi") return null;

  let section = `## Mesh Communication (CLI)

You are running as a **${runtime}** worker. Use \`pi-messenger-cli\` for mesh operations:

`;

  if (assignmentMode === "pre-claimed") {
    section += `**Task is already started for you — do NOT call task.start.**

`;
  } else {
    section += `**You must start the task first:**
\`\`\`bash
pi-messenger-cli task.start <task-id>
\`\`\`

`;
  }

  section += `**When you're done:**
\`\`\`bash
pi-messenger-cli task.done <task-id> --summary "Brief description of what was implemented"
\`\`\`

**File reservations:**
\`\`\`bash
pi-messenger-cli reserve --paths src/myfile.ts src/other.ts
pi-messenger-cli release --paths src/myfile.ts
\`\`\`

**Communication:**
\`\`\`bash
pi-messenger-cli send --to <agent-name> --message "your message"
pi-messenger-cli list
pi-messenger-cli feed
\`\`\`

`;

  return section;
}

function buildSkillsSection(
  skills: CrewSkillInfo[] | undefined,
  taskSkills: string[] | undefined,
): string | null {
  if (!skills || skills.length === 0) return null;

  const recommended = new Set(taskSkills ?? []);
  const recSkills = skills.filter(s => recommended.has(s.name));
  const otherSkills = skills.filter(s => !recommended.has(s.name));

  let section = `## Available Skills

Read any skill that matches what you're implementing.

`;

  if (recSkills.length > 0) {
    section += "**Recommended for this task:**\n";
    for (const s of recSkills) {
      section += `  ${s.name} — ${s.description}\n    ${s.path}\n`;
    }
    section += "\n";
  }

  if (otherSkills.length > 0) {
    if (recSkills.length > 0) section += "**Also available:**\n";
    for (const s of otherSkills) {
      section += `  ${s.name} — ${s.description}\n    ${s.path}\n`;
    }
    section += "\n";
  }

  section += `To load a skill: read({ path: "<skill-path>" })\n`;

  return section;
}
