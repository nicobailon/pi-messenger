/**
 * src/monitor/bridge.ts
 *
 * CrewMonitorBridge — connects live crew workers to the monitor session subsystem.
 *
 * Responsibilities:
 *  - Subscribe to onLiveWorkersChanged() from crew/live-progress.ts
 *  - Worker added  → lifecycle.start()  (creates a monitor session)
 *  - Worker removed → lifecycle.end()   (ends the monitor session)
 *  - Tool change    → emitter.emit() with a tool.call event
 *  - Maintain a taskKey → sessionId mapping
 *  - dispose() unsubscribes from live-progress notifications
 */

import { randomUUID } from "node:crypto";
import { getLiveWorkers, onLiveWorkersChanged } from "../../crew/live-progress.js";
import type { LiveWorkerInfo } from "../../crew/live-progress.js";
import type { SessionLifecycleManager } from "./lifecycle/manager.js";
import type { SessionEventEmitter } from "./events/emitter.js";
import type { MonitorRegistry } from "./registry.js";

/** Stable string key for a worker: `${cwd}::${taskId}` */
function workerKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

export interface CrewMonitorBridgeOptions {
  /** Only observe workers in this cwd. Omit to observe all workers. */
  cwd?: string;
}

export class CrewMonitorBridge {
  private readonly lifecycle: SessionLifecycleManager;
  private readonly emitter: SessionEventEmitter;
  private readonly cwd: string | undefined;

  /** taskKey → monitorSessionId */
  private readonly taskSessionMap = new Map<string, string>();
  /** taskKey → last seen currentTool (to detect tool changes) */
  private readonly lastToolMap = new Map<string, string | undefined>();

  private readonly unsubscribeFn: () => void;
  private disposed = false;

  constructor(
    lifecycleOrRegistry: SessionLifecycleManager | MonitorRegistry,
    emitterOrOptions?: SessionEventEmitter | CrewMonitorBridgeOptions,
    options?: CrewMonitorBridgeOptions,
  ) {
    // Accept either (registry) or (lifecycle, emitter, options?)
    if ("lifecycle" in lifecycleOrRegistry && "emitter" in lifecycleOrRegistry) {
      // MonitorRegistry path
      const registry = lifecycleOrRegistry as MonitorRegistry;
      this.lifecycle = registry.lifecycle;
      this.emitter = registry.emitter;
      this.cwd =
        emitterOrOptions && !("subscribe" in emitterOrOptions)
          ? (emitterOrOptions as CrewMonitorBridgeOptions).cwd
          : undefined;
    } else {
      // SessionLifecycleManager path
      this.lifecycle = lifecycleOrRegistry as SessionLifecycleManager;
      this.emitter = emitterOrOptions as SessionEventEmitter;
      this.cwd = options?.cwd;
    }

    // Subscribe to live-worker changes
    this.unsubscribeFn = onLiveWorkersChanged(() => this.sync());

    // Initial sync to pick up any already-running workers
    this.sync();
  }

  /**
   * Diff the current live-worker snapshot against our tracked state.
   * Handles add / remove / tool-change cases.
   */
  private sync(): void {
    if (this.disposed) return;

    const workers = this.cwd ? getLiveWorkers(this.cwd) : getLiveWorkers();

    // Build a set of keys currently alive so we can detect removals.
    const currentKeys = new Set<string>();

    for (const [rawKey, worker] of workers) {
      const key = this.cwd
        ? workerKey(worker.cwd, rawKey) // filtered map is keyed by taskId only
        : rawKey; // full map is already keyed by cwd::taskId

      currentKeys.add(key);

      if (!this.taskSessionMap.has(key)) {
        // NEW worker → start a monitor session
        this.addWorker(key, worker);
      } else {
        // EXISTING worker → check for tool change
        this.checkToolChange(key, worker);
      }
    }

    // Removed workers → end their monitor sessions
    for (const [key, sessionId] of this.taskSessionMap) {
      if (!currentKeys.has(key)) {
        this.removeWorker(key, sessionId);
      }
    }
  }

  private addWorker(key: string, worker: LiveWorkerInfo): void {
    const sessionId = this.lifecycle.start({
      name: worker.name,
      cwd: worker.cwd,
      model: worker.progress.model ?? "unknown",
      agent: worker.agent,
      taskId: worker.taskId,
      startedAt: new Date(worker.startedAt).toISOString(),
    });

    this.taskSessionMap.set(key, sessionId);
    this.lastToolMap.set(key, worker.progress.currentTool);

    // If the worker already has an active tool at time of discovery, emit immediately
    if (worker.progress.currentTool) {
      this.emitToolCall(sessionId, worker.progress.currentTool);
    }
  }

  private removeWorker(key: string, sessionId: string): void {
    const state = this.lifecycle.getState(sessionId);
    if (state === "active" || state === "paused") {
      this.lifecycle.end(sessionId);
    }
    this.taskSessionMap.delete(key);
    this.lastToolMap.delete(key);
  }

  private checkToolChange(key: string, worker: LiveWorkerInfo): void {
    const sessionId = this.taskSessionMap.get(key);
    if (!sessionId) return;

    const prevTool = this.lastToolMap.get(key);
    const currentTool = worker.progress.currentTool;

    if (currentTool && currentTool !== prevTool) {
      this.emitToolCall(sessionId, currentTool);
      this.lastToolMap.set(key, currentTool);
    } else if (!currentTool && prevTool !== undefined) {
      // Tool cleared — update tracking without emitting
      this.lastToolMap.set(key, undefined);
    }
  }

  private emitToolCall(sessionId: string, toolName: string): void {
    this.emitter.emit({
      id: randomUUID(),
      type: "tool.call",
      sessionId,
      timestamp: Date.now(),
      sequence: 0,
      payload: {
        type: "tool.call",
        toolName,
      },
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the monitor sessionId mapped to a given taskId (or cwd::taskId key).
   * Useful for callers that want to look up the associated session.
   */
  getSessionId(taskId: string, cwd?: string): string | undefined {
    if (cwd) {
      return this.taskSessionMap.get(workerKey(cwd, taskId));
    }
    // Search by taskId suffix when cwd is omitted
    for (const [key, sessionId] of this.taskSessionMap) {
      if (key.endsWith(`::${taskId}`) || key === taskId) {
        return sessionId;
      }
    }
    return undefined;
  }

  /** Number of currently tracked worker sessions. */
  get sessionCount(): number {
    return this.taskSessionMap.size;
  }

  /**
   * Unsubscribe from live-progress notifications.
   * Any already-started sessions are NOT ended — call lifecycle.end() manually if needed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFn();
  }
}

/**
 * Convenience factory: create a bridge from a MonitorRegistry.
 */
export function createCrewMonitorBridge(
  registry: MonitorRegistry,
  options?: CrewMonitorBridgeOptions,
): CrewMonitorBridge {
  return new CrewMonitorBridge(registry, options);
}
