/**
 * SessionHealthMonitor
 *
 * Polls active sessions at a configurable interval and emits health.alert
 * events when thresholds are exceeded.
 *
 * - Stale detection: no new events since staleAfterMs → degraded alert
 * - Stuck detection: session active but no progress since stuckAfterMs → critical alert
 * - Error rate: session error rate exceeds errorRateThreshold → degraded alert
 */

import { randomUUID } from "node:crypto";
import type { SessionEventEmitter } from "../events/emitter.js";
import type { SessionStore } from "../store/session-store.js";
import type { SessionMetricsAggregator } from "../metrics/aggregator.js";
import type {
  HealthStatus,
  HealthThresholds,
  HealthAlert,
  AlertHandler,
  InferredSessionState,
  HealthExplanation,
  HealthSignalSnapshot,
  SessionHealthSnapshot,
} from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SignalHistory {
  lastHeartbeatAt: number;
  lastOutputAt: number;
  lastToolActivityAt: number;
  waitingReason?: string;
  waitingAt?: number;
  waiting: boolean;
  retryCount: number;
  lastEventType?: string;
}

interface TrackedState {
  state: InferredSessionState;
  repeatCount: number;
  historyCount: number;
}

// ─── Default Thresholds ──────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: HealthThresholds = {
  staleAfterMs: 30_000,
  stuckAfterMs: 120_000,
  errorRateThreshold: 0.5,
};

const DEFAULT_DEGRADED_RECOVERY = "Check whether the worker is blocked on a slow tool or loop.";
const DEFAULT_STUCK_RECOVERY = "Inspect the worker and retry if it is no longer making progress.";

// ─── SessionHealthMonitor ─────────────────────────────────────────────────────

export class SessionHealthMonitor {
  private store: SessionStore;
  private emitter: SessionEventEmitter;
  private aggregator: SessionMetricsAggregator | undefined;

  private thresholds: HealthThresholds = { ...DEFAULT_THRESHOLDS };
  private alertHandlers: Set<AlertHandler> = new Set();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Track signal timestamps per session (sessionId → signal history) */
  private signalHistory: Map<string, SignalHistory> = new Map();
  /** Track deduped alert status per session to suppress duplicate alerts */
  private lastAlertStatus: Map<string, HealthStatus> = new Map();
  /** Track current deduped non-healthy state state/repeat/history counts */
  private trackedSessionState: Map<string, TrackedState> = new Map();
  /** Track latest current alert for retrieval */
  private currentAlerts: Map<string, HealthAlert> = new Map();

  constructor(
    store: SessionStore,
    emitter: SessionEventEmitter,
    aggregator?: SessionMetricsAggregator
  ) {
    this.store = store;
    this.emitter = emitter;
    this.aggregator = aggregator;

    // Track stream signals via emitter subscription.
    // Exclude health.alert events (emitted by this monitor) so they don't
    // reset idle timers and pollute signal states.
    this.emitter.subscribe((event) => {
      if (event.type === "health.alert") {
        return;
      }

      const sessionId = event.sessionId;
      const payload = event.payload as Record<string, unknown>;
      const history = this.signalHistory.get(sessionId) ?? {
        lastHeartbeatAt: event.timestamp,
        lastOutputAt: event.timestamp,
        lastToolActivityAt: event.timestamp,
        waiting: false,
        waitingReason: undefined,
        waitingAt: undefined,
        retryCount: 0,
      };

      history.lastHeartbeatAt = event.timestamp;
      history.lastEventType = event.type;

      if (event.type === "agent.waiting") {
        history.waiting = true;
        history.waitingAt = event.timestamp;
        history.waitingReason = payload && typeof payload.reason === "string" ? payload.reason : undefined;
      } else {
        // Any non-waiting event indicates explicit activity and clears implicit waiting.
        history.waiting = false;
        history.waitingReason = undefined;
        history.waitingAt = undefined;
      }

      if (event.type === "execution.output") {
        history.lastOutputAt = event.timestamp;
      }

      if (event.type === "tool.call" || event.type === "tool.result") {
        history.lastToolActivityAt = event.timestamp;

        if (event.type === "tool.result") {
          const success = (payload && payload.success === true) || false;
          if (!success) {
            history.retryCount += 1;
          }
        }
      }

      if (event.type === "session.error") {
        history.retryCount += 1;
      }

      this.signalHistory.set(sessionId, history);
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Start the health monitor polling loop.
   * @param intervalMs How often to poll (default: 5000ms)
   */
  start(intervalMs: number = 5_000): void {
    if (this.intervalHandle !== null) {
      return; // Already running
    }
    this.intervalHandle = setInterval(() => {
      this.pollAllSessions();
    }, intervalMs);
  }

  /**
   * Stop the health monitor polling loop.
   * Clears the interval — no further alerts will be emitted.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Check the health of a specific session.
   * Emits a health.alert event if the session is unhealthy.
   * Returns the HealthStatus for the session.
   */
  checkHealth(sessionId: string): HealthStatus {
    const snapshot = this.getSessionHealth(sessionId, true);
    const status = this.toLegacyStatus(snapshot.state);

    if (status !== "healthy") {
      const existing = this.currentAlerts.get(sessionId);
      const alert: HealthAlert = {
        sessionId,
        status,
        reason: snapshot.summary,
        detectedAt: Date.now(),
        explanation: this.toExplanation(snapshot),
      };

      if (existing) {
        // Existing unhealthy state.
        existing.reason = snapshot.summary;
        existing.explanation = alert.explanation;

        if (this.lastAlertStatus.get(sessionId) !== status) {
          this.lastAlertStatus.set(sessionId, status);
          const emitted = { ...alert };
          this.currentAlerts.set(sessionId, emitted);
          this.emitAlert(emitted);
        }
      } else {
        this.lastAlertStatus.set(sessionId, status);
        this.currentAlerts.set(sessionId, alert);
        this.emitAlert(alert);
      }
    } else {
      this.lastAlertStatus.delete(sessionId);
      this.currentAlerts.delete(sessionId);
    }

    return status;
  }

  /**
   * Get the current inferred health snapshot for a session.
   */
  getSessionHealth(sessionId: string, trackState = false): SessionHealthSnapshot {
    const session = this.store.get(sessionId);
    if (!session) {
      const now = Date.now();
      return {
        sessionId,
        state: "healthy",
        summary: "No session data available",
        actionable: false,
        recommendedAction: "Create or restore the session before health evaluation.",
        repeatCount: 0,
        historyCount: 0,
        signals: {
          idleMs: 0,
          lastHeartbeatAt: now,
          lastOutputAt: now,
          lastToolActivityAt: now,
          retryCount: 0,
          waiting: false,
          errorRate: 0,
        },
      };
    }

    const signals = this.readSignals(session, sessionId);
    const now = Date.now();
    const state = this.inferState(session, signals, now);

    const tracked = this.trackedSessionState.get(sessionId) ?? {
      state: "healthy",
      repeatCount: 0,
      historyCount: 0,
    };

    const updated = this.adjustStateCounts(tracked, state);
    this.trackedSessionState.set(sessionId, updated);

    const snapshot = this.buildSnapshot(session, state, signals, now, updated.repeatCount, updated.historyCount);

    return snapshot;
  }

  /**
   * Return the latest emitted health alert for a session, if any.
   */
  getAlert(sessionId: string): HealthAlert | undefined {
    return this.currentAlerts.get(sessionId);
  }

  /**
   * Update health detection thresholds.
   * Merges with existing thresholds.
   */
  setThresholds(config: Partial<HealthThresholds>): void {
    this.thresholds = { ...this.thresholds, ...config };
  }

  /**
   * Register a handler to be called when a health alert is emitted.
   * Returns an unsubscribe function.
   */
  onAlert(handler: AlertHandler): () => void {
    this.alertHandlers.add(handler);
    return () => {
      this.alertHandlers.delete(handler);
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private pollAllSessions(): void {
    const activeSessions = this.store.list({ status: "active" });
    for (const session of activeSessions) {
      this.checkHealth(session.metadata.id);
    }
  }

  private isWaitingState(sessionStatus: string, signals: SignalHistory): boolean {
    if (sessionStatus === "paused") return true;
    return signals.waiting && sessionStatus === "active";
  }

  private inferState(
    session: { status: string; metadata: { id: string; startedAt: string } },
    signals: SignalHistory,
    now: number,
  ): InferredSessionState {
    if (session.status === "idle") {
      return "idle";
    }

    if (session.status === "paused") {
      return "waiting";
    }

    if (session.status !== "active") {
      return "healthy";
    }

    if (this.isWaitingState(session.status, signals)) {
      return "waiting";
    }

    const idleMs = Math.max(0, now - signals.lastHeartbeatAt);
    const errorRate = this.aggregator?.getErrorRate(session.metadata.id) ?? 0;

    if (idleMs >= this.thresholds.stuckAfterMs) {
      return "stuck";
    }

    if (idleMs >= this.thresholds.staleAfterMs) {
      return "degraded";
    }

    if (errorRate > this.thresholds.errorRateThreshold) {
      return "degraded";
    }

    return "healthy";
  }

  private adjustStateCounts(previous: TrackedState, nextState: InferredSessionState): TrackedState {
    const previousUnhealthy = this.isUnhealthyState(previous.state);
    const nextUnhealthy = this.isUnhealthyState(nextState);

    if (nextState === previous.state) {
      return {
        state: nextState,
        repeatCount: previous.repeatCount + 1,
        historyCount: previous.historyCount,
      };
    }

    if (nextUnhealthy) {
      if (previousUnhealthy) {
        return {
          state: nextState,
          repeatCount: 1,
          historyCount: previous.historyCount + 1,
        };
      }

      return {
        state: nextState,
        repeatCount: 1,
        historyCount: 1,
      };
    }

    if (previousUnhealthy) {
      return {
        state: nextState,
        repeatCount: 1,
        historyCount: previous.historyCount,
      };
    }

    return {
      state: nextState,
      repeatCount: previous.state === nextState ? previous.repeatCount + 1 : 1,
      historyCount: 0,
    };
  }

  private isUnhealthyState(state: InferredSessionState): boolean {
    return state === "degraded" || state === "stuck";
  }

  private toLegacyStatus(state: InferredSessionState): HealthStatus {
    if (state === "stuck") return "critical";
    if (state === "degraded") return "degraded";
    return "healthy";
  }

  private buildSnapshot(
    session: { metadata: { id: string; startedAt: string } },
    state: InferredSessionState,
    signals: SignalHistory,
    now: number,
    repeatCount: number,
    historyCount: number,
  ): SessionHealthSnapshot {
    const ageMs = Math.max(0, now - signals.lastHeartbeatAt);
    const errorRate = this.aggregator?.getErrorRate(session.metadata.id) ?? 0;
    let summary = "Session is healthy";
    let actionable = false;
    let recommendedAction = "Session is operating normally.";

    if (state === "waiting") {
      summary = signals.waitingReason
        ? `Session is waiting: ${signals.waitingReason}`
        : "Session is waiting for operator action";
    } else if (state === "idle") {
      summary = "Session is idle";
    } else if (state === "stuck") {
      actionable = true;
      summary = `Session has been stuck for ${Math.round(ageMs / 1000)}s with no progress.`;
      recommendedAction = DEFAULT_STUCK_RECOVERY;
    } else if (state === "degraded") {
      actionable = true;
      if (errorRate > this.thresholds.errorRateThreshold) {
        summary = `Session error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold ${(this.thresholds.errorRateThreshold * 100).toFixed(1)}%`;
      } else {
        summary = `Session has been stale for ${Math.round(ageMs / 1000)}s with no recent output.`;
      }
      recommendedAction = DEFAULT_DEGRADED_RECOVERY;
    }

    const healthSignals: HealthSignalSnapshot = {
      idleMs: ageMs,
      lastHeartbeatAt: signals.lastHeartbeatAt,
      lastOutputAt: signals.lastOutputAt,
      lastToolActivityAt: signals.lastToolActivityAt,
      retryCount: signals.retryCount,
      waiting: signals.waiting,
      errorRate,
    };

    return {
      sessionId: session.metadata.id,
      state,
      summary,
      actionable,
      recommendedAction,
      repeatCount,
      historyCount,
      signals: healthSignals,
    };
  }

  private toExplanation(snapshot: SessionHealthSnapshot): HealthExplanation {
    return {
      state: snapshot.state,
      summary: snapshot.summary,
      actionable: snapshot.actionable,
      recommendedAction: snapshot.recommendedAction,
      repeatCount: snapshot.repeatCount,
      historyCount: snapshot.historyCount,
      signals: snapshot.signals,
    };
  }

  private readSignals(session: { status: string; metadata: { startedAt: string } }, sessionId: string): SignalHistory {
    const existing = this.signalHistory.get(sessionId);
    const startedAt = Date.parse(session.metadata.startedAt);

    if (existing) {
      return {
        ...existing,
        lastHeartbeatAt: existing.lastHeartbeatAt || startedAt,
        lastOutputAt: existing.lastOutputAt || startedAt,
        lastToolActivityAt: existing.lastToolActivityAt || startedAt,
      };
    }

    return {
      lastHeartbeatAt: startedAt,
      lastOutputAt: startedAt,
      lastToolActivityAt: startedAt,
      waiting: false,
      waitingReason: undefined,
      waitingAt: undefined,
      retryCount: 0,
    };
  }

  private emitAlert(alert: HealthAlert): void {
    // Emit to all registered handlers (support async handlers)
    for (const handler of this.alertHandlers) {
      try {
        Promise.resolve(handler(alert)).catch(err =>
          console.error('[health-monitor] alert handler error:', err)
        );
      } catch {
        // Swallow sync throws
      }
    }

    // Emit health.alert event to the event emitter
    this.emitter.emit({
      id: randomUUID(),
      type: "health.alert",
      sessionId: alert.sessionId,
      timestamp: alert.detectedAt,
      sequence: 0,
      payload: {
        type: "health.alert",
        severity: alert.status === "critical" ? "critical" : "warning",
        message: alert.reason,
        component: "SessionHealthMonitor",
      },
    });
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a new SessionHealthMonitor.
 */
export function createSessionHealthMonitor(
  store: SessionStore,
  emitter: SessionEventEmitter,
  aggregator?: SessionMetricsAggregator
): SessionHealthMonitor {
  return new SessionHealthMonitor(store, emitter, aggregator);
}
