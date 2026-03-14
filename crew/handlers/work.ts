/**
 * Crew - Work Handler
 * 
 * Spawns workers for ready tasks with concurrency control.
 * Simplified: works on current plan's tasks
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { generateMemorableName, type Dirs } from "../../lib.js";
import type { CrewParams, AppendEntryFn, AgentResult } from "../types.js";
import { result } from "../utils/result.js";
import { resolveModel, resolveModelForTaskRole, selectCrewAgentForRole, spawnAgents } from "../agents.js";
import { loadCrewConfig } from "../utils/config.js";
import { discoverCrewAgents, type CrewRole } from "../utils/discover.js";
import { buildWorkerPrompt } from "../prompt.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";
import { hasActiveWorker } from "../registry.js";
import { autonomousState, isAutonomousForCwd, startAutonomous, stopAutonomous, addWaveResult, clampConcurrency } from "../state.js";
import { getAvailableLobbyWorkers, assignTaskToLobbyWorker, cleanupUnassignedAliveFiles } from "../lobby.js";
import { logFeedEvent } from "../../feed.js";
import { clearHeartbeat } from "../heartbeat.js";
import { checkStaleHeartbeats } from "../lobby.js";
import { recordReviewOutcome, getReviewIntensity } from "../credibility.js";
import { classifyTask, recordTaskOutcome } from "../specialization.js";
import { checkWaveConflicts } from "../conflict-detector.js";
import {
  buildFileClaims,
  serializeOverlappingTasks,
  buildFileReservationContext,
  type TaskFileClaim,
} from "../utils/file-overlap.js";
import { reconcileOrphanedTasks } from "../reconcile.js";

type NamespaceParams = CrewParams & {
  crew?: string;
  crewNamespace?: string;
  namespace?: string;
};

function resolveCrewNamespace(params: CrewParams): string {
  const ns =
    (params as NamespaceParams).crewNamespace
    ?? (params as NamespaceParams).crew
    ?? (params as NamespaceParams).namespace
    ?? "shared";
  const normalized = typeof ns === "string" ? ns.trim() : "";
  return normalized.length > 0 ? normalized : "shared";
}

function namespacedTaskId(taskId: string, crewNamespace: string): string {
  return crewNamespace === "shared" ? taskId : `${crewNamespace}::${taskId}`;
}

function fromNamespacedTaskId(taskId: string | undefined, crewNamespace: string): string | undefined {
  if (!taskId) return undefined;
  if (crewNamespace === "shared") return taskId;
  const prefix = `${crewNamespace}::`;
  return taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
}

function buildIdentityFingerprint(parts: Record<string, string | undefined>): string {
  const serialized = Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value?.trim() ?? ""}`)
    .join("|");
  return createHash("sha256").update(serialized).digest("hex").slice(0, 12);
}

function resolveStableModelIdentity(parts: {
  modelOverride?: string;
  taskModel?: string;
  paramsModel?: string;
  configRoleModel?: string;
  agentModel?: string;
  role?: string;
  agentName?: string;
}): string {
  const normalizedModel = parts.modelOverride?.trim()
    || parts.taskModel?.trim()
    || parts.paramsModel?.trim()
    || parts.configRoleModel?.trim()
    || parts.agentModel?.trim();

  if (normalizedModel) {
    return `model:${normalizedModel}`;
  }

  const fingerprint = buildIdentityFingerprint({
    role: parts.role,
    agent: parts.agentName,
    taskModel: parts.taskModel,
    paramsModel: parts.paramsModel,
    configRoleModel: parts.configRoleModel,
    agentModel: parts.agentModel,
  });

  return `config:${fingerprint}`;
}

const FEYNMAN_ROLES: CrewRole[] = ["scout", "planner", "worker", "reviewer", "verifier", "auditor", "researcher", "analyst"];

const ROLE_KEYWORDS: Array<{ role: CrewRole; patterns: RegExp[] }> = [
  { role: "reviewer", patterns: [/\badversarial review\b/i, /\bcode review\b/i, /\breview\b/i] },
  { role: "verifier", patterns: [/\binvariant\b/i, /\btrace\b/i, /\bverify\b/i, /\bcorrectness\b/i] },
  { role: "auditor", patterns: [/\baudit\b/i, /\bfact\b/i, /\bclaim\b/i, /\bcompliance\b/i] },
  { role: "researcher", patterns: [/\bresearch\b/i, /\bbenchmark\b/i, /\bexternal\b/i, /\bdocs?\b/i] },
  { role: "planner", patterns: [/\bplan\b/i, /\barchitecture\b/i, /\bdecomposition\b/i, /\broadmap\b/i, /\bdesign\b/i] },
  { role: "scout", patterns: [/\brecon\b/i, /\bimpact analysis\b/i, /\bmap(ping)?\b/i, /\binventory\b/i, /\bexplore\b/i] },
  { role: "worker", patterns: [/\bimplement\b/i, /\bfix\b/i, /\badd\b/i, /\bbuild\b/i, /\bedit(s)?\b/i, /\bmodify\b/i] },
];

function normalizeRole(value: string | undefined): CrewRole | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return FEYNMAN_ROLES.includes(normalized as CrewRole) ? normalized as CrewRole : undefined;
}

export function classifyTaskToFeynmanRole(
  title: string,
  spec?: string,
  preferredRole?: string,
): CrewRole {
  const explicit = normalizeRole(preferredRole);
  if (explicit) return explicit;

  const text = `${title}
${spec ?? ""}`;
  for (const entry of ROLE_KEYWORDS) {
    if (entry.patterns.some(pattern => pattern.test(text))) {
      return entry.role;
    }
  }
  return "worker";
}


/**
 * Spawn an adversarial reviewer for a completed task (async/non-blocking).
 * The reviewer examines the task diff and spec, producing an APPROVE/REJECT verdict.
 * If rejected, the task is reset to "todo" with reviewer feedback in progress.
 */
async function runAdversarialReview(
  taskId: string,
  taskTitle: string,
  taskSummary: string | undefined,
  baseCommit: string | undefined,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
): Promise<"approved" | "rejected" | "error"> {
  const reviewPrompt = [
    `## Adversarial Review: ${taskId}`,
    ``,
    `### Task: ${taskTitle}`,
    ``,
    taskSummary ? `### Completion Summary:\n${taskSummary}` : "",
    ``,
    `### Instructions:`,
    `1. Read the task spec from the plan in the crew directory`,
    `2. Examine the git diff: \`git diff ${baseCommit ?? "HEAD~1"}..HEAD\``,
    `3. Find at least 3 issues (scope drift, missing edge cases, style violations, test gaps, security concerns)`,
    `4. Output a structured verdict: APPROVE or REJECT`,
    ``,
    `Working directory: ${cwd}`,
  ].filter(Boolean).join("\n");

  store.appendTaskProgress(cwd, taskId, "system",
    `Adversarial review spawned for ${taskId}`);
  logFeedEvent(cwd, "adversarial-reviewer", "message", taskId, `Adversarial review started for ${taskTitle}`);

  const reviewModel = resolveModel(config.models?.reviewer);
  const results = await spawnAgents(
    [{
      agent: "adversarial-reviewer",
      task: reviewPrompt,
      taskId: `review-${taskId}`,
      modelOverride: reviewModel,
    }],
    cwd,
    { messengerDirs: { registry: dirs.registry, inbox: dirs.inbox } },
  );

  const reviewResult = results[0];
  if (!reviewResult) return "error";

  const output = reviewResult.output ?? "";
  const isRejected = /## Verdict:\s*REJECT/i.test(output);

    // Record credibility outcome for the agent that completed the task
    const taskRecord = store.getTask(cwd, taskId);
    const reviewIdentity = taskRecord?.model_identity ?? taskRecord?.assigned_to;
    if (reviewIdentity) {
      const cred = recordReviewOutcome(reviewIdentity, !isRejected);
      store.appendTaskProgress(cwd, taskId, "system",
        `Credibility updated for ${reviewIdentity}: score=${cred.credibilityScore}`);
    }

    store.appendTaskProgress(cwd, taskId, "adversarial-reviewer",
      isRejected
        ? `❌ Adversarial review REJECTED: see review output for details`
        : `✅ Adversarial review APPROVED`);
    logFeedEvent(cwd, "adversarial-reviewer", isRejected ? "task.reset" : "task.done",
      taskId, isRejected ? "Adversarial review: REJECTED" : "Adversarial review: APPROVED");

  if (isRejected) {
    // Extract issues from output for feedback
    const issueMatches = output.match(/### Issue \d+:.*?(?=### Issue \d+:|## Summary|<\/adversarial_verdict>)/gs);
    const issues = issueMatches
      ? issueMatches.map(m => m.trim()).slice(0, 5)
      : ["See full adversarial review output for details"];

    store.rejectTaskReview(cwd, taskId);
    store.updateTask(cwd, taskId, {
      last_review: {
        verdict: "NEEDS_WORK",
        summary: "Adversarial review rejected the completion",
        issues,
        suggestions: [],
        reviewed_at: new Date().toISOString(),
      },
    });
    store.appendTaskProgress(cwd, taskId, "system",
      `Task reset to todo after adversarial review rejection`);
    return "rejected";
  }

  return "approved";
}

/**
 * Spawn an integration tester for a completed task (async/non-blocking).
 * Runs test suite, linting, and type-checking. If any check fails, the task
 * is blocked with failure details.
 */
async function runIntegrationTest(
  taskId: string,
  taskTitle: string,
  baseCommit: string | undefined,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
): Promise<"passed" | "failed" | "error"> {
  const testPrompt = [
    `## Integration Test: ${taskId}`,
    ``,
    `### Task: ${taskTitle}`,
    ``,
    `### Instructions:`,
    `1. Project directory: ${cwd}`,
    `2. Run the test suite (look for package.json scripts: test, vitest, jest)`,
    `3. Run linting (eslint, biome, or lint script)`,
    `4. Run type-checking (tsc --noEmit)`,
    `5. Output a structured report: PASS or FAIL with details for each check`,
    `6. If any check fails, the overall verdict is FAIL`,
    ``,
    `Base commit for reference: ${baseCommit ?? "HEAD~1"}`,
    `Working directory: ${cwd}`,
  ].join("\n");

  store.appendTaskProgress(cwd, taskId, "system",
    `Integration test spawned for ${taskId}`);
  logFeedEvent(cwd, "integration-tester", "message", taskId, `Integration test started for ${taskTitle}`);

  const testModel = resolveModel(config.models?.reviewer);
  const results = await spawnAgents(
    [{
      agent: "integration-tester",
      task: testPrompt,
      taskId: `integration-${taskId}`,
      modelOverride: testModel,
    }],
    cwd,
    { messengerDirs: { registry: dirs.registry, inbox: dirs.inbox } },
  );

  const testResult = results[0];
  if (!testResult) return "error";

  const output = testResult.output ?? "";
  const isFail = /## Verdict:\s*FAIL/i.test(output);

    store.appendTaskProgress(cwd, taskId, "integration-tester",
      isFail
        ? `❌ Integration tests FAILED: see test output for details`
        : `✅ Integration tests PASSED`);
    logFeedEvent(cwd, "integration-tester", isFail ? "task.block" : "task.done",
      taskId, isFail ? "Integration tests: FAILED" : "Integration tests: PASSED");

  if (isFail) {
    // Extract failure details from report
    const failSections = output.match(/### (?:Test Suite|Linting|Type Checking)[\s\S]*?(?=###|## Verdict|<\/integration_test_report>)/g);
    const failures = failSections
      ? failSections.filter(s => /Status:\s*FAIL/i.test(s)).map(s => s.trim()).slice(0, 5)
      : ["See full integration test output for details"];

    store.blockTask(cwd, taskId, `Integration test failures:\n${failures.join("\n")}`);
    store.appendTaskProgress(cwd, taskId, "system",
      `Task blocked after integration test failure`);
    return "failed";
  }

  return "passed";
}


async function finalizePendingAcceptance(
  task: import("../types.js").Task,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
): Promise<"succeeded" | "failed" | "blocked"> {
  if (task.status !== "pending_review") {
    return task.status === "blocked" ? "blocked" : task.status === "done" ? "succeeded" : "failed";
  }

  const reviewEnabled = config.review?.autoAdversarial !== false;
  let reviewResult: "approved" | "rejected" | "error" = "approved";

  if (reviewEnabled) {
    reviewResult = await runAdversarialReview(task.id, task.title, task.summary, task.base_commit, cwd, config, dirs);
  }

  if (reviewResult === "rejected") return "failed";
  if (reviewResult === "error") return "failed";

  const latestAfterReview = store.getTask(cwd, task.id);
  if (!latestAfterReview || latestAfterReview.status !== "pending_review") {
    if (latestAfterReview?.status === "done") return "succeeded";
    if (latestAfterReview?.status === "blocked") return "blocked";
    return "failed";
  }

  const integrationEnabled = config.review?.autoIntegrationTest !== false;
  const agentName = latestAfterReview.assigned_to;
  const intensity = agentName ? getReviewIntensity(agentName) : "standard";
  const shouldRunIntegration = integrationEnabled && intensity !== "light";

  if (!shouldRunIntegration) {
    if (integrationEnabled && intensity === "light") {
      store.appendTaskProgress(cwd, task.id, "system",
        `Integration test skipped: ${agentName} has light review intensity (high credibility)`);
    }
    const accepted = store.acceptTask(cwd, task.id);
    return accepted ? "succeeded" : "failed";
  }

  store.transitionTaskToPendingIntegration(cwd, task.id);
  const latestBeforeIntegration = store.getTask(cwd, task.id);
  if (!latestBeforeIntegration) return "failed";

  const integrationResult = await runIntegrationTest(
    task.id,
    task.title,
    task.base_commit,
    cwd,
    config,
    dirs,
  );

  if (integrationResult !== "passed") {
    return integrationResult === "failed" ? "blocked" : "failed";
  }

  const accepted = store.acceptTask(cwd, task.id);
  return accepted ? "succeeded" : "failed";
}

/**
 * Trigger a rollback for a task that caused cascading failures.
 * Spawns the rollback-agent to revert changes, then resets the task to todo
 * with rollback context so it can be re-attempted.
 */
export function triggerRollback(cwd: string, taskId: string, reason: string): void {
  const task = store.getTask(cwd, taskId);
  if (!task) {
    store.appendTaskProgress(cwd, taskId, "system",
      `Rollback skipped: task ${taskId} not found`);
    return;
  }

  const baseCommit = task.base_commit;
  if (!baseCommit) {
    store.appendTaskProgress(cwd, taskId, "system",
      `Rollback skipped: no base_commit recorded for ${taskId}`);
    return;
  }

  const rollbackPrompt = [
    `## Rollback: ${taskId}`,
    ``,
    `### Task: ${task.title}`,
    ``,
    `### Base Commit: ${baseCommit}`,
    ``,
    `### Failure Details:`,
    reason,
    ``,
    `### Instructions:`,
    `1. \`git log --oneline ${baseCommit}..HEAD\` to see commits from this task`,
    `2. \`git diff ${baseCommit}..HEAD\` to see all changes`,
    `3. \`git revert --no-commit ${baseCommit}..HEAD\` to undo changes`,
    `4. Verify: run tests to confirm revert fixed the issue`,
    `5. If revert fixed it, commit with message "rollback: revert ${taskId} due to cascading failures"`,
    `6. Report what was reverted and why`,
    ``,
    `Working directory: ${cwd}`,
  ].join("\n");

  store.appendTaskProgress(cwd, taskId, "system",
    `Rollback triggered for ${taskId}: ${reason}`);
  logFeedEvent(cwd, "rollback-agent", "message", taskId,
    `Rollback initiated for ${task.title}`);

  const rollbackModel = resolveModel("openai/gpt-5.3-mini");
  spawnAgents(
    [{
      agent: "rollback-agent",
      task: rollbackPrompt,
      taskId: `rollback-${taskId}`,
      modelOverride: rollbackModel,
    }],
    cwd,
    {},
  ).then((results) => {
    const rollbackResult = results[0];
    if (!rollbackResult) return;

    const output = rollbackResult.output ?? "";
    const wasReverted = /status:\s*reverted/i.test(output);

    store.appendTaskProgress(cwd, taskId, "rollback-agent",
      wasReverted
        ? `✅ Rollback completed: changes from ${taskId} have been reverted`
        : `❌ Rollback failed: could not revert changes from ${taskId}`);
    logFeedEvent(cwd, "rollback-agent",
      wasReverted ? "task.reset" : "task.block",
      taskId,
      wasReverted ? "Rollback: reverted" : "Rollback: failed");

    if (wasReverted) {
      // Reset task to todo with rollback context so it can be re-attempted
      store.updateTask(cwd, taskId, {
        status: "todo",
        assigned_to: undefined,
        blocked_reason: undefined,
        rollback_reason: reason,
      });
      store.appendTaskProgress(cwd, taskId, "system",
        `Task reset to todo after rollback. Reason: ${reason}`);
    } else {
      store.blockTask(cwd, taskId,
        `Rollback failed — manual intervention required. Original failure: ${reason}`);
    }
  }).catch((err) => {
    store.appendTaskProgress(cwd, taskId, "system",
      `Rollback agent failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// =============================================================================
// Dual-Agent Critical Path Verification
// =============================================================================

/**
 * Compare outputs from two independent workers on a critical task.
 * Heuristic: if both mention the same set of changed files and both
 * succeeded, treat as convergent. Otherwise divergent.
 */
export function compareCriticalOutputs(
  outputA: string,
  outputB: string,
): "convergent" | "divergent" {
  // Extract file paths mentioned in each output (common patterns: src/..., lib/..., etc.)
  const filePattern = /(?:^|\s)((?:src|lib|crew|handlers|utils|test|__tests__)\/[\w/.@-]+\.\w+)/gm;
  const filesA = new Set<string>();
  const filesB = new Set<string>();

  for (const match of outputA.matchAll(filePattern)) filesA.add(match[1]);
  for (const match of outputB.matchAll(filePattern)) filesB.add(match[1]);

  // If neither mentions files, fall back to simple length/keyword similarity
  if (filesA.size === 0 && filesB.size === 0) {
    // Check if both outputs contain similar completion signals
    const donePatternA = /✅\s*DONE|status:\s*done/i.test(outputA);
    const donePatternB = /✅\s*DONE|status:\s*done/i.test(outputB);
    if (donePatternA && donePatternB) return "convergent";
    return "divergent";
  }

  // Compute Jaccard similarity on file sets
  const intersection = new Set([...filesA].filter(f => filesB.has(f)));
  const union = new Set([...filesA, ...filesB]);
  const similarity = union.size > 0 ? intersection.size / union.size : 0;

  // Threshold: if ≥50% file overlap, consider convergent
  return similarity >= 0.5 ? "convergent" : "divergent";
}

/**
 * Spawn a judge agent to adjudicate between two divergent critical-path outputs.
 */
function spawnCriticalJudge(
  taskId: string,
  taskTitle: string,
  outputA: string,
  outputB: string,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
): Promise<"ACCEPT_A" | "ACCEPT_B" | "REJECT_BOTH"> {
  const judgePrompt = [
    `## Critical Path Adjudication: ${taskId}`,
    ``,
    `### Task: ${taskTitle}`,
    ``,
    `Two independent workers attempted this critical task and produced divergent results.`,
    `Compare their approaches and determine which (if either) is correct.`,
    ``,
    `### Worker A Output (truncated):`,
    "```",
    outputA.slice(0, 3000),
    "```",
    ``,
    `### Worker B Output (truncated):`,
    "```",
    outputB.slice(0, 3000),
    "```",
    ``,
    `### Instructions:`,
    `1. Analyze both approaches`,
    `2. Determine which approach is more correct/complete`,
    `3. Output verdict: ACCEPT_A, ACCEPT_B, or REJECT_BOTH`,
    `4. Explain your reasoning`,
    ``,
    `Working directory: ${cwd}`,
  ].join("\n");

  store.appendTaskProgress(cwd, taskId, "system",
    `Critical judge spawned: two workers diverged on ${taskId}`);
  logFeedEvent(cwd, "critical-judge", "message", taskId,
    `Adjudicating divergent outputs for critical task ${taskTitle}`);

  const judgeModel = resolveModel(config.models?.reviewer);
  return spawnAgents(
    [{
      agent: "adversarial-reviewer",
      task: judgePrompt,
      taskId: `judge-${taskId}`,
      modelOverride: judgeModel,
    }],
    cwd,
    { messengerDirs: { registry: dirs.registry, inbox: dirs.inbox } },
  ).then((results) => {
    const judgeResult = results[0];
    if (!judgeResult) return "REJECT_BOTH" as const;
    const output = judgeResult.output ?? "";
    const verdict = /ACCEPT_A/i.test(output) ? "ACCEPT_A"
      : /ACCEPT_B/i.test(output) ? "ACCEPT_B"
      : "REJECT_BOTH";

    store.appendTaskProgress(cwd, taskId, "critical-judge",
      `Verdict: ${verdict}`);
    logFeedEvent(cwd, "critical-judge", verdict === "REJECT_BOTH" ? "task.reset" : "task.done",
      taskId, `Critical judge verdict: ${verdict}`);

    if (verdict === "REJECT_BOTH") {
      store.updateTask(cwd, taskId, {
        status: "todo",
        assigned_to: undefined,
        last_review: {
          verdict: "MAJOR_RETHINK",
          summary: "Both critical-path workers diverged and judge rejected both",
          issues: ["Dual-worker verification failed: neither approach accepted"],
          suggestions: [],
          reviewed_at: new Date().toISOString(),
        },
      });
    }

    return verdict;
  }).catch((err) => {
    store.appendTaskProgress(cwd, taskId, "system",
      `Critical judge failed: ${err instanceof Error ? err.message : String(err)}`);
    return "REJECT_BOTH" as const;
  });
}

/**
 * Handle dual-worker spawning and comparison for a critical task.
 * Returns the AgentResult array from both workers.
 */
async function spawnDualWorkers(
  task: import("../types.js").Task,
  prdLabel: string,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
  crewNamespace: string,
  params: CrewParams,
  primaryAgentName: string,
  otherTasks: import("../types.js").Task[],
  modelOverride: string | undefined,
  modelIdentity: string,
  waveFileClaims?: TaskFileClaim[],
): Promise<{ results: AgentResult[]; workerNames: [string, string] }> {
  const workerNameA = `${generateMemorableName()}-A`;
  const workerNameB = `${generateMemorableName()}-B`;

  // Part 2: include file reservation context for critical tasks (Bug fix: was missing)
  const fileReservationCtx = waveFileClaims
    ? buildFileReservationContext(task.id, waveFileClaims)
    : undefined;
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, otherTasks, fileReservationCtx);

  store.updateTask(cwd, task.id, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    base_commit: store.getBaseCommit(cwd),
    assigned_to: `${workerNameA},${workerNameB}`,
    model_identity: modelIdentity,
    model_identity_dual: [modelIdentity],
    attempt_count: task.attempt_count + 1,
  });

  store.appendTaskProgress(cwd, task.id, "system",
    `Critical dual-worker: assigned to ${workerNameA} and ${workerNameB} (attempt ${task.attempt_count + 1})`);
  logFeedEvent(cwd, "crew", "task.start", task.id,
    `Critical dual-worker spawn: ${workerNameA} + ${workerNameB}`);

  const taskIdNs = namespacedTaskId(task.id, crewNamespace);
  const workerTasks = [
    {
      agent: primaryAgentName,
      task: prompt,
      taskId: `${taskIdNs}-A`,
      modelOverride,
      workerName: workerNameA,
    },
    {
      agent: "crew-worker",
      task: prompt,
      taskId: `${taskIdNs}-B`,
      modelOverride,
      workerName: workerNameB,
    },
  ];

  const results = await spawnAgents(workerTasks, cwd, {
    messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
  });

  return { results, workerNames: [workerNameA, workerNameB] };
}

export async function execute(
  params: CrewParams,
  dirs: Dirs,
  ctx: ExtensionContext,
  appendEntry: AppendEntryFn,
  signal?: AbortSignal
) {
  const cwd = ctx.cwd ?? process.cwd();
  const config = loadCrewConfig(getCrewDir(cwd));
  const { autonomous, concurrency: concurrencyOverride } = params;
  const crewNamespace = resolveCrewNamespace(params);
  const sharedAutonomous = autonomous && crewNamespace === "shared";

  // Verify plan exists
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("No plan found. Create one first:\n\n  pi_messenger({ action: \"plan\" })\n  pi_messenger({ action: \"plan\", prd: \"path/to/PRD.md\" })", {
      mode: "work",
      error: "no_plan"
    });
  }

  // Check for worker agent
  const availableAgents = discoverCrewAgents(cwd);
  const hasWorker = availableAgents.some(a => a.name === "crew-worker");
  if (!hasWorker) {
    return result("Error: crew-worker agent not found. Required for task execution.", {
      mode: "work",
      error: "no_worker"
    });
  }

  store.autoCompleteMilestones(cwd);
  syncCompletedCount(cwd, crewNamespace);

  // Recover any orphaned tasks (workers that died without releasing their lease)
  const reconcileResult = await reconcileOrphanedTasks(cwd, crewNamespace);
  if (reconcileResult.reset.length > 0) {
    console.log(`[crew] reconciler reset ${reconcileResult.reset.length} orphaned task(s): ${reconcileResult.reset.join(", ")}`);
    logFeedEvent(cwd, "crew", "task.reset", reconcileResult.reset.join(","),
      `Recovered ${reconcileResult.reset.length} orphaned task(s): ${reconcileResult.reset.join(", ")}`);
  }

  // Get ready tasks — auto-block any that exceeded max attempts
  const allReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory", namespace: crewNamespace });
  const readyTasks: typeof allReady = [];
  for (const task of allReady) {
    if (task.attempt_count >= config.work.maxAttemptsPerTask) {
      store.updateTask(cwd, task.id, {
        status: "blocked",
        blocked_reason: `Max attempts (${config.work.maxAttemptsPerTask}) reached`,
      });
      store.appendTaskProgress(cwd, task.id, "system",
        `Auto-blocked after ${task.attempt_count} attempts (max: ${config.work.maxAttemptsPerTask})`);
      logFeedEvent(cwd, "crew", "task.block", task.id, `Max attempts (${config.work.maxAttemptsPerTask}) reached`);
    } else {
      readyTasks.push(task);
    }
  }

  if (readyTasks.length === 0) {
    const tasks = store.getTasks(cwd, crewNamespace);
    const inProgress = tasks.filter(t => t.status === "in_progress" || t.status === "starting");
    const pendingGateTasks = tasks.filter(t => t.status === "pending_review" || t.status === "pending_integration");
    const blocked = tasks.filter(t => t.status === "blocked");
    const done = tasks.filter(t => t.status === "done");

    let reason = "";
    if (done.length === tasks.length) {
      reason = "🎉 All tasks are done! Plan is complete.";
    } else if (pendingGateTasks.length > 0) {
      reason = `${pendingGateTasks.length} task(s) waiting on review/integration gates: ${pendingGateTasks.map(t => `${t.id} (${t.status})`).join(", ")}`;
      if (sharedAutonomous && isAutonomousForCwd(cwd)) {
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_continue", {
          prd: plan.prd,
          nextWave: autonomousState.waveNumber,
          readyTasks: [],
          pendingGateTasks: pendingGateTasks.map(t => t.id),
        });
      }
    } else if (inProgress.length > 0) {
      reason = `${inProgress.length} task(s) in progress: ${inProgress.map(t => t.id).join(", ")}`;
    } else if (blocked.length > 0) {
      reason = `${blocked.length} task(s) blocked: ${blocked.map(t => `${t.id} (${t.blocked_reason})`).join(", ")}`;
    } else {
      reason = "All remaining tasks have unmet dependencies.";
    }

    return result(`No ready tasks.

${reason}`, {
      mode: "work",
      prd: plan.prd,
      ready: [],
      reason,
      inProgress: inProgress.map(t => t.id),
      pendingGateTasks: pendingGateTasks.map(t => t.id),
      blocked: blocked.map(t => t.id)
    });
  }

  // Determine concurrency
  const requestedConcurrency = concurrencyOverride
    ?? (sharedAutonomous && isAutonomousForCwd(cwd)
      ? autonomousState.concurrency
      : config.concurrency.workers);
  autonomousState.concurrency = clampConcurrency(requestedConcurrency, config.concurrency.max);

  // If autonomous mode, set up state and persist (only on first wave or cwd change)
  if (sharedAutonomous && !isAutonomousForCwd(cwd)) {
    startAutonomous(cwd, autonomousState.concurrency, crewNamespace);
    appendEntry("crew-state", autonomousState);
  }

  // Assign tasks to lobby workers first (they're already running and warmed up)
  const prdLabel = store.getPlanLabel(plan);
  const lobbyAssigned = new Set<string>();
  const canUseLobbyWorkers = crewNamespace === "shared";
  const lobbyWorkers = canUseLobbyWorkers ? getAvailableLobbyWorkers(cwd) : [];
  for (const lobbyWorker of lobbyWorkers) {
    const task = readyTasks.find(t => !lobbyAssigned.has(t.id));
    if (!task) break;

    const currentTask = store.getTask(cwd, task.id);
    if (!currentTask || currentTask.status !== "todo" || hasActiveWorker(cwd, task.id)) {
      continue;
    }

    const others = readyTasks.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others);
    const modelIdentity = resolveStableModelIdentity({
      taskModel: currentTask.model,
      paramsModel: params.model,
      configRoleModel: config.models?.worker,
      role: "worker",
      agentName: lobbyWorker.name,
    });

    store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: lobbyWorker.name,
      model_identity: modelIdentity,
      model_identity_dual: undefined,
      attempt_count: task.attempt_count + 1,
    });
    if (!assignTaskToLobbyWorker(lobbyWorker, task.id, prompt, dirs.inbox)) {
      store.updateTask(cwd, task.id, { status: "todo", assigned_to: undefined, model_identity: undefined, model_identity_dual: undefined });
      continue;
    }
    store.appendTaskProgress(cwd, task.id, "system", `Assigned to lobby worker ${lobbyWorker.name} (attempt ${task.attempt_count + 1})`);
    logFeedEvent(cwd, lobbyWorker.name, "task.start", task.id, task.title);
    lobbyAssigned.add(task.id);
  }
  if (canUseLobbyWorkers) {
    cleanupUnassignedAliveFiles(cwd);
  }

  // Build prompts for remaining tasks — spawnAgents throttles via autonomousState.concurrency
  const remainingTasks = readyTasks.filter(t => !lobbyAssigned.has(t.id));

  // === Part 1: File Overlap Detection — serialize tasks that touch the same files ===
  // Extract file paths from each task's spec to detect concurrent write conflicts.
  // Tasks that overlap with a higher-priority (earlier) task are deferred to the
  // next wave — this prevents the 16-19 attempt loops caused by concurrent writes.
  //
  // IMPORTANT: Lobby-assigned tasks are already dispatched — their file claims must
  // be included FIRST in the combined spec map so remainingTasks that overlap with
  // lobby tasks are correctly deferred (Bug fix: lobby bypass).
  const allCandidateTasks = [
    ...readyTasks.filter(t => lobbyAssigned.has(t.id)), // lobby tasks first (already claimed)
    ...remainingTasks,
  ];
  const allCandidateSpecMap = new Map<string, string>();
  for (const task of allCandidateTasks) {
    allCandidateSpecMap.set(task.id, store.getTaskSpec(cwd, task.id) ?? "");
  }

  // Run serialization over all candidates; lobby tasks (listed first) win file conflicts
  const { dispatch: dispatchTaskIds, defer: deferredTaskIds, overlapLog } =
    serializeOverlappingTasks(allCandidateTasks, allCandidateSpecMap);

  if (deferredTaskIds.length > 0) {
    for (const entry of overlapLog) {
      // Only log progress for non-lobby deferred tasks (lobby tasks are already in-progress)
      if (!lobbyAssigned.has(entry.deferredTaskId)) {
        const deferReason = `File overlap: shares [${entry.conflictingFiles.join(", ")}] with ${entry.conflictsWith.join(", ")} — deferred to next wave to prevent concurrent write conflicts`;
        store.appendTaskProgress(cwd, entry.deferredTaskId, "system", deferReason);
        logFeedEvent(cwd, "crew", "message", entry.deferredTaskId,
          `⏸ Deferred (file overlap): ${entry.conflictingFiles.slice(0, 3).join(", ")}${entry.conflictingFiles.length > 3 ? ` +${entry.conflictingFiles.length - 3} more` : ""}`);
      }
    }
  }

  const dispatchSet = new Set(dispatchTaskIds);
  // Only filter remainingTasks (not lobby tasks — they're already dispatched)
  const remainingTasksFiltered = remainingTasks.filter(t => dispatchSet.has(t.id));

  // Build file claims for all dispatched tasks — includes lobby tasks so worker
  // prompts show complete reservation picture across all concurrent workers (Part 2).
  const waveFileClaims: TaskFileClaim[] = buildFileClaims(
    allCandidateTasks.filter(t => dispatchSet.has(t.id)),
    allCandidateSpecMap,
  );
  // =============================================================================

  const pendingAssignments: Array<{
    task: typeof remainingTasks[number];
    workerName: string;
    agentName: string;
    routedRole: CrewRole;
    modelOverride: string | undefined;
    modelIdentity: string;
  }> = [];

  for (const task of remainingTasksFiltered) {
    const currentTask = store.getTask(cwd, task.id);
    const namespacedId = namespacedTaskId(task.id, crewNamespace);
    if (!currentTask || currentTask.status !== "todo" || hasActiveWorker(cwd, namespacedId)) continue;

    const workerName = generateMemorableName();

    const preferredRole = (currentTask as { preferred_role?: string; crew_role?: string; role?: string }).preferred_role
      ?? (currentTask as { preferred_role?: string; crew_role?: string; role?: string }).crew_role
      ?? (currentTask as { preferred_role?: string; crew_role?: string; role?: string }).role;
    const spec = store.getTaskSpec(cwd, task.id) ?? "";
    const routedRole = classifyTaskToFeynmanRole(task.title, spec, preferredRole);
    const routedAgent = selectCrewAgentForRole(availableAgents, routedRole);
    const agentName = routedAgent?.name ?? "crew-worker";
    const modelOverride = resolveModelForTaskRole(
      routedRole,
      task.model,
      params.model,
      config.models,
      routedAgent?.model,
    );
    const modelIdentity = resolveStableModelIdentity({
      modelOverride,
      taskModel: task.model,
      paramsModel: params.model,
      configRoleModel: config.models?.[routedRole],
      agentModel: routedAgent?.model,
      role: routedRole,
      agentName,
    });

    const updatedTask = store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: workerName,
      model_identity: modelIdentity,
      model_identity_dual: undefined,
      attempt_count: currentTask.attempt_count + 1,
    });
    if (!updatedTask) continue;

    pendingAssignments.push({
      task: currentTask,
      workerName,
      agentName,
      routedRole,
      modelOverride,
      modelIdentity,
    });
    store.appendTaskProgress(cwd, task.id, "system", `Assigned to ${workerName} via ${agentName} [${routedRole}] (attempt ${currentTask.attempt_count + 1}, identity=${modelIdentity})`);
  }

  // Separate critical tasks for dual-worker verification
  const criticalAssignments = pendingAssignments.filter(a => {
    const freshTask = store.getTask(cwd, a.task.id);
    return freshTask?.critical === true;
  });
  const normalAssignments = pendingAssignments.filter(a => {
    const freshTask = store.getTask(cwd, a.task.id);
    return freshTask?.critical !== true;
  });

  type CriticalTaskOutcome = {
    taskId: string;
    hadRuntimeFailure: boolean;
    wasGracefullyShutdown: boolean;
  };

  // Spawn dual workers for critical tasks (async, processed after normal workers)
  const criticalPromises: Promise<CriticalTaskOutcome>[] = [];
  for (const assignment of criticalAssignments) {
    const { task: assignedTask, agentName, modelOverride, modelIdentity } = assignment;
    const freshTask = store.getTask(cwd, assignedTask.id);
    if (!freshTask) continue;

    const others = pendingAssignments.map(a => a.task).filter(o => o.id !== assignedTask.id);
    const promise = spawnDualWorkers(
      freshTask, prdLabel, cwd, config, dirs, crewNamespace, params, agentName, others, modelOverride, modelIdentity, waveFileClaims,
    ).then(({ results: dualResults, workerNames }) => {
      const [resultA, resultB] = dualResults;
      const outputA = resultA?.output ?? "";
      const outputB = resultB?.output ?? "";
      const bothSucceeded = resultA?.exitCode === 0 && resultB?.exitCode === 0;
      const hadRuntimeFailure = !bothSucceeded;
      const wasGracefullyShutdown = Boolean(resultA?.wasGracefullyShutdown || resultB?.wasGracefullyShutdown);

      if (bothSucceeded) {
        const comparison = compareCriticalOutputs(outputA, outputB);
        store.appendTaskProgress(cwd, assignedTask.id, "system",
          `Critical comparison: ${comparison} (workers: ${workerNames.join(", ")})`);

        if (comparison === "convergent") {
          // Accept — the task should already be marked done by the worker
          logFeedEvent(cwd, "crew", "message", assignedTask.id,
            `Critical dual-verification: CONVERGENT ✅`);
        } else {
          // Divergent — spawn judge
          logFeedEvent(cwd, "crew", "message", assignedTask.id,
            `Critical dual-verification: DIVERGENT — spawning judge`);
          return spawnCriticalJudge(assignedTask.id, assignedTask.title, outputA, outputB, cwd, config, dirs)
            .then(() => ({ taskId: assignedTask.id, hadRuntimeFailure, wasGracefullyShutdown }));
        }
      } else {
        // One or both failed — log and let normal failure handling apply
        store.appendTaskProgress(cwd, assignedTask.id, "system",
          `Critical dual-worker: not both succeeded (A=${resultA?.exitCode}, B=${resultB?.exitCode})`);
      }

      return { taskId: assignedTask.id, hadRuntimeFailure, wasGracefullyShutdown };
    }).catch((err) => {
      store.appendTaskProgress(cwd, assignedTask.id, "system",
        `Critical dual-worker spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        taskId: assignedTask.id,
        hadRuntimeFailure: true,
        wasGracefullyShutdown: false,
      };
    });
    criticalPromises.push(promise);
  }

  const workerTasks = normalAssignments.map(({ task, workerName, agentName, modelOverride }) => {
    const others = pendingAssignments.map(assignment => assignment.task).filter(other => other.id !== task.id);
    // Part 2: Build file reservation context for this worker's prompt
    const fileReservationCtx = buildFileReservationContext(task.id, waveFileClaims);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, fileReservationCtx);

    return {
      agent: agentName,
      task: prompt,
      taskId: namespacedTaskId(task.id, crewNamespace),
      modelOverride,
      workerName,
    };
  });

  // Include critical task IDs in attempted list
  const criticalTaskIds = criticalAssignments.map(a => a.task.id);

  const attemptedTaskIds = workerTasks
    .map(workerTask => fromNamespacedTaskId(workerTask.taskId, crewNamespace))
    .filter((taskId): taskId is string => !!taskId);
  attemptedTaskIds.push(...criticalTaskIds);

  // Await critical dual-worker tasks in parallel with normal workers
  const [workerResults, criticalOutcomes] = await Promise.all([
    workerTasks.length > 0
    ? spawnAgents(
        workerTasks,
        cwd,
        {
          signal,
          messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
        }
      )
    : Promise.resolve([] as AgentResult[]),
    Promise.all(criticalPromises),
  ]);

  // Process results
  const succeeded: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];

  for (let i = 0; i < workerResults.length; i++) {
    const r = workerResults[i];
    const taskId = fromNamespacedTaskId(r.taskId, crewNamespace);
    if (!taskId) {
      failed.push(`unknown-result-${i}`);
      continue;
    }
    const task = store.getTask(cwd, taskId);

    const completedOrGraceful = r.exitCode === 0 || r.wasGracefullyShutdown;

    if (completedOrGraceful) {
      if (task?.status === "done") {
        import("../utils/checkpoint.js").then(({ createCheckpoint }) => {
          createCheckpoint(cwd, taskId, "post", `post: ${task.title}`);
        }).catch(() => {});
        succeeded.push(taskId);
      } else if (task?.status === "pending_review") {
        const acceptance = await finalizePendingAcceptance(task, cwd, config, dirs);
        if (acceptance === "succeeded") {
          import("../utils/checkpoint.js").then(({ createCheckpoint }) => {
            createCheckpoint(cwd, taskId, "post", `post: ${task.title}`);
          }).catch(() => {});
          succeeded.push(taskId);
        } else if (acceptance === "blocked") {
          blocked.push(taskId);
        } else {
          failed.push(taskId);
        }
      } else if (task?.status === "blocked") {
        blocked.push(taskId);
      } else if (task?.status === "in_progress") {
        store.appendTaskProgress(cwd, taskId, "system",
          r.wasGracefullyShutdown ? "Task interrupted (shutdown), reset to todo" : "Worker exited without completing task, reset to todo");
        store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined, model_identity: undefined, model_identity_dual: undefined });
        failed.push(taskId);
      } else {
        failed.push(taskId);
      }
      continue;
    }

    if (sharedAutonomous && task?.status === "in_progress") {
      store.appendTaskProgress(cwd, taskId, "system", `Worker crashed: ${r.error ?? "Unknown error"}`);
      store.blockTask(cwd, taskId, `Worker failed: ${r.error ?? "Unknown error"}`);
      blocked.push(taskId);
    } else {
      if (task?.status === "in_progress") {
        store.appendTaskProgress(cwd, taskId, "system", `Worker failed: ${r.error ?? "Unknown error"}`);
      }
      failed.push(taskId);
    }
  }

  // Fold critical-task outcomes into wave accounting/state transitions
  for (const outcome of criticalOutcomes) {
    const taskId = outcome.taskId;
    const task = store.getTask(cwd, taskId);

    if (task?.status === "done") {
      succeeded.push(taskId);
    } else if (task?.status === "pending_review") {
      const acceptance = await finalizePendingAcceptance(task, cwd, config, dirs);
      if (acceptance === "succeeded") succeeded.push(taskId);
      else if (acceptance === "blocked") blocked.push(taskId);
      else failed.push(taskId);
    } else if (task?.status === "blocked") {
      blocked.push(taskId);
    } else if (task?.status === "in_progress") {
      const interruptionMessage = outcome.wasGracefullyShutdown
        ? "Critical task interrupted (shutdown), reset to todo"
        : outcome.hadRuntimeFailure
          ? "Critical dual-worker failed before completion, reset to todo"
          : "Critical task exited without final completion, reset to todo";
      store.appendTaskProgress(cwd, taskId, "system", interruptionMessage);
      store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined, model_identity: undefined, model_identity_dual: undefined });
      failed.push(taskId);
    } else {
      failed.push(taskId);
    }
  }

  syncCompletedCount(cwd, crewNamespace);

  // Record specialization outcomes for completed/failed tasks
  for (const taskId of [...succeeded, ...failed]) {
    const task = store.getTask(cwd, taskId);
    if (task) {
      const spec = store.getTaskSpec(cwd, taskId) ?? "";
      const taskType = classifyTask(task.title, spec);
      const duration = task.started_at
        ? Date.now() - new Date(task.started_at).getTime()
        : 0;
      const modelUsed = task.model_identity ?? task.assigned_to ?? "unknown";
      recordTaskOutcome(modelUsed, taskType, succeeded.includes(taskId), duration);
    }
  }

  // Clear heartbeats for completed/failed/blocked tasks
  for (const taskId of [...succeeded, ...failed, ...blocked]) {
    const task = store.getTask(cwd, taskId);
    if (task?.assigned_to) {
      clearHeartbeat(cwd, task.assigned_to, taskId);
    }
  }

  // Check for stale agent heartbeats
  checkStaleHeartbeats(cwd);

  // Save current wave number BEFORE addWaveResult increments it
  const currentWave = sharedAutonomous ? autonomousState.waveNumber : 1;
  
  if (sharedAutonomous) {
    addWaveResult({
      waveNumber: currentWave,
      tasksAttempted: attemptedTaskIds,
      succeeded,
      failed,
      blocked,
      timestamp: new Date().toISOString()
    });

    if (signal?.aborted) {
      stopAutonomous("manual");
      appendEntry("crew-state", autonomousState);
    } else {
      const nextReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory", namespace: crewNamespace });
      const allTasks = store.getTasks(cwd, crewNamespace);
      const allDone = allTasks.every(t => t.status === "done");
      const allBlockedOrDone = allTasks.every(t => t.status === "done" || t.status === "blocked");
      const pendingGates = allTasks.filter(t => t.status === "pending_review" || t.status === "pending_integration");

      if (allDone) {
        stopAutonomous("completed");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_complete", {
          prd: plan.prd,
          status: "completed",
          totalWaves: currentWave,
          totalTasks: allTasks.length
        });
      } else if (pendingGates.length > 0) {
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_continue", {
          prd: plan.prd,
          nextWave: autonomousState.waveNumber,
          readyTasks: nextReady.map(t => t.id),
          pendingGateTasks: pendingGates.map(t => t.id)
        });
      } else if (allBlockedOrDone || nextReady.length === 0) {
        stopAutonomous("blocked");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_blocked", {
          prd: plan.prd,
          status: "blocked",
          blockedTasks: allTasks.filter(t => t.status === "blocked").map(t => t.id)
        });
      } else {
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_continue", {
          prd: plan.prd,
          nextWave: autonomousState.waveNumber,
          readyTasks: nextReady.map(t => t.id)
        });
      }
    }
  }

  // Check for conflicts among succeeded tasks in this wave
  let conflictText = "";
  if (succeeded.length >= 2) {
    try {
      const conflicts = checkWaveConflicts(cwd, succeeded);
      const detected = conflicts.filter(c => c.hasConflict);
      if (detected.length > 0) {
        const conflictSummaries = detected.map(c =>
          `⚠️ Conflict: ${c.taskA} ↔ ${c.taskB} on ${c.conflictingFiles.join(", ")} (${c.overlappingHunks.length} overlapping hunk(s))`
        );
        conflictText = "\n" + conflictSummaries.join("\n");

        // Log conflict events to feed
        for (const c of detected) {
          logFeedEvent(cwd, "conflict-detector", "message", c.taskA,
            `⚠️ Conflict with ${c.taskB} on ${c.conflictingFiles.join(", ")}`);
          appendEntry("crew_conflict_detected", {
            taskA: c.taskA,
            taskB: c.taskB,
            files: c.conflictingFiles,
            hunks: c.overlappingHunks.length,
          });
        }
      }
    } catch {
      // Conflict detection is best-effort — don't block the wave
    }
  }

  // Build result
  const updatedPlan = store.getPlan(cwd);
  const progress = updatedPlan 
    ? `${updatedPlan.completed_count}/${updatedPlan.task_count}`
    : "unknown";

  let statusText = "";
  if (succeeded.length > 0) statusText += `\n✅ Completed: ${succeeded.join(", ")}`;
  if (failed.length > 0) statusText += `\n❌ Failed: ${failed.join(", ")}`;
  if (blocked.length > 0) statusText += `\n🚫 Blocked: ${blocked.join(", ")}`;

  const nextReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const nextText = nextReady.length > 0
    ? `\n\n**Ready for next wave:** ${nextReady.map(t => t.id).join(", ")}`
    : "";
  const continueText = sharedAutonomous && !signal?.aborted && nextReady.length > 0
    ? "Autonomous mode: Continuing to next wave..."
    : signal?.aborted && sharedAutonomous
      ? "Autonomous mode stopped (cancelled)."
      : "";

  const lobbyText = lobbyAssigned.size > 0
    ? `\n🏢 Lobby workers assigned: ${Array.from(lobbyAssigned).join(", ")}`
    : "";

  const text = `# Work Wave ${currentWave}

**PRD:** ${store.getPlanLabel(plan)}
**Tasks attempted:** ${attemptedTaskIds.length}${lobbyAssigned.size > 0 ? ` (+${lobbyAssigned.size} lobby)` : ""}
**Progress:** ${progress}
${statusText}${conflictText}${lobbyText}${nextText}

${continueText}`;

  return result(text, {
    mode: "work",
    prd: plan.prd,
    wave: currentWave,
    attempted: attemptedTaskIds,
    succeeded,
    failed,
    blocked,
    nextReady: nextReady.map(t => t.id),
    autonomous: !!sharedAutonomous
  });
}

function syncCompletedCount(cwd: string, crewNamespace = "shared"): void {
  const plan = store.getPlan(cwd);
  if (!plan) return;
  const doneCount = store.getTasks(cwd, crewNamespace).filter(t => t.status === "done").length;
  if (plan.completed_count !== doneCount) {
    store.updatePlan(cwd, { completed_count: doneCount });
  }
}
