import { describe, expect, it, vi } from "vitest";
import { AttentionQueuePanel } from "../../../src/monitor/ui/attention.js";
import type { AttentionItem } from "../../../src/monitor/types/attention.js";

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "att-1",
    sessionId: "sess-1",
    reason: "stuck",
    message: "No progress for 2 minutes",
    recommendedAction: "Inspect the session and retry if it is blocked",
    timestamp: new Date("2026-03-08T12:00:00.000Z").toISOString(),
    ...overrides,
  };
}

describe("AttentionQueuePanel", () => {
  it("renders an empty state when there are no actionable items", () => {
    const panel = new AttentionQueuePanel();

    const lines = panel.render(80);
    const text = lines.join("\n");

    expect(text).toContain("Attention Queue");
    expect(text).toContain("No sessions require attention");
  });

  it("renders the session, reason, message, and next action for each item", () => {
    const panel = new AttentionQueuePanel();
    panel.setItems([
      makeItem({
        reason: "failed_recoverable",
        message: "Tool execution failed twice",
        recommendedAction: "Open the session detail and retry after fixing the command",
      }),
    ]);

    const lines = panel.render(100);
    const text = lines.join("\n");

    expect(text).toContain("sess-1");
    expect(text).toContain("failed");
    expect(text).toContain("Tool execution failed twice");
    expect(text).toContain("Next:");
    expect(text).toContain("retry after fixing the command");
  });

  it("moves selection with up/down keys and exposes the selected item", () => {
    const panel = new AttentionQueuePanel();
    const first = makeItem({ id: "att-1", sessionId: "sess-1" });
    const second = makeItem({ id: "att-2", sessionId: "sess-2", reason: "waiting_on_human" });
    panel.setItems([first, second]);

    expect(panel.getSelectedItem()).toEqual(first);

    panel.handleInput("down");
    expect(panel.getSelectedItem()).toEqual(second);

    panel.handleInput("up");
    expect(panel.getSelectedItem()).toEqual(first);
  });

  it("invokes onSelect with the selected attention item when Enter is pressed", () => {
    const panel = new AttentionQueuePanel();
    const item = makeItem({ id: "att-enter" });
    panel.setItems([item]);

    const onSelect = vi.fn();
    panel.onSelect(onSelect);

    panel.handleInput("enter");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(item);
  });
});
