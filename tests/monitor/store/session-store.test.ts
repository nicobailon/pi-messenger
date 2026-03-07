import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionStore, createSessionStore } from "../../../src/monitor/store/session-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validMetadata = {
  id: "sess-001",
  name: "Test Session",
  cwd: "/home/user/project",
  model: "claude-opus-4",
  startedAt: "2026-03-07T12:00:00.000Z",
  agent: "TestAgent",
};

function makeMetadata(overrides: Partial<typeof validMetadata> = {}) {
  return { ...validMetadata, ...overrides };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Factory function
// ---------------------------------------------------------------------------

describe("createSessionStore", () => {
  it("creates a new SessionStore instance", () => {
    const store = createSessionStore();
    expect(store).toBeInstanceOf(SessionStore);
    expect(store.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. create()
// ---------------------------------------------------------------------------

describe("SessionStore.create()", () => {
  it("creates a session with default idle status and empty events", () => {
    const store = createSessionStore();
    const session = store.create(validMetadata);
    expect(session.status).toBe("idle");
    expect(session.metadata.id).toBe("sess-001");
    expect(session.events).toEqual([]);
    expect(session.metrics.eventCount).toBe(0);
  });

  it("throws a Zod error when metadata is invalid (missing required field)", () => {
    const store = createSessionStore();
    const bad = { ...validMetadata, id: undefined };
    expect(() => store.create(bad)).toThrow();
  });

  it("throws when startedAt is not a valid ISO datetime", () => {
    const store = createSessionStore();
    expect(() =>
      store.create(makeMetadata({ startedAt: "not-a-date" }))
    ).toThrow();
  });

  it("increments store size after each create", () => {
    const store = createSessionStore();
    store.create(makeMetadata({ id: "s1" }));
    store.create(makeMetadata({ id: "s2" }));
    expect(store.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. get()
// ---------------------------------------------------------------------------

describe("SessionStore.get()", () => {
  it("returns the session by id", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    const result = store.get("sess-001");
    expect(result).toBeDefined();
    expect(result!.metadata.id).toBe("sess-001");
  });

  it("returns undefined for unknown id", () => {
    const store = createSessionStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. update()
// ---------------------------------------------------------------------------

describe("SessionStore.update()", () => {
  it("updates session status", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    const updated = store.update("sess-001", { status: "active" });
    expect(updated.status).toBe("active");
  });

  it("merges metrics patch without clobbering other metrics", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    store.update("sess-001", { metrics: { eventCount: 5 } });
    const s = store.get("sess-001")!;
    expect(s.metrics.eventCount).toBe(5);
    expect(s.metrics.duration).toBe(0); // untouched
    expect(s.metrics.toolCalls).toBe(0); // untouched
  });

  it("throws when updating a non-existent session", () => {
    const store = createSessionStore();
    expect(() => store.update("ghost", { status: "active" })).toThrow(
      "Session not found: ghost"
    );
  });

  it("validates updated state via Zod (rejects invalid status)", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    expect(() =>
      store.update("sess-001", { status: "invalid-status" as any })
    ).toThrow();
  });

  it("replaces events when provided in patch", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    const newEvents = [
      { type: "tool_call", timestamp: "2026-03-07T12:01:00.000Z", data: {} },
    ];
    const updated = store.update("sess-001", { events: newEvents });
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].type).toBe("tool_call");
  });
});

// ---------------------------------------------------------------------------
// 5. delete()
// ---------------------------------------------------------------------------

describe("SessionStore.delete()", () => {
  it("removes session and returns true", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    expect(store.delete("sess-001")).toBe(true);
    expect(store.get("sess-001")).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("returns false for unknown id", () => {
    const store = createSessionStore();
    expect(store.delete("ghost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. list()
// ---------------------------------------------------------------------------

describe("SessionStore.list()", () => {
  it("returns all sessions when no filter given", () => {
    const store = createSessionStore();
    store.create(makeMetadata({ id: "s1" }));
    store.create(makeMetadata({ id: "s2" }));
    expect(store.list()).toHaveLength(2);
  });

  it("filters sessions by status", () => {
    const store = createSessionStore();
    store.create(makeMetadata({ id: "s1" }));
    store.create(makeMetadata({ id: "s2" }));
    store.update("s1", { status: "active" });
    const active = store.list({ status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0].metadata.id).toBe("s1");
  });

  it("returns empty array when store is empty", () => {
    const store = createSessionStore();
    expect(store.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. persist() and restore()
// ---------------------------------------------------------------------------

describe("SessionStore.persist() and restore()", () => {
  it("round-trips sessions to disk and back", () => {
    const store = createSessionStore();
    store.create(makeMetadata({ id: "p1" }));
    store.create(makeMetadata({ id: "p2" }));
    store.update("p1", { status: "active" });

    const persistDir = path.join(tmpDir, "sessions");
    store.persist(persistDir);

    // Files should exist
    expect(fs.existsSync(path.join(persistDir, "p1.json"))).toBe(true);
    expect(fs.existsSync(path.join(persistDir, "p2.json"))).toBe(true);

    // Load into fresh store
    const store2 = createSessionStore();
    store2.restore(persistDir);
    expect(store2.size()).toBe(2);
    expect(store2.get("p1")!.status).toBe("active");
    expect(store2.get("p2")!.status).toBe("idle");
  });

  it("uses atomic temp-file writes (no .tmp files left after persist)", () => {
    const store = createSessionStore();
    store.create(validMetadata);
    const persistDir = path.join(tmpDir, "atomic-test");
    store.persist(persistDir);

    const files = fs.readdirSync(persistDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp-"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("restore() skips invalid JSON files gracefully", () => {
    const badDir = path.join(tmpDir, "bad-sessions");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "corrupt.json"), "not valid json");
    fs.writeFileSync(
      path.join(badDir, "invalid-schema.json"),
      JSON.stringify({ status: "active" }) // missing required fields
    );

    // Write one valid session
    const store = createSessionStore();
    store.create(validMetadata);
    store.persist(badDir);

    const store2 = createSessionStore();
    store2.restore(badDir);
    // Only the valid session should be loaded
    expect(store2.size()).toBe(1);
    expect(store2.get("sess-001")).toBeDefined();
  });

  it("restore() does nothing when directory does not exist", () => {
    const store = createSessionStore();
    expect(() => store.restore("/nonexistent/path/abc123")).not.toThrow();
    expect(store.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. clear()
// ---------------------------------------------------------------------------

describe("SessionStore.clear()", () => {
  it("removes all sessions from memory", () => {
    const store = createSessionStore();
    store.create(makeMetadata({ id: "c1" }));
    store.create(makeMetadata({ id: "c2" }));
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrent update safety (sequential simulation)
// ---------------------------------------------------------------------------

describe("Concurrent update safety", () => {
  it("last update wins when two updates target the same session sequentially", () => {
    const store = createSessionStore();
    store.create(validMetadata);

    store.update("sess-001", { metrics: { eventCount: 1 } });
    store.update("sess-001", { metrics: { eventCount: 2 } });

    expect(store.get("sess-001")!.metrics.eventCount).toBe(2);
  });

  it("independent fields are preserved across sequential patches", () => {
    const store = createSessionStore();
    store.create(validMetadata);

    store.update("sess-001", { status: "active" });
    store.update("sess-001", { metrics: { tokensUsed: 100 } });

    const s = store.get("sess-001")!;
    expect(s.status).toBe("active");
    expect(s.metrics.tokensUsed).toBe(100);
  });
});
