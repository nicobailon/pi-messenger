/**
 * Crew - Unified Worker Registry
 *
 * Single registry for both regular workers and lobby workers.
 * Replaces the separate maps in agents.ts and lobby.ts.
 */

import type { ChildProcess } from "node:child_process";
import type { CoordinationLevel } from "./utils/config.js";

interface BaseWorkerEntry {
  proc: ChildProcess;
  name: string;
  cwd: string;
  taskId: string;
}

export interface RegularWorker extends BaseWorkerEntry {
  type: "worker";
}

export interface LobbyWorkerEntry extends BaseWorkerEntry {
  type: "lobby";
  lobbyId: string;
  assignedTaskId: string | null;
  coordination: CoordinationLevel;
  startedAt: number;
  promptTmpDir: string | null;
  aliveFile: string | null;
}

export type WorkerEntry = RegularWorker | LobbyWorkerEntry;

const workers = new Map<string, WorkerEntry>();

function makeKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

export function registerWorker(entry: WorkerEntry): void {
  workers.set(makeKey(entry.cwd, entry.taskId), entry);
}

export function unregisterWorker(cwd: string, taskId: string): void {
  workers.delete(makeKey(cwd, taskId));
}

export function findWorkerByTask(cwd: string, taskId: string): WorkerEntry | null {
  const direct = workers.get(makeKey(cwd, taskId));
  if (direct) return direct;
  for (const entry of workers.values()) {
    if (entry.cwd !== cwd) continue;
    if (entry.type === "lobby" && entry.assignedTaskId === taskId) return entry;
  }
  return null;
}

export function hasActiveWorker(cwd: string, taskId: string): boolean {
  const entry = findWorkerByTask(cwd, taskId);
  if (!entry) return false;
  return entry.proc.exitCode === null && !entry.proc.killed;
}

export function killWorkerByTask(cwd: string, taskId: string): boolean {
  const entry = findWorkerByTask(cwd, taskId);
  if (!entry) return false;
  if (entry.proc.exitCode === null && !entry.proc.killed) {
    entry.proc.kill("SIGTERM");
    const ref = entry.proc;
    const timer = setTimeout(() => {
      if (ref.exitCode === null) ref.kill("SIGKILL");
    }, 5000);
    timer.unref();
    return true;
  }
  return false;
}

export function killAll(cwd?: string): void {
  for (const [key, entry] of workers.entries()) {
    if (cwd && entry.cwd !== cwd) continue;
    if (entry.proc.exitCode === null && !entry.proc.killed) {
      entry.proc.kill("SIGTERM");
    }
    workers.delete(key);
  }
}

export function getLobbyWorkers(cwd: string): LobbyWorkerEntry[] {
  const result: LobbyWorkerEntry[] = [];
  for (const entry of workers.values()) {
    if (entry.cwd === cwd && entry.type === "lobby") result.push(entry);
  }
  return result;
}

export function getAvailableLobbyWorkers(cwd: string): LobbyWorkerEntry[] {
  const result: LobbyWorkerEntry[] = [];
  for (const entry of workers.values()) {
    if (entry.cwd !== cwd || entry.type !== "lobby") continue;
    if (entry.assignedTaskId) continue;
    if (entry.proc.exitCode !== null) continue;
    result.push(entry);
  }
  return result;
}

export function getLobbyWorkerCount(cwd: string): number {
  let count = 0;
  for (const entry of workers.values()) {
    if (entry.cwd === cwd && entry.type === "lobby" && !entry.assignedTaskId && entry.proc.exitCode === null) count++;
  }
  return count;
}
