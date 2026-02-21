/**
 * Crew - Work Handler
 * 
 * Spawns workers for ready tasks with concurrency control.
 * Simplified: works on current plan's tasks
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Dirs } from "../../lib.js";
import type { CrewParams, AppendEntryFn } from "../types.js";
import { result } from "../utils/result.js";
import { resolveModel, spawnAgents } from "../agents.js";
import { loadCrewConfig } from "../utils/config.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { buildWorkerPrompt } from "../prompt.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";
import { autonomousState, isAutonomousForCwd, startAutonomous, stopAutonomous, addWaveResult, clampConcurrency } from "../state.js";
import { getAvailableLobbyWorkers, assignTaskToLobbyWorker, cleanupUnassignedAliveFiles } from "../lobby.js";
import { logFeedEvent } from "../../feed.js";

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
  syncCompletedCount(cwd);

  // Get ready tasks — auto-block any that exceeded max attempts
  const allReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
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
    const tasks = store.getTasks(cwd);
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
    ?? (autonomous && isAutonomousForCwd(cwd)
      ? autonomousState.concurrency
      : config.concurrency.workers);
  autonomousState.concurrency = clampConcurrency(requestedConcurrency, config.concurrency.max);

  // If autonomous mode, set up state and persist (only on first wave or cwd change)
  if (autonomous && !isAutonomousForCwd(cwd)) {
    startAutonomous(cwd, autonomousState.concurrency);
    appendEntry("crew-state", autonomousState);
  }

  // Assign tasks to lobby workers first (they're already running and warmed up)
  const prdLabel = store.getPlanLabel(plan);
  const lobbyAssigned = new Set<string>();
  const lobbyWorkers = getAvailableLobbyWorkers(cwd);
  for (const lobbyWorker of lobbyWorkers) {
    const task = readyTasks.find(t => !lobbyAssigned.has(t.id));
    if (!task) break;

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
  cleanupUnassignedAliveFiles(cwd);

  // Build prompts for remaining tasks — spawnAgents throttles via autonomousState.concurrency
  const remainingTasks = readyTasks.filter(t => !lobbyAssigned.has(t.id));
  const workerTasks = remainingTasks.map(task => {
    const taskModel = resolveModel(
      task.model,
      params.model,
      config.models?.worker,
    );
    const others = readyTasks.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others);
    store.appendTaskProgress(cwd, task.id, "system", `Assigned to crew-worker (attempt ${task.attempt_count + 1})`);

    return {
      agent: "crew-worker",
      task: prompt,
      taskId: task.id,
      modelOverride: taskModel,
    };
  });

  const workerResults = await spawnAgents(
    workerTasks,
    cwd,
    {
      signal,
      messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
    }
  );

  // Process results
  const succeeded: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];

  for (let i = 0; i < workerResults.length; i++) {
    const r = workerResults[i];
    const taskId = r.taskId;
    if (!taskId) {
      failed.push(`unknown-result-${i}`);
      continue;
    }
    const task = store.getTask(cwd, taskId);

    if (r.exitCode === 0) {
      if (task?.status === "done") {
        succeeded.push(taskId);
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
        } else if (task?.status === "blocked") {
          blocked.push(taskId);
        } else if (task?.status === "in_progress") {
          store.appendTaskProgress(cwd, taskId, "system", "Task interrupted (shutdown), reset to todo");
          store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
          failed.push(taskId);
        } else {
          failed.push(taskId);
        }
      } else if (autonomous && task?.status === "in_progress") {
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

  syncCompletedCount(cwd);

  // Save current wave number BEFORE addWaveResult increments it
  const currentWave = autonomous ? autonomousState.waveNumber : 1;
  
  if (autonomous) {
    addWaveResult({
      waveNumber: currentWave,
      tasksAttempted: remainingTasks.map(t => t.id),
      succeeded,
      failed,
      blocked,
      timestamp: new Date().toISOString()
    });

    if (signal?.aborted) {
      stopAutonomous("manual");
      appendEntry("crew-state", autonomousState);
    } else {
      const nextReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
      const allTasks = store.getTasks(cwd);
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
  const continueText = autonomous && !signal?.aborted && nextReady.length > 0
    ? "Autonomous mode: Continuing to next wave..."
    : signal?.aborted && autonomous
      ? "Autonomous mode stopped (cancelled)."
      : "";

  const lobbyText = lobbyAssigned.size > 0
    ? `\n🏢 Lobby workers assigned: ${Array.from(lobbyAssigned).join(", ")}`
    : "";

  const text = `# Work Wave ${currentWave}

**PRD:** ${store.getPlanLabel(plan)}
**Tasks attempted:** ${remainingTasks.length}${lobbyAssigned.size > 0 ? ` (+${lobbyAssigned.size} lobby)` : ""}
**Progress:** ${progress}
${statusText}${lobbyText}${nextText}

${continueText}`;

  return result(text, {
    mode: "work",
    prd: plan.prd,
    wave: currentWave,
    attempted: remainingTasks.map(t => t.id),
    succeeded,
    failed,
    blocked,
    nextReady: nextReady.map(t => t.id),
    autonomous: !!autonomous
  });
}

function syncCompletedCount(cwd: string): void {
  const plan = store.getPlan(cwd);
  if (!plan) return;
  const doneCount = store.getTasks(cwd).filter(t => t.status === "done").length;
  if (plan.completed_count !== doneCount) {
    store.updatePlan(cwd, { completed_count: doneCount });
  }
}

