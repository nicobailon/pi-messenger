/**
 * Health Monitor Types
 *
 * Types for the SessionHealthMonitor, including legacy health statuses used by
 * checkHealth and explainable session snapshots/alerts for current-state
 * inspection.
 */

// ─── HealthStatus ─────────────────────────────────────────────────────────────

/**
 * The legacy health state returned by `checkHealth` and most legacy callers.
 *
 * - healthy: session is operating normally
 * - degraded: session is showing signs of being stale (no recent activity)
 * - critical: session is considered stuck (no progress for a long period)
 */
export type HealthStatus = "healthy" | "degraded" | "critical";

/**
 * The richer inferred session state used for snapshot/detail diagnostics.
 *
 * - waiting: explicit waiting condition (e.g. agent waiting / paused)
 * - idle: queue/idle lifecycle state
 * - degraded: stale or elevated error-rate conditions
 * - stuck: long-running idle condition while active
 */
export type InferredSessionState = "healthy" | "idle" | "waiting" | "degraded" | "stuck";

// ─── HealthThresholds ─────────────────────────────────────────────────────────

/**
 * Configurable thresholds for health detection.
 */
export interface HealthThresholds {
  /**
   * Duration in milliseconds after which a session with no activity
   * is considered stale (triggers degraded alert).
   * Default: 30_000 (30 seconds)
   */
  staleAfterMs: number;

  /**
   * Duration in milliseconds after which a session with no progress
   * is considered stuck (triggers critical alert).
   * Default: 120_000 (2 minutes)
   */
  stuckAfterMs: number;

  /**
   * Error rate threshold (0–1). If the session's error rate exceeds
   * this value, a degraded alert is triggered.
   * Default: 0.5 (50%)
   */
  errorRateThreshold: number;
}

// ─── Health diagnostics ───────────────────────────────────────────────────────

/**
 * Signals extracted from stream/state used when explaining why a state was
 * inferred.
 */
export interface HealthSignalSnapshot {
  /** Age since the last relevant heartbeat event in milliseconds. */
  idleMs: number;

  /** Epoch ms of last heartbeat/activity event. */
  lastHeartbeatAt: number;

  /** Epoch ms of last execution output event. */
  lastOutputAt: number;

  /** Epoch ms of last tool-related event (tool.call/tool.result). */
  lastToolActivityAt: number;

  /** Number of inferred retries observed in stream history. */
  retryCount: number;

  /** Whether the session is currently in explicit waiting mode. */
  waiting: boolean;

  /** Current error-rate metric (0..1) when available. */
  errorRate: number;
}

/**
 * Explainability payload for current snapshot and alert rendering.
 */
export interface HealthExplanation {
  /** Human-readable state label for this snapshot */
  state: InferredSessionState;

  /** Short diagnostic summary (human readable) */
  summary: string;

  /** Indicates whether operator action is recommended now */
  actionable: boolean;

  /** Suggested follow-up action text when actionable */
  recommendedAction: string;

  /** How many times this same state repeated without status changes. */
  repeatCount: number;

  /** Number of distinct unhealthy states encountered for this session. */
  historyCount: number;

  /** Derived signals referenced by the summary logic */
  signals: HealthSignalSnapshot;
}

/**
 * Per-session snapshot combining inferred state and explainability details.
 */
export interface SessionHealthSnapshot {
  /** Session identifier */
  sessionId: string;

  /** Inferred session state */
  state: InferredSessionState;

  /** Snapshot-level summary */
  summary: string;

  /** Whether the state is operator-actionable */
  actionable: boolean;

  /** Recommended action text */
  recommendedAction: string;

  /** How many times this same state repeated */
  repeatCount: number;

  /** Number of non-healthy historical entries observed */
  historyCount: number;

  /** Signal snapshot */
  signals: HealthSignalSnapshot;
}

// ─── HealthAlert ──────────────────────────────────────────────────────────────

/**
 * A health alert emitted when a session's health changes.
 */
export interface HealthAlert {
  /** The session that triggered the alert */
  sessionId: string;

  /** The health status at the time of the alert */
  status: HealthStatus;

  /** Human-readable description of why the alert was triggered */
  reason: string;

  /** Epoch ms when the alert was detected */
  detectedAt: number;

  /** Optional richer explainability payload for UI rendering */
  explanation?: HealthExplanation;
}

// ─── AlertHandler ─────────────────────────────────────────────────────────────

/**
 * Handler function called when a health alert is emitted.
 */
export type AlertHandler = (alert: HealthAlert) => void;
