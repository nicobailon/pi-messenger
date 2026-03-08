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
import type { HealthStatus, HealthThresholds, HealthAlert, AlertHandler } from "./types.js";

// ─── Default Thresholds ──────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: HealthThresholds = {
  staleAfterMs: 30_000,
  stuckAfterMs: 120_000,
  errorRateThreshold: 0.5,
};

// ─── SessionHealthMonitor ─────────────────────────────────────────────────────

export class SessionHealthMonitor {
  private store: SessionStore;
  private emitter: SessionEventEmitter;
  private aggregator: SessionMetricsAggregator | undefined;

  private thresholds: HealthThresholds = { ...DEFAULT_THRESHOLDS };
  private alertHandlers: Set<AlertHandler> = new Set();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Track last event timestamp per session (sessionId → epoch ms) */
  private lastEventAt: Map<string, number> = new Map();
  /** Track last emitted alert status per session to suppress duplicate alerts */
  private lastAlertStatus: Map<string, HealthStatus> = new Map();

  constructor(
    store: SessionStore,
    emitter: SessionEventEmitter,
    aggregator?: SessionMetricsAggregator
  ) {
    this.store = store;
    this.emitter = emitter;
    this.aggregator = aggregator;

    // Track last event timestamps via emitter subscription
    this.emitter.subscribe((event) => {
      this.lastEventAt.set(event.sessionId, event.timestamp);
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
    const session = this.store.get(sessionId);
    if (!session) return "healthy";

    // Only check active sessions
    if (session.status !== "active") return "healthy";

    const now = Date.now();
    const lastEvent = this.lastEventAt.get(sessionId) ?? 0;
    const idleMs = now - lastEvent;

    let status: HealthStatus = "healthy";
    let reason = "";

    if (idleMs >= this.thresholds.stuckAfterMs) {
      status = "critical";
      reason = `Session has been stuck for ${Math.round(idleMs / 1000)}s (threshold: ${this.thresholds.stuckAfterMs / 1000}s)`;
    } else if (idleMs >= this.thresholds.staleAfterMs) {
      status = "degraded";
      reason = `Session has been stale for ${Math.round(idleMs / 1000)}s (threshold: ${this.thresholds.staleAfterMs / 1000}s)`;
    } else if (this.aggregator) {
      const errorRate = this.aggregator.getErrorRate(sessionId);
      if (errorRate > this.thresholds.errorRateThreshold) {
        status = "degraded";
        reason = `Session error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold ${(this.thresholds.errorRateThreshold * 100).toFixed(1)}%`;
      }
    }

    if (status !== "healthy") {
      // Deduplicate: only emit when the alert status changes for this session
      if (this.lastAlertStatus.get(sessionId) !== status) {
        this.lastAlertStatus.set(sessionId, status);
        const alert: HealthAlert = {
          sessionId,
          status,
          reason,
          detectedAt: now,
        };
        this.emitAlert(alert);
      }
    } else {
      // Reset tracking when session recovers to healthy
      this.lastAlertStatus.delete(sessionId);
    }

    return status;
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

  private emitAlert(alert: HealthAlert): void {
    // Emit to all registered handlers
    for (const handler of this.alertHandlers) {
      try {
        handler(alert);
      } catch {
        // Swallow handler errors
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
