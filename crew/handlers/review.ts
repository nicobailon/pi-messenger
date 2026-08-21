/**
 * Crew - Review Handler
 * 
 * Spawns reviewer with git diff context for task or plan review.
 * Simplified: works with current plan
 */

import { execSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewParams } from "../types.ts";
import { result } from "../utils/result.ts";
import { spawnAgents } from "../agents.ts";
import { discoverCrewAgents } from "../utils/discover.ts";
import { loadCrewConfig } from "../utils/config.ts";
import { parseVerdict, type ParsedReview } from "../utils/verdict.ts";
import * as store from "../store.ts";

export async function execute(
  params: CrewParams,
  ctx: ExtensionContext,
  sessionModel?: string,
) {
  const cwd = ctx.cwd;
  const { target, type } = params;
  const config = loadCrewConfig(store.getCrewDir(cwd));
  const reviewerModel = config.models?.reviewer ?? sessionModel;

  if (!target) {
    return result("Error: target (task ID) required for review action.\n\nUsage: pi_messenger({ action: \"review\", target: \"task-1\" })", {
      mode: "review",
      error: "missing_target"
    });
  }

  // Check for reviewer agent
  const availableAgents = discoverCrewAgents(cwd);
  const hasReviewer = availableAgents.some(a => a.name === "crew-reviewer");
  if (!hasReviewer) {
    return result("Error: crew-reviewer agent not found. Required for code review.", {
      mode: "review",
      error: "no_reviewer"
    });
  }

  if (type && type !== "impl" && type !== "plan") {
    return result("Error: review type must be 'impl' or 'plan'.", {
      mode: "review",
      error: "invalid_type",
      type,
    });
  }

  // Determine review type: "impl" for task, "plan" for plan review
  const reviewType = type ?? (target.startsWith("task-") ? "impl" : "plan");

  if (reviewType === "impl") {
    return reviewImplementation(cwd, target, reviewerModel);
  } else {
    return reviewPlan(cwd, reviewerModel);
  }
}

// =============================================================================
// Implementation Review
// =============================================================================

export async function reviewImplementation(cwd: string, taskId: string, modelOverride?: string) {
  const task = store.getTask(cwd, taskId);
  if (!task) {
    return result(`Error: Task ${taskId} not found.`, {
      mode: "review",
      error: "task_not_found",
      target: taskId
    });
  }

  if (task.status !== "done" && task.status !== "in_progress") {
    return result(`Error: Task ${taskId} is ${task.status}. Can only review in_progress or done tasks.`, {
      mode: "review",
      error: "invalid_status",
      status: task.status
    });
  }

  // Get git diff
  const baseCommit = task.base_commit;
  if (!baseCommit) {
    return result(`Error: Task ${taskId} has no base_commit. Cannot generate diff.`, {
      mode: "review",
      error: "no_base_commit"
    });
  }

  // Prefer the task's own branch (works across linked worktrees since
  // branches are repo-wide refs); fall back to the main checkout HEAD.
  const taskBranch = getTaskBranch(taskId, cwd);
  const diff = getGitDiff(baseCommit, cwd, taskBranch ?? undefined);
  const commitLog = getCommitLog(baseCommit, cwd, taskBranch ?? undefined);
  const diffError = taskBranch && !hasDiffContent(diff)
    ? `**ERROR:** Task branch \`${taskBranch}\` exists but has no changes relative to base ${baseCommit.slice(0, 12)}. The implementation appears to be missing from the branch.`
    : null;

  // Get task spec for context
  const taskSpec = store.getTaskSpec(cwd, taskId) ?? "";
  const plan = store.getPlan(cwd);

  // Build review prompt
  const prompt = `# Code Review Request

## Task Information

**Task ID:** ${taskId}
**Task Title:** ${task.title}
**PRD:** ${plan?.prd ?? "Unknown"}

## Task Specification

${taskSpec || "*No spec available*"}

## Changes
### Commits
${commitLog || "*No commits*"}

### Diff
${diffError ?? `\`\`\`diff
${diff}
\`\`\``}

## Your Review

Review this implementation following the crew-reviewer protocol.
Output your verdict as SHIP, NEEDS_WORK, or MAJOR_RETHINK with detailed feedback.`;

  // Spawn reviewer
  const [reviewResult] = await spawnAgents([{
    agent: "crew-reviewer",
    task: prompt,
    modelOverride,
  }], cwd);

  if (reviewResult.exitCode !== 0) {
    return result(`Error: Reviewer failed: ${reviewResult.error ?? "Unknown error"}`, {
      mode: "review",
      error: "reviewer_failed"
    });
  }

  // Parse verdict from output
  const verdict: ParsedReview = parseVerdict(reviewResult.output);

  // Store review feedback in task for retry context
  store.updateTask(cwd, taskId, {
    last_review: {
      verdict: verdict.verdict,
      summary: verdict.summary,
      issues: verdict.issues,
      suggestions: verdict.suggestions,
      reviewed_at: new Date().toISOString()
    }
  });
  const shortSummary = verdict.summary.split("\n")[0].slice(0, 120);
  const progressMsg = `Review: ${verdict.verdict} — ${shortSummary}`;
  store.appendTaskProgress(cwd, taskId, "system", progressMsg);

  const text = `# Review: ${taskId}

**Verdict:** ${verdict.verdict}

${verdict.summary}

${verdict.issues.length > 0 ? `## Issues\n${verdict.issues.map(i => `- ${i}`).join("\n")}` : ""}

${verdict.suggestions.length > 0 ? `## Suggestions\n${verdict.suggestions.map(s => `- ${s}`).join("\n")}` : ""}

${verdict.verdict === "SHIP" ? "✅ Ready to merge!" : verdict.verdict === "NEEDS_WORK" ? "⚠️ Address issues and re-review." : "🔄 Consider re-planning this task."}`;

  return result(text, {
    mode: "review",
    type: "impl",
    taskId,
    verdict: verdict.verdict,
    issueCount: verdict.issues.length,
    suggestionCount: verdict.suggestions.length
  });
}

// =============================================================================
// Plan Review
// =============================================================================

async function reviewPlan(cwd: string, modelOverride?: string) {
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("Error: No plan found.", {
      mode: "review",
      error: "no_plan"
    });
  }

  const planSpec = store.getPlanSpec(cwd);
  const tasks = store.getTasks(cwd);

  // Build task overview
  const taskOverview = tasks.map(t => {
    const spec = store.getTaskSpec(cwd, t.id);
    const deps = t.depends_on.length > 0 ? ` (deps: ${t.depends_on.join(", ")})` : "";
    const specPreview = spec && !spec.includes("*Spec pending*")
      ? `\n  ${spec.slice(0, 200)}${spec.length > 200 ? "..." : ""}`
      : "";
    return `- ${t.id}: ${t.title}${deps}${specPreview}`;
  }).join("\n");

  // Build review prompt
  const prompt = `# Plan Review Request

## Plan Information

**PRD:** ${store.getPlanLabel(plan)}
**Tasks:** ${tasks.length}
**Progress:** ${plan.completed_count}/${plan.task_count}

## Plan Specification

${planSpec || "*No spec available*"}

## Task Breakdown

${taskOverview || "*No tasks*"}

## Your Review

Review this plan for:
1. Completeness - Are all requirements covered?
2. Task granularity - Are tasks appropriately sized?
3. Dependencies - Are dependencies correct and complete?
4. Gaps - Are there missing tasks or edge cases?
5. Parallelism - Are there unnecessary sequential dependencies? Tasks that don't share files or types should be independent.
6. Critical path - What's the longest dependency chain? Could it be shortened?

Output your verdict as SHIP (plan is solid), NEEDS_WORK (minor adjustments), or MAJOR_RETHINK (fundamental issues).`;

  // Spawn reviewer
  const [reviewResult] = await spawnAgents([{
    agent: "crew-reviewer",
    task: prompt,
    modelOverride,
  }], cwd);

  if (reviewResult.exitCode !== 0) {
    return result(`Error: Reviewer failed: ${reviewResult.error ?? "Unknown error"}`, {
      mode: "review",
      error: "reviewer_failed"
    });
  }

  // Parse verdict
  const verdict: ParsedReview = parseVerdict(reviewResult.output);

  const text = `# Plan Review

**PRD:** ${store.getPlanLabel(plan)}
**Verdict:** ${verdict.verdict}

${verdict.summary}

${verdict.issues.length > 0 ? `## Issues\n${verdict.issues.map(i => `- ${i}`).join("\n")}` : ""}

${verdict.suggestions.length > 0 ? `## Suggestions\n${verdict.suggestions.map(s => `- ${s}`).join("\n")}` : ""}

${verdict.verdict === "SHIP" ? "✅ Plan is ready for execution!" : verdict.verdict === "NEEDS_WORK" ? "⚠️ Adjust plan before starting work." : "🔄 Consider re-planning with more context."}`;

  return result(text, {
    mode: "review",
    type: "plan",
    prd: plan.prd,
    verdict: verdict.verdict,
    issueCount: verdict.issues.length,
    suggestionCount: verdict.suggestions.length
  });
}

// =============================================================================
// Helpers
// =============================================================================

// Resolve the task's branch (task/<id>), if it exists. Branches are shared
// refs, so this covers branches checked out in linked worktrees as well.
export function getTaskBranch(taskId: string, cwd: string): string | null {
  try {
    execSync(`git rev-parse --verify refs/heads/task/${taskId}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    });
    return `task/${taskId}`;
  } catch {
    return null;
  }
}

function getGitDiff(baseCommit: string, cwd: string, ref?: string): string {
  // Three-dot merge-base diff against the task branch; two-dot vs HEAD fallback.
  const range = ref ? `${baseCommit}...${ref}` : `${baseCommit}..HEAD`;
  try {
    const diff = execSync(
      `git diff ${range}`,
      { cwd, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );
    // Truncate very long diffs
    if (diff.length > 50000) {
      return diff.slice(0, 50000) + "\n\n[Diff truncated - too large]";
    }
    return diff || "*No changes*";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `*Failed to get diff: ${message}*`;
  }
}

function getCommitLog(baseCommit: string, cwd: string, ref?: string): string {
  // Same base resolution as the diff so commits match the diffed range.
  const range = ref ? `${baseCommit}..${ref}` : `${baseCommit}..HEAD`;
  try {
    return execSync(
      `git log ${range} --oneline --no-decorate`,
      { cwd, encoding: "utf-8" }
    ).trim() || "*No commits*";
  } catch {
    return "*No commits*";
  }
}

function hasDiffContent(diff: string): boolean {
  return diff !== "*No changes*" && !diff.startsWith("*");
}
