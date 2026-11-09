import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FEED_EVENTS_MAX_BYTES,
  logFeedEvent,
  readFeedEvents,
  setFeedEventsMaxBytes,
  setFeedPersistenceContext,
  type PersistentFeedEvent,
} from "../feed.ts";

const roots = new Set<string>();

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-feedp-test-"));
  roots.add(root);
  return root;
}

/** Persistent events live under a per-test messenger base dir. */
let base: string;

function eventsPath(): string {
  return path.join(base, "feed-events.jsonl");
}

function readPersistentEvents(): PersistentFeedEvent[] {
  const p = eventsPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8")
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as PersistentFeedEvent);
}

beforeEach(() => {
  const root = createTempRoot();
  base = path.join(root, "messenger");
  setFeedPersistenceContext({
    baseDir: base,
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "TestAgent",
  });
  setFeedEventsMaxBytes(DEFAULT_FEED_EVENTS_MAX_BYTES);
});

afterEach(() => {
  setFeedPersistenceContext({ baseDir: null, sessionId: null, agentName: null });
  setFeedEventsMaxBytes(DEFAULT_FEED_EVENTS_MAX_BYTES);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("persistent feed events (feed-events.jsonl)", () => {
  it("appends one JSON line per event with all 7 fields", () => {
    const cwd = createTempRoot();

    logFeedEvent(cwd, "TestAgent", "message", "Peer", "hello there");
    logFeedEvent(cwd, "TestAgent", "join");

    const events = readPersistentEvents();
    expect(events).toHaveLength(2);

    const [first, second] = events;
    expect(typeof first.ts).toBe("number");
    expect(Number.isFinite(first.ts)).toBe(true);
    expect(first.name).toBe("TestAgent");
    expect(first.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(first.cwd).toBe(cwd);
    expect(first.type).toBe("message");
    expect(first.target).toBe("Peer");
    expect(first.preview).toBe("hello there");

    expect(second.type).toBe("join");
    expect(second.target).toBeNull();
    expect(second.preview).toBeNull();
  });

  it("resolves sessionId for peer agents from the live registry", () => {
    const cwd = createTempRoot();
    setFeedPersistenceContext({ baseDir: base, sessionId: null, agentName: "Self" });

    fs.mkdirSync(path.join(base, "registry"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "registry", "Peer.json"),
      JSON.stringify({ name: "Peer", sessionId: "22222222-2222-4222-8222-222222222222" })
    );

    logFeedEvent(cwd, "Peer", "stuck");

    expect(readPersistentEvents()).toHaveLength(1);
    expect(readPersistentEvents()[0]!.sessionId).toBe("22222222-2222-4222-8222-222222222222");

    // Unknown agent with no registry entry -> null sessionId, event still recorded.
    logFeedEvent(cwd, "Ghost", "leave");
    const after = readPersistentEvents();
    expect(after).toHaveLength(2);
    expect(after[1]!.sessionId).toBeNull();
  });

  it("truncates to the newest half of the lines once the file exceeds the cap", () => {
    const cwd = createTempRoot();
    setFeedPersistenceContext({ baseDir: base, sessionId: null, agentName: "Cap" });
    setFeedEventsMaxBytes(500);

    fs.mkdirSync(base, { recursive: true });
    // Seed 4 lines that already exceed the 500-byte cap.
    const seed = Array.from({ length: 4 }, (_, i) => JSON.stringify({
      ts: 1_700_000_000_000 + i,
      name: "Seed",
      sessionId: null,
      cwd,
      type: "edit",
      target: `file-${i}-${"x".repeat(120)}`,
      preview: null,
    }));
    fs.writeFileSync(eventsPath(), seed.join("\n") + "\n");

    logFeedEvent(cwd, "Cap", "commit", undefined, "crossed the cap");

    const lines = fs.readFileSync(eventsPath(), "utf-8").split("\n").filter(l => l.length > 0);
    // 4 seeded lines truncated to newest half (2), plus the new event.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(seed[2]);
    expect(lines[1]).toBe(seed[3]);
    const last = JSON.parse(lines[2]!) as PersistentFeedEvent;
    expect(last.name).toBe("Cap");
    expect(last.type).toBe("commit");
    expect(last.preview).toBe("crossed the cap");
  });

  it("keeps the project-scoped feed output unchanged", () => {
    const withPersist = createTempRoot();
    const withoutPersist = createTempRoot();
    setFeedPersistenceContext({
      baseDir: path.join(withPersist, "messenger"),
      sessionId: "33333333-3333-4333-8333-333333333333",
      agentName: "AgentOne",
    });

    logFeedEvent(withPersist, "AgentOne", "join");
    logFeedEvent(withPersist, "AgentOne", "edit", "src/app.ts");
    logFeedEvent(withPersist, "AgentOne", "commit", undefined, "ship feed scope");

    setFeedPersistenceContext({ baseDir: null, sessionId: null, agentName: null });
    logFeedEvent(withoutPersist, "AgentOne", "join");
    logFeedEvent(withoutPersist, "AgentOne", "edit", "src/app.ts");
    logFeedEvent(withoutPersist, "AgentOne", "commit", undefined, "ship feed scope");

    const stripTs = (events: ReturnType<typeof readFeedEvents>) =>
      events.map(({ ts: _ts, ...rest }) => rest);

    const persisted = stripTs(readFeedEvents(withPersist, 20));
    const plain = stripTs(readFeedEvents(withoutPersist, 20));
    expect(persisted).toEqual(plain);
    expect(persisted).toHaveLength(3);

    // The persistent copy exists only for the registered context.
    expect(fs.existsSync(path.join(withPersist, "messenger", "feed-events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(withoutPersist, "messenger", "feed-events.jsonl"))).toBe(false);
  });

  it("never lets persistent-feed disk failures break an event", () => {
    const cwd = createTempRoot();
    const blocker = path.join(cwd, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    expect(() => {
      setFeedPersistenceContext({ baseDir: path.join(blocker, "messenger"), sessionId: null, agentName: "TestAgent" });
      logFeedEvent(cwd, "TestAgent", "join");
    }).not.toThrow();

    // Project feed still got the event.
    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
  });
});
