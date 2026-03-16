import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendFeedEvent,
  formatFeedLine,
  isCrewEvent,
  logFeedEvent,
  pruneFeed,
  readFeedByThread,
  readFeedEvents,
  searchFeed,
} from "../feed.js";
import { createTempCrewDirs } from "./helpers/temp-dirs.js";

describe("feed", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("writes events to the project-scoped feed path", () => {
    logFeedEvent(cwd, "AgentOne", "join");

    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    expect(fs.existsSync(feedFile)).toBe(true);
    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
  });

  it("reads events back in append order and respects limit", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "src/app.ts");
    logFeedEvent(cwd, "AgentOne", "commit", undefined, "ship feed scope");

    const allEvents = readFeedEvents(cwd, 20);
    expect(allEvents).toHaveLength(3);
    expect(allEvents.map(e => e.type)).toEqual(["join", "edit", "commit"]);

    const limited = readFeedEvents(cwd, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map(e => e.type)).toEqual(["edit", "commit"]);
  });

  it("isolates feeds between project directories", () => {
    const otherCwd = createTempCrewDirs().cwd;

    logFeedEvent(cwd, "AgentOne", "join");

    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
    expect(readFeedEvents(otherCwd, 20)).toEqual([]);
  });

  it("prunes events within the project-scoped feed", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "a.ts");
    logFeedEvent(cwd, "AgentOne", "edit", "b.ts");
    logFeedEvent(cwd, "AgentOne", "test", undefined, "passed");

    pruneFeed(cwd, 2);

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.type)).toEqual(["edit", "test"]);
    expect(events[0]?.target).toBe("b.ts");
  });

  it("formats planning events with previews and marks them as crew events", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-11T10:00:00.000Z").toISOString(),
      agent: "Planner",
      type: "plan.pass.start",
      target: "docs/PRD.md",
      preview: "pass 2/3",
    });

    expect(line).toContain("[Crew]");
    expect(line).toContain("planning pass started");
    expect(line).toContain("pass 2/3");
    expect(isCrewEvent("plan.pass.start")).toBe(true);
    expect(isCrewEvent("plan.done")).toBe(true);
    expect(isCrewEvent("message")).toBe(false);
  });

  it("formats DM message events using target for direction", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "Hey, are you exporting the User type?",
    });
    expect(line).toContain("EpicGrove");
    expect(line).toContain("→ OakBear");
    expect(line).toContain("Hey, are you exporting the User type?");
  });

  it("formats broadcast message events with ✦ indicator", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "EpicGrove",
      type: "message",
      preview: "Starting task-1 — creating src/auth.ts",
    });
    expect(line).toContain("EpicGrove");
    expect(line).toContain("✦");
    expect(line).toContain("Starting task-1");
    expect(line).not.toContain("→");
  });

  it("truncates long message previews in formatFeedLine", () => {
    const longMsg = "A".repeat(150);
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "Agent",
      type: "message",
      target: "Peer",
      preview: longMsg,
    });
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(200);
  });

  it("normalizes multiline preview text into a single line", () => {
    logFeedEvent(cwd, "AgentOne", "message", "Peer", "Line one\nLine two\tLine three");

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.preview).toBe("Line one Line two Line three");

    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "AgentOne",
      type: "commit",
      preview: "feat(scope): add thing\n\nBody details",
    });
    expect(line).toContain("feat(scope): add thing Body details");
    expect(line).not.toContain("\n");
  });

  it("returns an empty array when the feed file does not exist", () => {
    const freshCwd = createTempCrewDirs().cwd;
    expect(readFeedEvents(freshCwd, 20)).toEqual([]);
  });
});

describe("threadId auto-assignment", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("should auto-assign threadId from task target", () => {
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "AgentOne",
      type: "task.start",
      target: "task-5",
    });

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.threadId).toBe("task-5");
  });

  it("should NOT auto-assign threadId for non-task targets", () => {
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "AgentOne",
      type: "message",
      target: "some-agent",
    });

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.threadId).toBeUndefined();
  });

  it("should preserve an explicitly provided threadId", () => {
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "AgentOne",
      type: "task.progress",
      target: "task-3",
      threadId: "task-3",
      preview: "50% done",
    });

    const events = readFeedEvents(cwd, 20);
    expect(events[0]?.threadId).toBe("task-3");
  });

  it("should NOT auto-assign threadId when target is missing", () => {
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "AgentOne",
      type: "join",
    });

    const events = readFeedEvents(cwd, 20);
    expect(events[0]?.threadId).toBeUndefined();
  });
});

describe("searchFeed", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("should find events matching regex query in preview", () => {
    logFeedEvent(cwd, "AgentA", "message", undefined, "deploying to production");
    logFeedEvent(cwd, "AgentB", "message", undefined, "running tests");
    logFeedEvent(cwd, "AgentC", "message", undefined, "deploy to staging");

    const results = searchFeed(cwd, "deploy");
    expect(results).toHaveLength(2);
    expect(results.every(e => /deploy/i.test(e.preview ?? ""))).toBe(true);
  });

  it("should search across agent field", () => {
    logFeedEvent(cwd, "SearchableBot", "join");
    logFeedEvent(cwd, "OtherAgent", "join");

    const results = searchFeed(cwd, "SearchableBot");
    expect(results).toHaveLength(1);
    expect(results[0]?.agent).toBe("SearchableBot");
  });

  it("should search across type field", () => {
    logFeedEvent(cwd, "AgentA", "task.progress", "task-1", "50%");
    logFeedEvent(cwd, "AgentB", "message", undefined, "hello");

    const results = searchFeed(cwd, "task\\.progress");
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("task.progress");
  });

  it("should search across target field", () => {
    logFeedEvent(cwd, "AgentA", "task.start", "task-42");
    logFeedEvent(cwd, "AgentA", "task.start", "task-99");

    const results = searchFeed(cwd, "task-42");
    expect(results).toHaveLength(1);
    expect(results[0]?.target).toBe("task-42");
  });

  it("should filter by since option (milliseconds ago)", async () => {
    // Write an "old" event by directly writing to the feed file
    const feedDir = path.join(cwd, ".pi", "messenger");
    fs.mkdirSync(feedDir, { recursive: true });
    const feedFile = path.join(feedDir, "feed.jsonl");
    const oldTs = new Date(Date.now() - 60_000).toISOString(); // 60s ago
    fs.writeFileSync(feedFile, JSON.stringify({ ts: oldTs, agent: "OldAgent", type: "message", preview: "old message" }) + "\n");

    // Write a recent event
    logFeedEvent(cwd, "NewAgent", "message", undefined, "new message");

    // since: 30s — should only see the recent event
    const results = searchFeed(cwd, "message", { since: 30_000 });
    expect(results).toHaveLength(1);
    expect(results[0]?.agent).toBe("NewAgent");
  });

  it("should respect limit option", () => {
    for (let i = 0; i < 10; i++) {
      logFeedEvent(cwd, "Agent", "message", undefined, `message ${i}`);
    }

    const results = searchFeed(cwd, "message", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("should return empty array when no events match", () => {
    logFeedEvent(cwd, "AgentA", "join");
    const results = searchFeed(cwd, "nonexistent-xyz-abc");
    expect(results).toHaveLength(0);
  });

  it("should be case-insensitive", () => {
    logFeedEvent(cwd, "AgentA", "message", undefined, "Hello World");
    const results = searchFeed(cwd, "hello world");
    expect(results).toHaveLength(1);
  });
});

describe("readFeedByThread", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("should group events by threadId", () => {
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "A", type: "task.start", target: "task-1" });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "A", type: "task.progress", target: "task-1", threadId: "task-1", preview: "50%" });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "B", type: "task.start", target: "task-2" });

    const threads = readFeedByThread(cwd, 50);
    expect(threads.has("task-1")).toBe(true);
    expect(threads.has("task-2")).toBe(true);
    expect(threads.get("task-1")!.length).toBe(2);
    expect(threads.get("task-2")!.length).toBe(1);
  });

  it("should place events without threadId in __global", () => {
    logFeedEvent(cwd, "AgentA", "join");
    logFeedEvent(cwd, "AgentB", "message", "someone", "hey");

    const threads = readFeedByThread(cwd, 50);
    expect(threads.has("__global")).toBe(true);
    expect(threads.get("__global")!.length).toBe(2);
  });

  it("should return empty Map when no events exist", () => {
    const threads = readFeedByThread(cwd, 50);
    expect(threads.size).toBe(0);
  });

  it("should respect the limit parameter", () => {
    for (let i = 1; i <= 10; i++) {
      logFeedEvent(cwd, "Agent", "join");
    }

    const threads = readFeedByThread(cwd, 3);
    const allEvents = [...threads.values()].flat();
    expect(allEvents.length).toBeLessThanOrEqual(3);
  });
});

describe("backward compatibility", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("should parse old events without new fields gracefully", () => {
    const feedDir = path.join(cwd, ".pi", "messenger");
    fs.mkdirSync(feedDir, { recursive: true });
    const feedFile = path.join(feedDir, "feed.jsonl");

    // Minimal old-style event
    const oldEvent = { ts: new Date().toISOString(), agent: "OldAgent", type: "join" };
    fs.writeFileSync(feedFile, JSON.stringify(oldEvent) + "\n");

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.agent).toBe("OldAgent");
    expect(events[0]?.type).toBe("join");
    expect(events[0]?.threadId).toBeUndefined();
    expect(events[0]?.content).toBeUndefined();
    expect(events[0]?.reactionTo).toBeUndefined();
    expect(events[0]?.emoji).toBeUndefined();
    expect(events[0]?.severity).toBeUndefined();
    expect(events[0]?.metadata).toBeUndefined();
  });

  it("should skip malformed lines and continue parsing", () => {
    const feedDir = path.join(cwd, ".pi", "messenger");
    fs.mkdirSync(feedDir, { recursive: true });
    const feedFile = path.join(feedDir, "feed.jsonl");

    const goodEvent = { ts: new Date().toISOString(), agent: "GoodAgent", type: "join" };
    fs.writeFileSync(feedFile, [
      JSON.stringify(goodEvent),
      "NOT VALID JSON {{{",
      JSON.stringify({ ...goodEvent, agent: "AnotherGoodAgent" }),
    ].join("\n") + "\n");

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events[0]?.agent).toBe("GoodAgent");
    expect(events[1]?.agent).toBe("AnotherGoodAgent");
  });
});

describe("new event types", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("should format agent.health events correctly", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Helios",
      type: "agent.health",
      target: "task-1",
      preview: "degraded Φ=3.2 — no recent heartbeat",
    });
    expect(line).toContain("degraded Φ=3.2");
    expect(line).toContain("Helios");
  });

  it("should include severity badge in agent.health when severity is set", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Watchdog",
      type: "agent.health",
      severity: "critical",
      preview: "no heartbeat for 300s",
    });
    expect(line).toContain("[critical]");
    expect(line).toContain("no heartbeat for 300s");
  });

  it("should show severity badge even when preview is absent in agent.health", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Watchdog",
      type: "agent.health",
      severity: "warn",
    });
    expect(line).toContain("[warn]");
    expect(line).not.toContain("health event");
  });

  it("should fall back to health event when no severity and no preview in agent.health", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Watchdog",
      type: "agent.health",
    });
    expect(line).toContain("health event");
  });

  it("should format task.progress events correctly", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "task.progress",
      target: "task-3",
      preview: "75% — building auth module",
    });
    expect(line).toContain("📊 75%");
  });

  it("should fall back to progress update when no preview in task.progress", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "task.progress",
    });
    expect(line).toContain("progress update");
  });

  it("should format task.heartbeat events correctly", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "task.heartbeat",
      target: "task-3",
      preview: "still running",
    });
    expect(line).toContain("💓 still running");
  });

  it("should fall back to heartbeating when no preview in task.heartbeat", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "task.heartbeat",
    });
    expect(line).toContain("heartbeating");
  });

  it("should format suggestion.new events correctly", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Hema",
      type: "suggestion.new",
      preview: "consider memoizing the result",
    });
    expect(line).toContain("💡 suggestion:");
    expect(line).toContain("consider memoizing");
  });

  it("should format suggestion.approved events correctly", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Helios",
      type: "suggestion.approved",
      preview: "memoization applied",
    });
    expect(line).toContain("✅ approved:");
  });

  it("should format suggestion.rejected events correctly", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Helios",
      type: "suggestion.rejected",
      preview: "not applicable here",
    });
    expect(line).toContain("❌ rejected:");
  });

  it("should format reaction events with emoji", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Human",
      type: "reaction",
      target: "task-1",
      emoji: "✅",
      reactionTo: "2026-01-01T00:00:00.000Z",
      preview: "✅ on approve this",
    });
    expect(line).toContain("✅");
    expect(line).toContain("reacted to");
    expect(line).toContain("task-1");
  });

  it("should use default emoji when emoji field is absent for reaction", () => {
    const line = formatFeedLine({
      ts: new Date().toISOString(),
      agent: "Human",
      type: "reaction",
      target: "task-2",
    });
    expect(line).toContain("👍");
    expect(line).toContain("reacted to");
  });

  it("should persist and read back new event types from feed", () => {
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "task.progress",
      target: "task-5",
      preview: "25% done",
      severity: "info",
      metadata: { percentage: 25 },
    });

    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "Human",
      type: "reaction",
      target: "task-5",
      emoji: "🔄",
      reactionTo: "some-ts",
    });

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("task.progress");
    expect(events[0]?.severity).toBe("info");
    expect(events[0]?.metadata?.percentage).toBe(25);
    expect(events[1]?.type).toBe("reaction");
    expect(events[1]?.emoji).toBe("🔄");
    expect(events[1]?.reactionTo).toBe("some-ts");
  });
});

describe("MessageContent", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("should serialize and deserialize MessageContent array", () => {
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "message",
      content: [
        { type: "code", content: "const x = 1;", lang: "ts" },
        { type: "text", content: "This is a text block" },
      ],
    });

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    const content = events[0]?.content;
    expect(content).toBeDefined();
    expect(content).toHaveLength(2);
    expect(content![0]?.type).toBe("code");
    expect(content![0]?.content).toBe("const x = 1;");
    expect(content![0]?.lang).toBe("ts");
    expect(content![1]?.type).toBe("text");
    expect(content![1]?.content).toBe("This is a text block");
  });

  it("should handle all MessageContent types", () => {
    const contentBlocks = [
      { type: "text" as const, content: "plain text" },
      { type: "code" as const, content: "fn main() {}", lang: "rust" },
      { type: "diff" as const, content: "-old\n+new" },
      { type: "file" as const, content: "file contents", path: "src/main.rs" },
      { type: "table" as const, content: "| a | b |\n|---|---|\n| 1 | 2 |" },
    ];

    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "Worker",
      type: "message",
      content: contentBlocks,
    });

    const events = readFeedEvents(cwd, 20);
    const content = events[0]?.content;
    expect(content).toHaveLength(5);
    expect(content![2]?.type).toBe("diff");
    expect(content![3]?.path).toBe("src/main.rs");
    expect(content![4]?.type).toBe("table");
  });

  it("should not interfere with events that have no content field", () => {
    logFeedEvent(cwd, "AgentA", "join");

    const events = readFeedEvents(cwd, 20);
    expect(events[0]?.content).toBeUndefined();
  });
});
