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
import type { HealthStatus } from "../health/types.js";

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

// ─── Event rendering ─────────────────────────────────────────────────────────

function eventLabel(type: string): string {
  switch (type) {
    case "agent.thinking":
      return "THINK";
    case "tool.call":
      return "TOOL";
    case "agent.progress":
      return "PROGRESS";
    case "execution.output":
    case "execution.start":
    case "execution.end":
      return "EXEC";
    case "session.error":
      return "ERROR";
    case "session.end":
      return "DONE";
    case "session.start":
      return "START";
    default:
      return "INFO";
  }
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

  return [
    `${ANSI.green}── Session Detail ${sep}${ANSI.reset}`,
    `  ${ANSI.yellow}Agent:${ANSI.reset} ${session.metadata.agent}  ${ANSI.yellow}Task:${ANSI.reset} ${session.metadata.taskId ?? ""}  ${ANSI.yellow}Status:${ANSI.reset} ${session.status}  ${ANSI.yellow}Health:${ANSI.reset} ${health}`,
    `  ${ANSI.yellow}Started:${ANSI.reset} ${formatDateTime(session.metadata.startedAt)}  ${ANSI.yellow}Now:${ANSI.reset} ${formatDateTimeMs(now)}`,
    "─".repeat(width),
  ];
}

function buildEventLines(session: SessionState): string[] {
  return session.events.map((event) => {
    const label = eventLabel(event.type);
    const content = eventContent(event.type, event.data);
    const time = formatDateTime(event.timestamp);
    return `  [${time}] ${label}${content ? " " + content : ""}`;
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
): string[] {
  const header = renderHeader(session, health, width, now);
  const eventLines = buildEventLines(session);

  const availableLines = Math.max(0, maxHeight - header.length);
  const visible = eventLines.slice(-availableLines);

  return [...header, ...visible];
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
  private autoFollow = true;
  private scrollOffset = 0; // index into event lines; 0 = top

  constructor(options: { maxHeight: number }) {
    this.maxHeight = options.maxHeight;
  }

  setSession(session: SessionState, opts: { health: HealthStatus }): void {
    this.session = session;
    this.health = opts.health;
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
    const eventLines = buildEventLines(this.session);
    const totalEvents = eventLines.length;
    const availableLines = Math.max(0, this.maxHeight - header.length);

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
    return [...header, ...visible];
  }
}
