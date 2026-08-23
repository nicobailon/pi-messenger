import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));

function createMockPi() {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

describe("agent message renderer", () => {
  it("renders persisted message and ts details without crashing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:01:00.000Z"));
    try {
      const pi = createMockPi();
      const { default: piMessengerExtension } = await import("../index.ts");
      piMessengerExtension(pi as unknown as ExtensionAPI);

      const rendererFactory = pi.registerMessageRenderer.mock.calls.find(
        ([customType]) => customType === "agent_message",
      )?.[1];

      const renderer = rendererFactory(
        { details: { from: "\u001b[31mPeer\u001b[0m", to: "Self", message: "\u001b[32mHistorical body\u001b[0m", ts: "2026-08-23T12:00:00.000Z" } },
        {},
        { fg: (_color: string, text: string) => text },
      );

      expect(renderer.render(80)).toEqual([
        "From Peer (1m ago)",
        "",
        "Historical body",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
