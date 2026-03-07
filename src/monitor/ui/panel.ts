/**
 * SessionMonitorPanel — pi TUI component for real-time session monitoring.
 *
 * Implements the Component and Focusable interfaces from @mariozechner/pi-tui,
 * following the pattern established in overlay.ts.
 */

import type { Component, Focusable } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { SessionState } from "../types/session.js";
import type { SessionFeedSubscriber } from "../feed/subscriber.js";
import type { SessionMetricsAggregator, ComputedMetrics } from "../metrics/aggregator.js";
import {
  renderSessionRow,
  renderStatusBadge,
  renderMetricsSummary,
  renderHealthIndicator,
  ANSI,
  type HealthStatus,
} from "./render.js";

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
 * A TUI panel that displays a real-time session list with status badges,
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

  /** Release resources (emitter subscriptions, timers). */
  dispose(): void {
    this.onEventUnsub?.();
    this.onEventUnsub = undefined;
  }

  // ─── Component interface ─────────────────────────────────────────────────────

  /**
   * Render the panel into an array of lines for the given viewport width.
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
    const dashTotal = Math.max(0, w - 2 - titleVisible - 2); // 2 spaces around title
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

    // ── Session rows ─────────────────────────────────────────────────────────
    if (this.sessions.length === 0) {
      lines.push(row(`${ANSI.dim}No active sessions${ANSI.reset}`));
    } else {
      const maxRows = this.maxHeight != null ? this.maxHeight - 3 : Infinity;
      let rowsRendered = 0;

      for (let i = 0; i < this.sessions.length; i++) {
        if (rowsRendered + 2 > maxRows) break;
        const session = this.sessions[i];
        const selected = i === this.selectedIndex;
        const sessionRows = renderSessionRow(session, selected, innerW);

        for (const sessionRow of sessionRows) {
          lines.push(row(sessionRow));
          rowsRendered++;
        }
      }
    }

    // ── Bottom border with legend ─────────────────────────────────────────────
    const legend =
      this.focused
        ? `${ANSI.dim}↑↓ navigate  ←→ scroll${ANSI.reset}`
        : "";
    const legendVisible = visibleWidth(legend);
    const bottomDashes = Math.max(0, w - 2 - legendVisible - (legendVisible > 0 ? 2 : 0));
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
   * ↑ / k — move selection up
   * ↓ / j — move selection down
   */
  handleInput(data: string): void {
    if (this.sessions.length === 0) return;

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.onChangeCallback?.();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(
        this.sessions.length - 1,
        this.selectedIndex + 1,
      );
      this.onChangeCallback?.();
    } else if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.onChangeCallback?.();
    } else if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, this.sessions.length - 1);
      this.onChangeCallback?.();
    }
  }

  /** Invalidate cached render state (none currently). */
  invalidate(): void {
    // No cached render state to clear
  }
}
