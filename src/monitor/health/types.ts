/**
 * Health Monitor Types
 *
 * Types for the SessionHealthMonitor, including HealthStatus,
 * HealthThresholds, and HealthAlert.
 */

// ─── HealthStatus ─────────────────────────────────────────────────────────────

/**
 * The health state of a session.
 *
 * - healthy: session is operating normally
 * - degraded: session is showing signs of being stale (no recent activity)
 * - critical: session appears to be stuck (no progress for a long period)
 */
export type HealthStatus = "healthy" | "degraded" | "critical";

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
}

// ─── AlertHandler ─────────────────────────────────────────────────────────────

/**
 * Handler function called when a health alert is emitted.
 */
export type AlertHandler = (alert: HealthAlert) => void;
