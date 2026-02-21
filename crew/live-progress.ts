import type { AgentProgress } from "./utils/progress.js";

export interface LiveWorkerInfo {
  cwd: string;
  taskId: string;
  agent: string;
  name: string;
  progress: AgentProgress;
  startedAt: number;
}

const liveWorkers = new Map<string, LiveWorkerInfo>();
const listeners = new Set<() => void>();

function getWorkerKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
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

export function onLiveWorkersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(): void {
  for (const fn of listeners) fn();
}
