/**
 * Crew - Work Handler
 * 
 * Spawns workers for ready tasks with concurrency control.
 * Simplified: works on current plan's tasks
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { generateMemorableName, type Dirs } from "../../lib.js";
import type { CrewParams, AppendEntryFn } from "../types.js";
import { result } from "../utils/result.js";
import { resolveModel, spawnAgents } from "../agents.js";
import { loadCrewConfig } from "../utils/config.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { buildWorkerPrompt } from "../prompt.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";
import { hasActiveWorker } from "../registry.js";
import { autonomousState, isAutonomousForCwd, startAutonomous, stopAutonomous, addWaveResult, clampConcurrency } from "../state.js";
import { getAvailableLobbyWorkers, assignTaskToLobbyWorker, cleanupUnassignedAliveFiles } from "../lobby.js";
import { logFeedEvent } from "../../feed.js";
import { clearHeartbeat } from "../heartbeat.js";
import { checkStaleHeartbeats } from "../lobby.js";

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


/**
 * Spawn an adversarial reviewer for a completed task (async/non-blocking).
 * The reviewer examines the task diff and spec, producing an APPROVE/REJECT verdict.
 * If rejected, the task is reset to "todo" with reviewer feedback in progress.
 */
function spawnAdversarialReview(
  taskId: string,
  taskTitle: string,
  taskSummary: string | undefined,
  baseCommit: string | undefined,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
): void {
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

  // Spawn asynchronously — do not await
  const reviewModel = resolveModel(config.models?.reviewer);
  spawnAgents(
    [{
      agent: "adversarial-reviewer",
      task: reviewPrompt,
      taskId: `review-${taskId}`,
      modelOverride: reviewModel,
    }],
    cwd,
    { messengerDirs: { registry: dirs.registry, inbox: dirs.inbox } },
  ).then((results) => {
    const reviewResult = results[0];
    if (!reviewResult) return;

    const output = reviewResult.output ?? "";
    const isRejected = /## Verdict:\s*REJECT/i.test(output);

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

      store.updateTask(cwd, taskId, {
        status: "todo",
        assigned_to: undefined,
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
    }
  }).catch((err) => {
    store.appendTaskProgress(cwd, taskId, "system",
      `Adversarial review failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Spawn an integration tester for a completed task (async/non-blocking).
 * Runs test suite, linting, and type-checking. If any check fails, the task
 * is blocked with failure details.
 */
function spawnIntegrationTest(
  taskId: string,
  taskTitle: string,
  baseCommit: string | undefined,
  cwd: string,
  config: ReturnType<typeof loadCrewConfig>,
  dirs: Dirs,
): void {
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

  // Spawn asynchronously — do not await
  const testModel = resolveModel(config.models?.reviewer);
  spawnAgents(
    [{
      agent: "integration-tester",
      task: testPrompt,
      taskId: `integration-${taskId}`,
      modelOverride: testModel,
    }],
    cwd,
    { messengerDirs: { registry: dirs.registry, inbox: dirs.inbox } },
  ).then((results) => {
    const testResult = results[0];
    if (!testResult) return;

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
    }
  }).catch((err) => {
    store.appendTaskProgress(cwd, taskId, "system",
      `Integration test failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
  });
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
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const blocked = tasks.filter(t => t.status === "blocked");
    const done = tasks.filter(t => t.status === "done");

    let reason = "";
    if (done.length === tasks.length) {
      reason = "🎉 All tasks are done! Plan is complete.";
    } else if (inProgress.length > 0) {
      reason = `${inProgress.length} task(s) in progress: ${inProgress.map(t => t.id).join(", ")}`;
    } else if (blocked.length > 0) {
      reason = `${blocked.length} task(s) blocked: ${blocked.map(t => `${t.id} (${t.blocked_reason})`).join(", ")}`;
    } else {
      reason = "All remaining tasks have unmet dependencies.";
    }

    return result(`No ready tasks.\n\n${reason}`, {
      mode: "work",
      prd: plan.prd,
      ready: [],
      reason,
      inProgress: inProgress.map(t => t.id),
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
    startAutonomous(cwd, autonomousState.concurrency);
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
    store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: lobbyWorker.name,
      attempt_count: task.attempt_count + 1,
    });
    if (!assignTaskToLobbyWorker(lobbyWorker, task.id, prompt, dirs.inbox)) {
      store.updateTask(cwd, task.id, { status: "todo", assigned_to: undefined });
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
  const pendingAssignments: Array<{
    task: typeof remainingTasks[number];
    workerName: string;
    modelOverride: string | undefined;
  }> = [];

  for (const task of remainingTasks) {
    const currentTask = store.getTask(cwd, task.id);
    const namespacedId = namespacedTaskId(task.id, crewNamespace);
    if (!currentTask || currentTask.status !== "todo" || hasActiveWorker(cwd, namespacedId)) continue;

    const workerName = generateMemorableName();
    const updatedTask = store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: workerName,
      attempt_count: currentTask.attempt_count + 1,
    });
    if (!updatedTask) continue;

    pendingAssignments.push({
      task: currentTask,
      workerName,
      modelOverride: resolveModel(
        task.model,
        params.model,
        config.models?.worker,
      ),
    });
    store.appendTaskProgress(cwd, task.id, "system", `Assigned to ${workerName} via crew-worker (attempt ${currentTask.attempt_count + 1})`);
  }

  const workerTasks = pendingAssignments.map(({ task, workerName, modelOverride }) => {
    const others = pendingAssignments.map(assignment => assignment.task).filter(other => other.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others);

    return {
      agent: "crew-worker",
      task: prompt,
      taskId: namespacedTaskId(task.id, crewNamespace),
      modelOverride,
      workerName,
    };
  });

  const attemptedTaskIds = workerTasks
    .map(workerTask => fromNamespacedTaskId(workerTask.taskId, crewNamespace))
    .filter((taskId): taskId is string => !!taskId);

  const workerResults = workerTasks.length > 0
    ? await spawnAgents(
        workerTasks,
        cwd,
        {
          signal,
          messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
        }
      )
    : [];

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

    if (r.exitCode === 0) {
      if (task?.status === "done") {
        // Create post-task checkpoint for rollback (async, best-effort)
        import("../utils/checkpoint.js").then(({ createCheckpoint }) => {
          createCheckpoint(cwd, taskId, "post", `post: ${task.title}`);
        }).catch(() => {});
        succeeded.push(taskId);

        // Post-completion adversarial review (async/non-blocking)
        if (config.review?.autoAdversarial !== false && task) {
          spawnAdversarialReview(taskId, task.title, task.summary, task.base_commit, cwd, config, dirs);
        }
        // Post-completion integration test (async/non-blocking)
        if (config.review?.autoIntegrationTest !== false && task) {
          spawnIntegrationTest(taskId, task.title, task.base_commit, cwd, config, dirs);
        }
      } else if (task?.status === "blocked") {
        blocked.push(taskId);
      } else if (task?.status === "in_progress") {
        store.appendTaskProgress(cwd, taskId, "system",
          r.wasGracefullyShutdown ? "Task interrupted (shutdown), reset to todo" : "Worker exited without completing task, reset to todo");
        store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
        failed.push(taskId);
      } else {
        failed.push(taskId);
      }
    } else {
      if (r.wasGracefullyShutdown) {
        if (task?.status === "done") {
          succeeded.push(taskId);
          // Post-completion adversarial review (async/non-blocking)
          if (config.review?.autoAdversarial !== false && task) {
            spawnAdversarialReview(taskId, task.title, task.summary, task.base_commit, cwd, config, dirs);
          }
          // Post-completion integration test (async/non-blocking)
          if (config.review?.autoIntegrationTest !== false && task) {
            spawnIntegrationTest(taskId, task.title, task.base_commit, cwd, config, dirs);
          }
        } else if (task?.status === "blocked") {
          blocked.push(taskId);
        } else if (task?.status === "in_progress") {
          store.appendTaskProgress(cwd, taskId, "system", "Task interrupted (shutdown), reset to todo");
          store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
          failed.push(taskId);
        } else {
          failed.push(taskId);
        }
      } else if (sharedAutonomous && task?.status === "in_progress") {
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
  }

  syncCompletedCount(cwd, crewNamespace);

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

      if (allDone) {
        stopAutonomous("completed");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_complete", {
          prd: plan.prd,
          status: "completed",
          totalWaves: currentWave,
          totalTasks: allTasks.length
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
${statusText}${lobbyText}${nextText}

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
