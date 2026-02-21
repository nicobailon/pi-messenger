import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeedEvent } from "../../feed.js";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
}));

const mockTheme = {
  fg: (style: string, text: string) => (style === "dim" ? `[dim]${text}[/dim]` : text),
};

describe("renderFeedSection (pure formatter)", () => {
  let renderFeedSection: typeof import("../../overlay-render.js").renderFeedSection;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../overlay-render.js");
    renderFeedSection = mod.renderFeedSection;
  });

  function makeEvent(ts: string, type: string, agent = "agent-1"): FeedEvent {
    return { ts, agent, type: type as FeedEvent["type"] };
  }

  it("returns empty for no events", () => {
    expect(renderFeedSection(mockTheme as any, [], 80, null)).toEqual([]);
  });

  it("renders all events as normal when lastSeenTs is null (first open)", () => {
    const events = [
      makeEvent("2026-01-01T00:00:00Z", "task.done"),
      makeEvent("2026-01-01T00:01:00Z", "task.start"),
    ];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("[dim]");
    }
  });

  it("highlights new events and dims old ones based on lastSeenTs", () => {
    const events = [
      makeEvent("2026-01-01T00:00:00Z", "join"),
      makeEvent("2026-01-01T00:01:00Z", "task.done"),
      makeEvent("2026-01-01T00:02:00Z", "task.start"),
    ];
    const lines = renderFeedSection(mockTheme as any, events, 80, "2026-01-01T00:00:30Z");
    expect(lines[0]).toContain("[dim]");
    expect(lines[1]).not.toContain("[dim]");
    expect(lines[2]).not.toContain("[dim]");
  });

  it("dims all events when lastSeenTs equals latest event ts", () => {
    const events = [
      makeEvent("2026-01-01T00:01:00Z", "join"),
    ];
    const lines = renderFeedSection(mockTheme as any, events, 80, "2026-01-01T00:01:00Z");
    expect(lines[0]).toContain("[dim]");
  });

  it("renders DM message with accent direction and body", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:01:00Z",
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "Are you exporting User from schema.ts?",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const joined = lines.join(" ");
    expect(joined).toContain("EpicGrove");
    expect(joined).toContain("OakBear");
    expect(joined).toContain("Are you exporting User from schema.ts?");
  });

  it("wraps long messages across multiple lines", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:01:00Z",
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "I've finished implementing the JWT middleware and exported AuthMiddleware, validateToken, and refreshTokenRotation from src/auth/middleware.ts",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("EpicGrove");
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toMatch(/^\s+/);
    }
    const joined = lines.join(" ");
    expect(joined).toContain("refreshTokenRotation");
  });

  it("renders broadcast message events with ✦ indicator", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:01:00Z",
      agent: "EpicGrove",
      type: "message",
      preview: "Starting task-1 — creating src/auth.ts",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const joined = lines.join(" ");
    expect(joined).toContain("\u2726");
    expect(joined).toContain("Starting task-1");
  });

  it("never dims message events even when old", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:00:00Z",
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "Hey there",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, "2026-01-01T00:01:00Z");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const joined = lines.join(" ");
    expect(joined).toContain("EpicGrove");
    expect(joined).toContain("Hey there");
    expect(joined).not.toContain("[dim]");
  });

  it("renders message with no preview as single header line", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:01:00Z",
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("→ OakBear");
  });

  it("interleaves messages with task events and adds separators", () => {
    const events: FeedEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "EpicGrove", type: "task.start", target: "task-1", preview: "Create auth" },
      { ts: "2026-01-01T00:01:00Z", agent: "EpicGrove", type: "message", target: "OakBear", preview: "Need User type" },
      { ts: "2026-01-01T00:02:00Z", agent: "OakBear", type: "task.done", target: "task-2", preview: "Schema done" },
    ];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    const joined = lines.join("\n");
    expect(joined).toContain("task-1");
    expect(joined).toContain("OakBear");
    expect(joined).toContain("Need User type");
    expect(joined).toContain("task-2");
    const separators = lines.filter(l => l.includes("·"));
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it("dims join/reserve system events even when new", () => {
    const events: FeedEvent[] = [
      { ts: "2026-01-01T00:01:00Z", agent: "EpicGrove", type: "join" },
      { ts: "2026-01-01T00:02:00Z", agent: "EpicGrove", type: "reserve", target: "src/auth.ts" },
    ];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    for (const line of lines) {
      expect(line).toContain("[dim]");
    }
  });

  it("renders short messages on single line when they fit", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:01:00Z",
      agent: "GoldHawk",
      type: "message",
      target: "RedYak",
      preview: "Got it!",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GoldHawk");
    expect(lines[0]).toContain("Got it!");
  });

  it("uses colored agent names in messages", () => {
    const events: FeedEvent[] = [{
      ts: "2026-01-01T00:01:00Z",
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "hello",
    }];
    const lines = renderFeedSection(mockTheme as any, events, 80, null);
    const joined = lines.join(" ");
    expect(joined).toContain("\x1b[");
  });
});
