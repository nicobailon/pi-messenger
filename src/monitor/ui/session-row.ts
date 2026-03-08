import type { SessionState } from "../types/session.js";
import type { HealthStatus } from "../health/types.js";
import type { AttentionReason } from "../types/attention.js";

export const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
} as const;

export type SessionRowData = {
  session: SessionState;
  health: HealthStatus;
  attention: AttentionReason | null;
  now: number;
  lastActivityAt: number;
};

const ELLIPSIS = "…";

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function colorize(value: string, color?: string): string {
  if (!color) return value;
  return `${color}${value}${ANSI.reset}`;
}

function truncateLine(
  segments: Array<{ text: string; color?: string }>,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return "";

  let rendered = "";
  let visible = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.text) continue;

    const chunk = i === 0 ? segment.text : ` ${segment.text}`;
    const remaining = maxWidth - visible;

    if (remaining <= 0) break;

    if (chunk.length <= remaining) {
      rendered += colorize(chunk, segment.color);
      visible += chunk.length;
      continue;
    }

    if (remaining === 1) {
      rendered += ELLIPSIS;
      break;
    }

    const keep = Math.max(0, remaining - 1);
    rendered += colorize(`${chunk.slice(0, keep)}${ELLIPSIS}`, segment.color);
    break;
  }

  return rendered;
}

function statusColor(status: SessionState["status"]): string {
  if (status === "active") return ANSI.green;
  if (status === "error") return ANSI.red;
  return ANSI.yellow;
}

function healthColor(health: HealthStatus): string {
  if (health === "healthy") return ANSI.green;
  if (health === "critical") return ANSI.red;
  return ANSI.yellow;
}

function statusFreshnessColor(ms: number): string {
  const age = Math.max(0, ms);

  if (age < 30_000) return ANSI.green;
  if (age < 120_000) return ANSI.yellow;
  return ANSI.red;
}

function attentionText(reason: AttentionReason): string {
  switch (reason) {
    case "waiting_on_human":
      return "waiting on human";
    case "failed_recoverable":
      return "retryable";
    case "stuck":
    case "degraded":
    case "stale_running":
      return "needs attention";
    case "high_error_rate":
      return "high error rate";
    case "repeated_retries":
      return "retrying";
    default: {
      // TypeScript exhaustiveness guard — unreachable at runtime.
      // Adding a new AttentionReason without updating this switch will cause a TSC error.
      const _exhaustive: never = reason;
      throw new Error(`Unhandled AttentionReason: ${String(_exhaustive)}`);
    }
  }
}

export function formatFreshness(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s ago`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  return `${totalHours}h ago`;
}

export function renderFreshnessBadge(ms: number): string {
  const age = Math.max(0, ms);
  const text = formatFreshness(age);

  if (age < 30_000) {
    return `${ANSI.green}${text}${ANSI.reset}`;
  }

  if (age < 120_000) {
    return `${ANSI.yellow}${text}${ANSI.reset}`;
  }

  return `${ANSI.red}${text}${ANSI.reset}`;
}

export function renderAttentionBadge(reason: AttentionReason): string {
  return `${ANSI.red}${attentionText(reason)}${ANSI.reset}`;
}

export function renderSessionRow(
  row: SessionRowData,
  options: { selected?: boolean; width?: number } = {},
): string {
  const prefix = options.selected ? "> " : "  ";
  const width = options.width;

  const name = row.session.metadata.name || row.session.metadata.id;
  const ageMs = Math.max(0, row.now - row.lastActivityAt);
  const freshness = formatFreshness(ageMs);
  const status = row.session.status;

  const segments: Array<{ text: string; color?: string }> = [
    { text: prefix },
    { text: status, color: statusColor(status) },
    { text: row.session.metadata.agent },
    { text: row.session.metadata.taskId ?? "" },
    { text: name },
    { text: freshness, color: statusFreshnessColor(ageMs) },
    {
      text: `${row.session.metrics.eventCount} events · ${row.session.metrics.toolCalls} tools`,
    },
  ];

  if (status === "active") {
    segments.push({ text: row.health, color: healthColor(row.health) });
  }

  if (row.attention) {
    segments.push({ text: attentionText(row.attention), color: ANSI.red });
  }

  const normalized = segments.filter((segment) => segment.text.length > 0);
  const joined = normalized.map((segment, index) => ({
    ...segment,
    text: index === 0 ? segment.text : ` ${segment.text}`,
  }));

  if (typeof width === "number") {
    return truncateLine(joined, width);
  }

  return joined.map((segment) => colorize(segment.text, segment.color)).join("");
}
