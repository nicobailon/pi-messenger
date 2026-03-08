import type { PiEvent } from "./utils/progress.js";
import type { AgentProgress } from "./utils/progress.js";

export interface LiveWorkerInfo {
  cwd: string;
  taskId: string;
  agent: string;
  name: string;
  progress: AgentProgress;
  startedAt: number;
}

export interface WorkerRuntimeEvent {
  event: PiEvent;
  timestamp: number;
}

export interface WorkerRuntimeSession {
  cwd: string;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "failed";
  exitCode?: number;
  finalOutput?: string;
  finalError?: string;
  events: WorkerRuntimeEvent[];
}

const liveWorkers = new Map<string, LiveWorkerInfo>();
const runtimeSessions = new Map<string, WorkerRuntimeSession>();
const archivedRuntimeSessions = new Map<string, WorkerRuntimeSession>();
const listeners = new Set<() => void>();

function getWorkerKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

function getOrCreateRuntimeSession(
  cwd: string,
  taskId: string,
  startedAt = Date.now(),
): WorkerRuntimeSession {
  const key = getWorkerKey(cwd, taskId);
  const existing = runtimeSessions.get(key);
  if (existing) {
    if (startedAt && !existing.startedAt) {
      existing.startedAt = startedAt;
    }
    return existing;
  }

  const created: WorkerRuntimeSession = {
    cwd,
    taskId,
    startedAt,
    status: "running",
    events: [],
  };
  runtimeSessions.set(key, created);
  return created;
}

export function registerWorkerRuntimeSession(
  cwd: string,
  taskId: string,
  startedAt?: number,
  status: WorkerRuntimeSession["status"] = "running",
): void {
  const session = getOrCreateRuntimeSession(cwd, taskId, startedAt);
  session.status = status;
  if (startedAt !== undefined) {
    session.startedAt = startedAt;
  }
}

export function appendWorkerRuntimeEvent(
  cwd: string,
  taskId: string,
  event: PiEvent,
  timestamp = Date.now(),
): void {
  const session = getOrCreateRuntimeSession(cwd, taskId, timestamp);
  session.events.push({ event, timestamp });
}

export function getWorkerRuntimeSession(
  cwd: string,
  taskId: string,
): WorkerRuntimeSession | undefined {
  const key = getWorkerKey(cwd, taskId);
  return runtimeSessions.get(key) ?? archivedRuntimeSessions.get(key);
}

export function archiveWorkerRuntimeSession(
  cwd: string,
  taskId: string,
  finalization: {
    status?: WorkerRuntimeSession["status"];
    exitCode?: number;
    finalOutput?: string;
    finalError?: string;
    endedAt?: number;
  } = {},
): WorkerRuntimeSession | undefined {
  const key = getWorkerKey(cwd, taskId);
  const session = runtimeSessions.get(key);
  if (!session) return undefined;

  const archived: WorkerRuntimeSession = {
    ...session,
    status: finalization.status ?? session.status,
    exitCode: finalization.exitCode ?? session.exitCode,
    finalOutput: finalization.finalOutput ?? session.finalOutput,
    finalError: finalization.finalError ?? session.finalError,
    endedAt: finalization.endedAt ?? Date.now(),
  };

  runtimeSessions.delete(key);
  archivedRuntimeSessions.set(key, archived);
  return archived;
}

export function getLiveWorkers(cwd?: string): ReadonlyMap<string, LiveWorkerInfo> {
  if (!cwd) return new Map(liveWorkers);

  const filtered = new Map<string, LiveWorkerInfo>();
  for (const info of liveWorkers.values()) {
    if (info.cwd !== cwd) continue;
    filtered.set(info.taskId, info);
  }
  return filtered;
}

export function hasLiveWorkers(cwd?: string): boolean {
  if (!cwd) return liveWorkers.size > 0;
  for (const info of liveWorkers.values()) {
    if (info.cwd === cwd) return true;
  }
  return false;
}

export function updateLiveWorker(cwd: string, taskId: string, info: Omit<LiveWorkerInfo, "cwd">): void {
  liveWorkers.set(getWorkerKey(cwd, taskId), {
    ...info,
    cwd,
  });
  notifyListeners();
}

export function removeLiveWorker(cwd: string, taskId: string): void {
  liveWorkers.delete(getWorkerKey(cwd, taskId));
  notifyListeners();
}

export function onLiveWorkersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(): void {
  for (const fn of listeners) fn();
}
