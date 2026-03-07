/**
 * Pure render functions for the session monitor TUI panel.
 * No side effects — each function takes data and returns strings.
 */

import type { SessionState, SessionStatus, SessionMetrics } from "../types/session.js";

// ─── ANSI color constants ─────────────────────────────────────────────────────

export const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

// ─── Health status type ───────────────────────────────────────────────────────

/** Local HealthStatus definition (mirrors src/monitor/health/types.ts) */
export type HealthStatus = "healthy" | "degraded" | "critical";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Format a millisecond duration into a human-readable string.
 * e.g. 90_000 → "1m 30s", 3_600_000 → "1h 0m"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Strip ANSI escape sequences to measure visible character width.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Return the number of visible (non-ANSI) characters in a string.
 */
export function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Pad a string (which may contain ANSI codes) to a given visible width.
 */
function padToVisible(s: string, targetWidth: number): string {
  const visible = visibleLen(s);
  const pad = Math.max(0, targetWidth - visible);
  return s + " ".repeat(pad);
}

// ─── Render functions ─────────────────────────────────────────────────────────

/**
 * Render a colored status badge for a session status.
 *
 * Color mapping:
 *   active  → green
 *   paused  → yellow
 *   error   → red
 *   ended   → gray
 *   idle    → gray
 */
export function renderStatusBadge(status: SessionStatus): string {
  switch (status) {
    case "active":
      return `${ANSI.green}● active${ANSI.reset}`;
    case "paused":
      return `${ANSI.yellow}◐ paused${ANSI.reset}`;
    case "error":
      return `${ANSI.red}✖ error${ANSI.reset}`;
    case "ended":
      return `${ANSI.gray}○ ended${ANSI.reset}`;
    case "idle":
      return `${ANSI.gray}· idle${ANSI.reset}`;
    default:
      return `${ANSI.gray}? unknown${ANSI.reset}`;
  }
}

/**
 * Render a one-line metrics summary string.
 *
 * Format: "<duration> | <N> events | <N> errors | <N> tools"
 */
export function renderMetricsSummary(metrics: SessionMetrics): string {
  const duration = formatDuration(metrics.duration);
  return `${duration} | ${metrics.eventCount} events | ${metrics.errorCount} errors | ${metrics.toolCalls} tools`;
}

/**
 * Render a health status indicator string with color.
 *
 * Color mapping:
 *   healthy  → green
 *   degraded → yellow
 *   critical → red
 */
export function renderHealthIndicator(health: HealthStatus): string {
  switch (health) {
    case "healthy":
      return `${ANSI.green}✓ healthy${ANSI.reset}`;
    case "degraded":
      return `${ANSI.yellow}⚠ degraded${ANSI.reset}`;
    case "critical":
      return `${ANSI.red}✖ critical${ANSI.reset}`;
    default:
      return `${ANSI.gray}? unknown${ANSI.reset}`;
  }
}

/**
 * Render a session as a two-line row for the monitor panel.
 *
 * Line 0: [>|  ] <status badge> <session name>
 * Line 1:      <dim metrics summary>
 *
 * @param session   The session state to render.
 * @param selected  Whether this row is the currently selected row.
 * @param width     Optional maximum visible width (default: 80). Content is
 *                  padded to this width so rows align in the panel.
 * @returns         Two strings (the two lines of the row).
 */
export function renderSessionRow(
  session: SessionState,
  selected: boolean,
  width = 80,
): string[] {
  const innerWidth = Math.max(10, width);
  const prefix = selected ? "> " : "  ";
  const name = session.metadata.name || session.metadata.id;
  const badge = renderStatusBadge(session.status);

  // Line 1: prefix + badge + name
  const line1Raw = `${prefix}${badge} ${name}`;
  const line1 = padToVisible(line1Raw, innerWidth);

  // Line 2: indented metrics (dim)
  const metrics = renderMetricsSummary(session.metrics);
  const line2Raw = `     ${ANSI.dim}${metrics}${ANSI.reset}`;
  const line2 = padToVisible(line2Raw, innerWidth);

  return [line1, line2];
}
