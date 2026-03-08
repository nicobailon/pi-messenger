import type { Component, Focusable } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { AttentionItem } from "../types/attention.js";
import { ANSI, visibleLen } from "./render.js";

/**
 * Attention item reason badges for panel rendering.
 */
function renderReasonBadge(reason: AttentionItem["reason"]): string {
  switch (reason) {
    case "waiting_on_human":
      return `${ANSI.cyan}○ waiting${ANSI.reset}`;
    case "stuck":
      return `${ANSI.red}✖ stuck${ANSI.reset}`;
    case "degraded":
      return `${ANSI.yellow}⚠ degraded${ANSI.reset}`;
    case "high_error_rate":
      return `${ANSI.red}⚠ high errors${ANSI.reset}`;
    case "repeated_retries":
      return `${ANSI.yellow}↻ retries${ANSI.reset}`;
    case "failed_recoverable":
      return `${ANSI.red}✖ failed${ANSI.reset}`;
    case "stale_running":
      return `${ANSI.blue}… stale${ANSI.reset}`;
    default:
      return `${ANSI.gray}? unknown${ANSI.reset}`;
  }
}

export interface AttentionQueuePanelOptions {
  /** Panel title (default: "Attention Queue") */
  title?: string;
  /** Maximum height in rows (default: auto) */
  maxHeight?: number;
}

/**
 * A TUI panel that renders active items from the Attention Queue.
 */
export class AttentionQueuePanel implements Component, Focusable {
  /** Set by TUI when focus changes. */
  focused = false;

  private items: AttentionItem[] = [];
  private selectedIndex = 0;
  private title: string;
  private maxHeight?: number;
  private onChangeCallback?: () => void;

  constructor(options?: AttentionQueuePanelOptions) {
    this.title = options?.title ?? "Attention Queue";
    this.maxHeight = options?.maxHeight;
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /** Replace queued items and clamp selection. */
  setItems(items: AttentionItem[]): void {
    this.items = items;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
    this.onChangeCallback?.();
  }

  /** Return the currently selected item, or null if empty. */
  getSelectedItem(): AttentionItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  /** Register a callback invoked whenever data changes. */
  onChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  /** Render the panel into an array of lines for the given viewport width. */
  render(width: number): string[] {
    const w = Math.max(20, width);
    const innerW = w - 4; // 2-char border on each side, 1 space pad each side
    const border = (s: string) => `${ANSI.dim}${s}${ANSI.reset}`;

    const pad = (s: string, len: number) =>
      s + " ".repeat(Math.max(0, len - visibleWidth(s)));

    const row = (content: string) =>
      border("│") + " " + pad(content, innerW) + " " + border("│");

    const lines: string[] = [];

    // ── Top border with title ────────────────────────────────────────────
    const titleLabel = `${ANSI.bold}${this.title}${ANSI.reset}`;
    const titleVisible = visibleLen(titleLabel);
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

    if (this.items.length === 0) {
      lines.push(row(`${ANSI.dim}No sessions require attention${ANSI.reset}`));
    } else {
      const maxRows = this.maxHeight != null ? this.maxHeight - 3 : Infinity;
      let rowsRendered = 0;

      for (let i = 0; i < this.items.length; i++) {
        if (rowsRendered + 2 > maxRows) break;
        const item = this.items[i];
        const selected = i === this.selectedIndex;

        const prefix = selected ? "> " : "  ";
        const badge = renderReasonBadge(item.reason);

        const row1 = `${prefix}${badge} ${item.sessionId} · ${item.reason}`;
        const row2 = `    ${ANSI.dim}${item.message}${ANSI.reset}`;
        const row3 = `    ${ANSI.dim}↳ ${item.recommendedAction}${ANSI.reset}`;

        // Keep each visible row aligned.
        lines.push(row(row1));
        rowsRendered++;
        lines.push(row(row2));
        rowsRendered++;

        // Only add the recommended-action row when there is room.
        if (rowsRendered + 1 <= maxRows) {
          lines.push(row(row3));
          rowsRendered++;
        }
      }
    }

    const legend = this.focused ? `${ANSI.dim}↑↓ navigate${ANSI.reset}` : "";
    const legendVisible = visibleLen(legend);
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

  /** Handle keyboard input when panel has focus. */
  handleInput(data: string): void {
    if (this.items.length === 0) return;

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.onChangeCallback?.();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      this.onChangeCallback?.();
    } else if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.onChangeCallback?.();
    } else if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, this.items.length - 1);
      this.onChangeCallback?.();
    }
  }

  /** Invalidate cached render state (none currently). */
  invalidate(): void {
    // No cached render state to clear.
  }

  dispose(): void {
    this.onChangeCallback = undefined;
  }
}
