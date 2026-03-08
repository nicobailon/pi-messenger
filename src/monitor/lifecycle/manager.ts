/**
 * SessionLifecycleManager
 *
 * Finite state machine for session lifecycle transitions.
 * Validates transitions using the transitions table.
 * Emits lifecycle events via SessionEventEmitter.
 * Stores session state in SessionStore.
 */

import { randomUUID } from "node:crypto";
import type { SessionMetadata, SessionStatus } from "../types/session.js";
import { SessionStore } from "../store/session-store.js";
import { SessionEventEmitter } from "../events/emitter.js";
import { isValidTransition } from "./transitions.js";

export class SessionLifecycleManager {
  private store: SessionStore;
  private emitter: SessionEventEmitter;
  private sequenceMap: Map<string, number> = new Map();

  constructor(store?: SessionStore, emitter?: SessionEventEmitter) {
    this.store = store ?? new SessionStore();
    this.emitter = emitter ?? new SessionEventEmitter();
  }

  /**
   * Start a new session with the provided metadata.
   * Creates the session (idle) and immediately transitions to active.
   * Emits a "session.start" event.
   */
  start(metadata: Omit<SessionMetadata, "id" | "startedAt"> & { id?: string; startedAt?: string }): string {
    const id = metadata.id ?? randomUUID();
    const startedAt = metadata.startedAt ?? new Date().toISOString();

    const fullMetadata: SessionMetadata = {
      id,
      name: metadata.name,
      cwd: metadata.cwd,
      model: metadata.model,
      agent: metadata.agent,
      startedAt,
      ...(metadata.taskId !== undefined && { taskId: metadata.taskId }),
      ...(metadata.workerPid !== undefined && { workerPid: metadata.workerPid }),
      ...(metadata.agentRole !== undefined && { agentRole: metadata.agentRole }),
    };

    this.store.create(fullMetadata);
    this.sequenceMap.set(id, 0);

    // Transition idle → active
    this.transition(id, "active");

    this.emitter.emit({
      id: randomUUID(),
      type: "session.start",
      sessionId: id,
      timestamp: Date.now(),
      sequence: this.nextSequence(id),
      payload: {
        type: "session.start",
        agentName: metadata.agent,
        model: metadata.model,
        workingDir: metadata.cwd,
      },
    });

    return id;
  }

  /**
   * Pause an active session.
   * Transitions active → paused and emits "session.pause".
   */
  pause(sessionId: string, reason?: string): void {
    this.transition(sessionId, "paused");

    this.emitter.emit({
      id: randomUUID(),
      type: "session.pause",
      sessionId,
      timestamp: Date.now(),
      sequence: this.nextSequence(sessionId),
      payload: {
        type: "session.pause",
        reason,
      },
    });
  }

  /**
   * Resume a paused session.
   * Transitions paused → active and emits "session.resume".
   */
  resume(sessionId: string, resumedBy?: string): void {
    this.transition(sessionId, "active");

    this.emitter.emit({
      id: randomUUID(),
      type: "session.resume",
      sessionId,
      timestamp: Date.now(),
      sequence: this.nextSequence(sessionId),
      payload: {
        type: "session.resume",
        resumedBy,
      },
    });
  }

  /**
   * End a session (active or paused).
   * Transitions to ended and emits "session.end".
   */
  end(sessionId: string, summary?: string): void {
    this.transition(sessionId, "ended");

    this.emitter.emit({
      id: randomUUID(),
      type: "session.end",
      sessionId,
      timestamp: Date.now(),
      sequence: this.nextSequence(sessionId),
      payload: {
        type: "session.end",
        summary,
      },
    });
  }

  /**
   * Escalate a session to the error state for operator review.
   * Transitions active → error via the FSM and emits a "session.error" event.
   */
  escalate(sessionId: string, reason?: string): void {
    this.transition(sessionId, "error");

    this.emitter.emit({
      id: randomUUID(),
      type: "session.error",
      sessionId,
      timestamp: Date.now(),
      sequence: this.nextSequence(sessionId),
      payload: {
        type: "session.error",
        message: reason ?? "Session escalated for operator review",
        fatal: false,
      },
    });
  }

  /**
   * Get the current status of a session.
   * Returns undefined if the session does not exist.
   */
  getState(sessionId: string): SessionStatus | undefined {
    const session = this.store.get(sessionId);
    return session?.status;
  }

  /**
   * Get the underlying emitter (for subscribing to events).
   */
  getEmitter(): SessionEventEmitter {
    return this.emitter;
  }

  /**
   * Get the underlying store (for reading full session state).
   */
  getStore(): SessionStore {
    return this.store;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private transition(sessionId: string, to: SessionStatus): void {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const from = session.status;
    if (!isValidTransition(from, to)) {
      throw new Error(
        `Invalid lifecycle transition for session "${sessionId}": ${from} → ${to}. ` +
          `Valid next states from "${from}" are: ${validNextStatesFor(from).join(", ") || "none"}.`
      );
    }

    this.store.update(sessionId, { status: to });
  }

  private nextSequence(sessionId: string): number {
    const current = this.sequenceMap.get(sessionId) ?? 0;
    this.sequenceMap.set(sessionId, current + 1);
    return current;
  }
}

// Helper for error messages — avoids circular dependency with transitions module
function validNextStatesFor(from: SessionStatus): string[] {
  const table: Record<SessionStatus, string[]> = {
    idle: ["active"],
    active: ["paused", "ended", "error"],
    paused: ["active", "ended"],
    ended: [],
    error: ["ended"],
  };
  return table[from] ?? [];
}
