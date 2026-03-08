/**
 * SessionDetailView — expanded single-session detail panel.
 *
 * Exported API:
 *   renderSessionDetailView(session, health, width, maxHeight, now) → string[]
 *   SessionDetailView class (stateful, scrollable)
 *   stripDetailAnsi(text) → string
 */

import { ANSI, stripAnsi } from "./session-row.js";
import type { SessionState } from "../types/session.js";
import type { HealthStatus, HealthAlert } from "../health/types.js";

// ─── Public re-export ────────────────────────────────────────────────────────

export function stripDetailAnsi(text: string): string {
  return stripAnsi(text);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const YYYY = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}Z`;
}

function formatDateTimeMs(ms: number): string {
  return formatDateTime(new Date(ms).toISOString());
}

function lastActivityTime(session: SessionState): string {
  const lastEvent = session.events.at(-1);
  return formatDateTime(lastEvent?.timestamp ?? session.metadata.startedAt);
}

function renderHealthLines(
  alert: HealthAlert | undefined,
  _width: number,
): string[] {
  if (!alert || !alert.explanation) return [];

  const exp = alert.explanation;
  return [
    `${ANSI.yellow}Health summary:${ANSI.reset} ${exp.summary}`,
    `${ANSI.dim}repeat ${exp.repeatCount} · history ${exp.historyCount}${ANSI.reset}`,
    `${ANSI.dim}Action:${ANSI.reset} ${exp.recommendedAction}`,
  ];
}


// ─── Rendering primitives ───────────────────────────────────────────────────

const ELLIPSIS = "…";

function colorize(value: string, color?: string): string {
  if (!color) return value;
  return `${color}${value}${ANSI.reset}`;
}

function truncateStyledLine(
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

interface EventStyle {
  icon: string;
  label: string;
  color: string;
}

function eventStyle(type: string): EventStyle {
  if (type === "agent.thinking") {
    return { icon: "🧠", label: "THINK", color: ANSI.yellow };
  }

  if (type === "tool.call") {
    return { icon: "🛠", label: "TOOL", color: ANSI.green };
  }

  if (type === "agent.progress") {
    return { icon: "📈", label: "PROGRESS", color: ANSI.green };
  }

  if (
    type === "execution.output" ||
    type === "execution.start" ||
    type === "execution.end"
  ) {
    return { icon: "⚡", label: "EXEC", color: ANSI.yellow };
  }

  if (type === "session.error") {
    return { icon: "❗", label: "ERROR", color: ANSI.red };
  }

  if (type === "session.end") {
    return { icon: "✅", label: "DONE", color: ANSI.green };
  }

  if (type === "session.start") {
    return { icon: "🚀", label: "START", color: ANSI.green };
  }

  return { icon: "ℹ", label: "INFO", color: ANSI.yellow };
}

function eventContent(type: string, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;

  switch (type) {
    case "agent.thinking":
    case "agent.progress":
      return typeof d["message"] === "string" ? d["message"] : "";
    case "tool.call": {
      const toolName = typeof d["toolName"] === "string" ? d["toolName"] : "unknown";
      return `Running ${toolName}`;
    }
    case "execution.output":
      return typeof d["text"] === "string" ? d["text"] : "";
    case "session.error":
      return typeof d["message"] === "string" ? d["message"] : "";
    case "session.end":
      return typeof d["summary"] === "string" ? d["summary"] : "";
    default:
      return "";
  }
}

// ─── Header rendering ────────────────────────────────────────────────────────

const HEADER_LINE_COUNT = 4;

function renderHeader(
  session: SessionState,
  health: HealthStatus,
  width: number,
  now: number,
): string[] {
  const sepLen = Math.max(0, width - 18);
  const sep = "─".repeat(sepLen);
  const lastActivity = lastActivityTime(session);

  return [
    `${ANSI.green}── Session Detail ${sep}${ANSI.reset}`,
    `  ${ANSI.yellow}Agent:${ANSI.reset} ${session.metadata.agent}  ${ANSI.yellow}Task:${ANSI.reset} ${session.metadata.taskId ?? ""}  ${ANSI.yellow}Status:${ANSI.reset} ${session.status}  ${ANSI.yellow}Health:${ANSI.reset} ${health}`,
    `  ${ANSI.yellow}Started:${ANSI.reset} ${formatDateTime(session.metadata.startedAt)}  ${ANSI.yellow}Last activity:${ANSI.reset} ${lastActivity}  ${ANSI.yellow}Now:${ANSI.reset} ${formatDateTimeMs(now)}`,
    "─".repeat(width),
  ];
}

function buildEventLines(session: SessionState, width: number): string[] {
  return session.events.map((event) => {
    const style = eventStyle(event.type);
    const content = eventContent(event.type, event.data);
    const time = formatDateTime(event.timestamp);

    const segments = [
      { text: `  [${time}]` },
      { text: `${style.icon} ${style.label}`, color: style.color },
      ...(content ? [{ text: content }] : []),
    ] as Array<{ text: string; color?: string }>;

    return truncateStyledLine(segments, width);
  });
}

// ─── Functional API ───────────────────────────────────────────────────────────

/**
 * Render a read-only snapshot of a session as an array of terminal lines.
 * Always auto-follows (shows the most recent events).
 */
export function renderSessionDetailView(
  session: SessionState,
  health: HealthStatus,
  width: number,
  maxHeight: number,
  now: number,
  alert?: HealthAlert,
): string[] {
  const header = renderHeader(session, health, width, now);
  const alertLines = renderHealthLines(alert, width);
  const eventLines = buildEventLines(session, width);

  const availableLines = Math.max(0, maxHeight - header.length - alertLines.length);
  const visible = eventLines.slice(-availableLines);

  return [...header, ...alertLines, ...visible];
}

// ─── Stateful class API ──────────────────────────────────────────────────────

/**
 * SessionDetailView — interactive, scrollable detail panel.
 *
 * Key inputs:
 *   'f'    — toggle auto-follow
 *   'home' — scroll to top (disables auto-follow)
 *   'end'  — scroll to bottom
 *   'up'   — scroll up one line
 *   'down' — scroll down one line
 */
export class SessionDetailView {
  private readonly maxHeight: number;
  private session: SessionState | null = null;
  private health: HealthStatus = "healthy";
  private alert?: HealthAlert;
  private autoFollow = true;
  private scrollOffset = 0; // index into event lines; 0 = top

  constructor(options: { maxHeight: number }) {
    this.maxHeight = options.maxHeight;
  }

  setSession(session: SessionState, opts: { health: HealthStatus; alert?: HealthAlert }): void {
    this.session = session;
    this.health = opts.health;
    this.alert = opts.alert;
    // When auto-following, jump to the end
    if (this.autoFollow) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
    }
  }

  handleInput(key: string): void {
    switch (key) {
      case "f":
        this.autoFollow = !this.autoFollow;
        if (this.autoFollow) {
          this.scrollOffset = Number.MAX_SAFE_INTEGER;
        }
        break;
      case "home":
        this.autoFollow = false;
        this.scrollOffset = 0;
        break;
      case "end":
        this.scrollOffset = Number.MAX_SAFE_INTEGER;
        break;
      case "up":
        this.autoFollow = false;
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        break;
      case "down":
        this.autoFollow = false;
        this.scrollOffset++;
        break;
    }
  }

  isAutoFollowEnabled(): boolean {
    return this.autoFollow;
  }

  render(width: number): string[] {
    if (!this.session) return [];

    const header = renderHeader(this.session, this.health, width, Date.now());
    const alertLines = renderHealthLines(this.alert, width);
    const eventLines = buildEventLines(this.session, width);
    const totalEvents = eventLines.length;
    const availableLines = Math.max(0, this.maxHeight - header.length - alertLines.length);

    let start: number;
    if (this.autoFollow || this.scrollOffset === Number.MAX_SAFE_INTEGER) {
      // Pin to bottom
      start = Math.max(0, totalEvents - availableLines);
    } else {
      // Clamp scroll to valid range
      const maxStart = Math.max(0, totalEvents - availableLines);
      start = Math.min(this.scrollOffset, maxStart);
    }

    const visible = eventLines.slice(start, start + availableLines);
    return [...header, ...alertLines, ...visible];
  }
}
