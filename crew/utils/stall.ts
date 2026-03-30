/**
 * Shared stall detection helper for collaborator liveness.
 *
 * Replaces the log-size heuristic with dual-signal detection:
 * heartbeat file (deterministic) + log file (fallback).
 *
 * Used by both poll paths (crew/handlers/collab.ts and cli/index.ts)
 * to prevent independent implementations from drifting (spec 009, R8).
 */

import * as fs from "node:fs";

export interface StallOpts {
  /** Path to <name>.heartbeat written by the collaborator's extension. undefined → log-only fallback. */
  heartbeatFile?: string;
  /** Path to collab.log. null/undefined → degraded mode (never stalls via isStalled). */
  logFile?: string | null;
  /** Stall threshold — both signals must exceed this for a stall. */
  stallThresholdMs: number;
  /** Grace period at spawn start: heartbeatIntervalMs * 2. Always ≤ 20s (R4 cap). */
  gracePeriodMs: number;
  /** Date.now() at spawn time (ms). */
  spawnedAt: number;
}

/**
 * What isStalled() determined about the collaborator's liveness.
 * Does NOT include "timeout" — that is a ceiling-hit emitted by callers.
 * Callers use PollStallType = LivenessType | "timeout" for PollResult.stallType.
 */
export type LivenessType =
  | "not-stalled"    // actively alive (heartbeat fresh, or log fresh, or in grace)
  | "within-grace"   // inside startup grace window — cannot determine yet
  | "heartbeat+log"  // both heartbeat and log stale — genuinely stalled
  | "log-only";      // no heartbeat after grace, log stale — log-only fallback stall

export interface StallResult {
  stalled: boolean;
  stalledMs: number;
  type: LivenessType;
  /**
   * true when a heartbeat file exists and its mtime is within stallThresholdMs.
   * Callers use this to select the ceiling:
   *   const ceiling = stallResult.heartbeatActive ? hardCeilingMs : resolvedPollTimeoutMs;
   */
  heartbeatActive: boolean;
}

/**
 * Determine whether a collaborator process appears stalled.
 *
 * Three-step logic:
 *   1. Within grace period → not stalled (startup window)
 *   2. Heartbeat exists → check mtime; fresh = alive; stale = dual-signal check
 *   3. No heartbeat (after grace) → log-only fallback
 *
 * Degraded mode (logFile is null/undefined): returns stalled=false in all cases
 * where the log would be the determining signal. The ceiling mechanism in callers
 * handles maximum wait. This preserves backward compatibility with the original
 * behavior where stall detection was skipped when no log file was present.
 *
 * Missing files: heartbeat missing → mtime=0 (stale); log missing → mtime=now (fresh/unknown).
 */
export function isStalled(opts: StallOpts): StallResult {
  const { heartbeatFile, logFile, stallThresholdMs, gracePeriodMs, spawnedAt } = opts;
  const now = Date.now();
  const elapsed = now - spawnedAt;

  // Step 1: within grace period
  if (elapsed < gracePeriodMs) {
    return { stalled: false, stalledMs: 0, type: "within-grace", heartbeatActive: false };
  }

  // Step 2: heartbeat file check
  if (heartbeatFile !== undefined) {
    let heartbeatMtimeMs = 0; // missing = stale
    try {
      heartbeatMtimeMs = fs.statSync(heartbeatFile).mtimeMs;
    } catch {
      // File not found or unreadable — treat as stale (mtime=0)
    }

    if (now - heartbeatMtimeMs < stallThresholdMs) {
      // Heartbeat is fresh — collaborator is alive
      return { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: true };
    }

    // Heartbeat stale → dual-signal: need log also stale to declare a stall
    if (logFile == null) {
      // Degraded mode: cannot determine via log. Ceiling handles max wait.
      return { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: false };
    }

    const logMtimeMs = readMtimeSafe(logFile, now); // missing log = fresh
    const logStaleMs = now - logMtimeMs;
    if (logStaleMs >= stallThresholdMs) {
      const heartbeatStaleMs = now - heartbeatMtimeMs;
      return {
        stalled: true,
        stalledMs: Math.max(heartbeatStaleMs, logStaleMs),
        type: "heartbeat+log",
        heartbeatActive: false,
      };
    }

    // Log is fresh — not stalled despite stale heartbeat
    return { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: false };
  }

  // Step 3: no heartbeat → log-only fallback (R7, backward compat)
  if (logFile == null) {
    // Degraded mode: no log, no heartbeat — cannot determine. Ceiling handles max wait.
    return { stalled: false, stalledMs: 0, type: "not-stalled", heartbeatActive: false };
  }

  const logMtimeMs = readMtimeSafe(logFile, now); // missing log = fresh
  const logStaleMs = now - logMtimeMs;
  if (logStaleMs >= stallThresholdMs) {
    return { stalled: true, stalledMs: logStaleMs, type: "log-only", heartbeatActive: false };
  }

  return { stalled: false, stalledMs: logStaleMs, type: "not-stalled", heartbeatActive: false };
}

/**
 * Safely read a file's mtime. Returns `fallback` if the file doesn't exist or is unreadable.
 * Used for log files: missing log → treat as fresh (mtime=now), NOT stale (mtime=0).
 */
function readMtimeSafe(filePath: string, fallback: number): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return fallback;
  }
}
