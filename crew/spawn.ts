/**
 * Crew - Worker Spawning Helpers
 *
 * Shared logic for spawning workers and assigning tasks,
 * used by both the overlay and the work handler.
 */

import { join } from "node:path";
import * as store from "./store.js";
import { loadCrewConfig } from "./utils/config.js";
import { buildWorkerPrompt } from "./prompt.js";
import { logFeedEvent } from "../feed.js";
import {
  spawnWorkerForTask,
  getAvailableLobbyWorkers,
  assignTaskToLobbyWorker,
} from "./lobby.js";

export interface SpawnResult {
  assigned: number;
  firstWorkerName: string | null;
}

export function spawnWorkersForReadyTasks(
  cwd: string,
  maxWorkers: number,
): SpawnResult {
  const plan = store.getPlan(cwd);
  if (!plan) return { assigned: 0, firstWorkerName: null };

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  const prdLabel = store.getPlanLabel(plan);
  const inboxDir = join(cwd, ".pi", "messenger", "inbox");

  let assigned = 0;
  let firstWorkerName: string | null = null;

  const lobby = getAvailableLobbyWorkers(cwd);
  for (const lw of lobby) {
    if (assigned >= maxWorkers) break;
    const fresh = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
    if (fresh.length === 0) break;

    const task = fresh[0];
    const others = fresh.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others);

    store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: lw.name,
      attempt_count: task.attempt_count + 1,
    });

    if (!assignTaskToLobbyWorker(lw, task.id, prompt, inboxDir)) {
      store.updateTask(cwd, task.id, { status: "todo", assigned_to: undefined });
      continue;
    }

    store.appendTaskProgress(cwd, task.id, "system", `Assigned to lobby worker ${lw.name} (attempt ${task.attempt_count + 1})`);
    logFeedEvent(cwd, lw.name, "task.start", task.id, task.title);
    if (!firstWorkerName) firstWorkerName = lw.name;
    assigned++;
  }

  while (assigned < maxWorkers) {
    const fresh = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
    if (fresh.length === 0) break;

    const task = fresh[0];
    const others = fresh.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others);
    const worker = spawnWorkerForTask(cwd, task.id, prompt);
    if (!worker) break;

    if (!firstWorkerName) firstWorkerName = worker.name;
    assigned++;
  }

  return { assigned, firstWorkerName };
}

export function spawnSingleWorker(
  cwd: string,
  taskId: string,
): { name: string } | null {
  const plan = store.getPlan(cwd);
  if (!plan) return null;

  const task = store.getTask(cwd, taskId);
  if (!task) return null;

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  const prdLabel = store.getPlanLabel(plan);
  const readyTasks = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const others = readyTasks.filter(t => t.id !== task.id);
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others);
  const worker = spawnWorkerForTask(cwd, taskId, prompt);
  return worker ? { name: worker.name } : null;
}
