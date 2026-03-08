/**
 * SessionMonitorPanel — pi TUI component for real-time session monitoring.
 *
 * Provides grouped session overview (task-3): Running, Queued, Completed, Failed.
 */

import type { SessionState } from "../types/session.js";
import type { SessionFeedSubscriber } from "../feed/subscriber.js";
import type { SessionMetricsAggregator } from "../metrics/aggregator.js";
import {
  renderGroupedSessions,
  ANSI,
} from "./render.js";

// ─── Minimal local interfaces ─────────────────────────────────────────────────

/** Minimal Component interface for TUI panels. */
export interface Component {
  render(width: number): string[];
}

/** Minimal Focusable interface for TUI panels. */
export interface Focusable {
  focused: boolean;
  handleInput(data: string): void;
  invalidate(): void;
}

// ─── Inline key-matching helpers ─────────────────────────────────────────────

/** Returns the visible character count of a string (strips ANSI codes). */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Returns true when raw terminal input `data` matches the named key.
 * Accepts both ANSI escape sequences AND literal key name strings (e.g. "down")
 * for testability.
 */
function matchesKey(
  data: string,
  key: "up" | "down" | "left" | "right" | "home" | "end" | "enter",
): boolean {
  switch (key) {
    case "up":
      return data === "\x1b[A" || data === "\x1bOA" || data === "up";
    case "down":
      return data === "\x1b[B" || data === "\x1bOB" || data === "down";
    case "left":
      return data === "\x1b[D" || data === "\x1bOD" || data === "left";
    case "right":
      return data === "\x1b[C" || data === "\x1bOC" || data === "right";
    case "home":
      return data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH" || data === "home";
    case "end":
      return data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF" || data === "end";
    case "enter":
      return data === "\r" || data === "\n" || data === "enter";
    default:
      return false;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionMonitorPanelOptions {
  /** Optional feed subscriber for live event updates */
  subscriber?: SessionFeedSubscriber;
  /** Optional metrics aggregator for live metric display */
  aggregator?: SessionMetricsAggregator;
  /** Panel title (default: "Session Monitor") */
  title?: string;
  /** Maximum height in rows (default: auto) */
  maxHeight?: number;
}

// ─── SessionMonitorPanel ──────────────────────────────────────────────────────

/**
 * A TUI panel that displays a grouped session list with status badges,
 * live metrics, health indicators, and keyboard navigation.
 */
export class SessionMonitorPanel implements Component, Focusable {
  /** Set by TUI when focus changes. */
  focused = false;

  private sessions: SessionState[] = [];
  private selectedIndex = 0;
  private subscriber?: SessionFeedSubscriber;
  private aggregator?: SessionMetricsAggregator;
  private title: string;
  private maxHeight?: number;
  private onEventUnsub?: () => void;
  private onChangeCallback?: () => void;
  private onSelectCallback?: (session: SessionState) => void;

  constructor(options?: SessionMonitorPanelOptions) {
    this.subscriber = options?.subscriber;
    this.aggregator = options?.aggregator;
    this.title = options?.title ?? "Session Monitor";
    this.maxHeight = options?.maxHeight;

    // Wire up live event notifications
    if (this.subscriber) {
      this.onEventUnsub = this.subscriber.onEvent(() => {
        this.onChangeCallback?.();
      });
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Replace the session list and clamp the selection. */
  setSessions(sessions: SessionState[]): void {
    this.sessions = sessions;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, sessions.length - 1),
    );
    this.onChangeCallback?.();
  }

  /** Return the currently selected session, or null if the list is empty. */
  getSelectedSession(): SessionState | null {
    return this.sessions[this.selectedIndex] ?? null;
  }

  /** Register a callback invoked whenever the panel's data changes. */
  onChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  /**
   * Register a callback invoked when the user selects a session (Enter key).
   * Called with the currently selected session.
   */
  onSelect(cb: (session: SessionState) => void): void {
    this.onSelectCallback = cb;
  }

  /** Release resources (emitter subscriptions, timers). */
  dispose(): void {
    this.onEventUnsub?.();
    this.onEventUnsub = undefined;
  }

  // ─── Component interface ─────────────────────────────────────────────────────

  /**
   * Render the panel into an array of lines for the given viewport width.
   * Uses renderGroupedSessions to show Running/Queued/Completed/Failed sections.
   */
  render(width: number): string[] {
    const w = Math.max(20, width);
    const innerW = w - 4; // 2-char border on each side, 1 space pad each side
    const border = (s: string) => `${ANSI.dim}${s}${ANSI.reset}`;

    const pad = (s: string, len: number) =>
      s + " ".repeat(Math.max(0, len - visibleWidth(s)));

    const row = (content: string) =>
      border("│") + " " + pad(content, innerW) + " " + border("│");

    const lines: string[] = [];

    // ── Top border with title ────────────────────────────────────────────────
    const titleLabel = `${ANSI.bold}${this.title}${ANSI.reset}`;
    const titleVisible = visibleWidth(titleLabel);
    const dashTotal = Math.max(0, w - 2 - titleVisible - 2);
    const dashLeft = Math.floor(dashTotal / 2);
    const dashRight = dashTotal - dashLeft;

    lines.push(
      border(
        "╭" +
          "─".repeat(dashLeft) +
          " " +
          titleLabel +
          " " +
          "─".repeat(dashRight) +
          "╮",
      ),
    );

    // ── Session rows (grouped) ───────────────────────────────────────────────
    if (this.sessions.length === 0) {
      lines.push(row(`${ANSI.dim}No active sessions${ANSI.reset}`));
    } else {
      const groupedRows = renderGroupedSessions(
        this.sessions,
        this.selectedIndex,
        innerW,
      );
      const maxRows = this.maxHeight != null ? this.maxHeight - 3 : Infinity;
      let rowsRendered = 0;

      for (const groupedRow of groupedRows) {
        if (rowsRendered >= maxRows) break;
        lines.push(row(groupedRow));
        rowsRendered++;
      }
    }

    // ── Bottom border with legend ─────────────────────────────────────────────
    const legend =
      this.focused
        ? `${ANSI.dim}↑↓ navigate  Enter select${ANSI.reset}`
        : "";
    const legendVisible = visibleWidth(legend);
    const bottomDashes = Math.max(
      0,
      w - 2 - legendVisible - (legendVisible > 0 ? 2 : 0),
    );
    const bottomLeft = Math.floor(bottomDashes / 2);
    const bottomRight = bottomDashes - bottomLeft;

    if (legendVisible > 0) {
      lines.push(
        border(
          "╰" +
            "─".repeat(bottomLeft) +
            " " +
            legend +
            " " +
            "─".repeat(bottomRight) +
            "╯",
        ),
      );
    } else {
      lines.push(border("╰" + "─".repeat(w - 2) + "╯"));
    }

    return lines;
  }

  /**
   * Handle keyboard input when the panel has focus.
   * ↑ / k        — move selection up
   * ↓ / j        — move selection down
   * Enter        — open detail view (calls onSelect callback)
   * Home / End   — jump to first / last session
   */
  handleInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") {
      if (this.sessions.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.onChangeCallback?.();
    } else if (matchesKey(data, "down") || data === "j") {
      if (this.sessions.length === 0) return;
      this.selectedIndex = Math.min(
        this.sessions.length - 1,
        this.selectedIndex + 1,
      );
      this.onChangeCallback?.();
    } else if (matchesKey(data, "home")) {
      if (this.sessions.length === 0) return;
      this.selectedIndex = 0;
      this.onChangeCallback?.();
    } else if (matchesKey(data, "end")) {
      if (this.sessions.length === 0) return;
      this.selectedIndex = Math.max(0, this.sessions.length - 1);
      this.onChangeCallback?.();
    } else if (matchesKey(data, "enter")) {
      const session = this.getSelectedSession();
      if (session && this.onSelectCallback) {
        this.onSelectCallback(session);
      }
    }
  }

  /** Invalidate cached render state (none currently). */
  invalidate(): void {
    // No cached render state to clear
  }
}
