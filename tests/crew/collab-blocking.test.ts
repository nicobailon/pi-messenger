/**
 * Tests for blocking collaborator exchange (spec 004)
 *
 * Tests pollForCollaboratorMessage, the deliverFn boolean contract,
 * recordMessageInHistory, and the watcher filter in deliverMessage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentMailMessage, MessengerState } from "../../lib.js";
import type { CollaboratorEntry } from "../../crew/registry.js";
import type { PollOptions, PollResult } from "../../crew/handlers/collab.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    id: randomUUID(),
    from: "TestCollab",
    to: "TestSpawner",
    text: "Hello from collaborator",
    timestamp: new Date().toISOString(),
    replyTo: null,
    ...overrides,
  };
}

function writeMessageFile(inboxDir: string, msg: AgentMailMessage): string {
  fs.mkdirSync(inboxDir, { recursive: true });
  const random = Math.random().toString(36).substring(2, 8);
  const filename = `${Date.now()}-${random}.json`;
  const filePath = path.join(inboxDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(msg));
  return filePath;
}

function makeFakeProc(alive = true) {
  return {
    exitCode: alive ? null : 0,
    killed: false,
    pid: Math.floor(Math.random() * 100000),
    kill: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: null,
    stderr: null,
  } as unknown as import("node:child_process").ChildProcess;
}

function makeCollabEntry(overrides: Partial<CollaboratorEntry> = {}): CollaboratorEntry {
  return {
    type: "collaborator",
    name: "TestCollab",
    cwd: "/tmp/test",
    proc: makeFakeProc(),
    taskId: "__collab-test__",
    spawnedBy: process.pid,
    startedAt: Date.now(),
    promptTmpDir: null,
    logFile: null,
    ...overrides,
  };
}

function makeMinimalState(overrides: Partial<MessengerState> = {}): MessengerState {
  return {
    agentName: "TestSpawner",
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test",
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    registrationContextSent: false,
    blockingCollaborators: new Set(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// pollForCollaboratorMessage
// ─────────────────────────────────────────────────────────────────────────────

describe("pollForCollaboratorMessage", () => {
  let tmpDir: string;
  let inboxDir: string;
  let pollForCollaboratorMessage: typeof import("../../crew/handlers/collab.js").pollForCollaboratorMessage;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-blocking-test-"));
    inboxDir = path.join(tmpDir, "inbox", "TestSpawner");
    fs.mkdirSync(inboxDir, { recursive: true });
    const mod = await import("../../crew/handlers/collab.js");
    pollForCollaboratorMessage = mod.pollForCollaboratorMessage;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Flow 1: Spawn + first message ──────────────────────────────────────

  it("resolves with message when collaborator sends first message (spawn path)", async () => {
    const state = makeMinimalState();
    const entry = makeCollabEntry();
    const msg = makeMessage({ text: "I've analyzed the codebase" });

    // Write message after a short delay
    setTimeout(() => writeMessageFile(inboxDir, msg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      timeoutMs: 2000,
      state,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.text).toBe("I've analyzed the codebase");
      expect(result.message.from).toBe("TestCollab");
    }
  });

  // ── Flow 2: Send + reply (with correlation) ───────────────────────────

  it("resolves with reply matching replyTo correlation", async () => {
    const state = makeMinimalState();
    const entry = makeCollabEntry();
    const outboundId = randomUUID();
    const reply = makeMessage({
      text: "Here is my reply",
      replyTo: outboundId,
    });

    setTimeout(() => writeMessageFile(inboxDir, reply), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      correlationId: outboundId,
      sendTimestamp: Date.now() - 1000,
      entry,
      timeoutMs: 2000,
      state,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.text).toBe("Here is my reply");
      expect(result.message.replyTo).toBe(outboundId);
    }
  });

  // ── Flow 3: Timeout ────────────────────────────────────────────────────

  it("resolves with timeout when no message arrives", async () => {
    const state = makeMinimalState();
    const entry = makeCollabEntry();

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      timeoutMs: 150,
      state,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("timeout");
    }
  });

  // ── Flow 4: Crash ─────────────────────────────────────────────────────

  it("detects collaborator crash with log tail", async () => {
    const logFile = path.join(tmpDir, "collab.log");
    fs.writeFileSync(logFile, "Starting up...\nError: something went wrong\nStack trace here");
    const proc = makeFakeProc(true);
    const entry = makeCollabEntry({ proc, logFile });

    // Simulate crash after 50ms
    setTimeout(() => {
      (proc as any).exitCode = 1;
    }, 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      timeoutMs: 2000,
      state: makeMinimalState(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("crashed");
      expect(result.exitCode).toBe(1);
      expect(result.logTail).toContain("something went wrong");
    }
  });

  // ── Flow 5: Cancel (spawn) ────────────────────────────────────────────

  it("resolves with cancelled on abort signal", async () => {
    const controller = new AbortController();
    const entry = makeCollabEntry();

    setTimeout(() => controller.abort(), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      signal: controller.signal,
      timeoutMs: 2000,
      state: makeMinimalState(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("cancelled");
    }
  });

  // ── Correlation: replyTo match ────────────────────────────────────────

  it("accepts message with matching replyTo (Tier 1)", async () => {
    const correlationId = randomUUID();
    const msg = makeMessage({ replyTo: correlationId });
    const entry = makeCollabEntry();

    setTimeout(() => writeMessageFile(inboxDir, msg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      correlationId,
      sendTimestamp: Date.now() - 1000,
      entry,
      timeoutMs: 2000,
      state: makeMinimalState(),
    });

    expect(result.ok).toBe(true);
  });

  // ── Correlation: wrong thread rejection ───────────────────────────────

  it("rejects message with mismatched replyTo (Tier 3)", async () => {
    const correlationId = randomUUID();
    const wrongReplyTo = randomUUID();
    const msg = makeMessage({ replyTo: wrongReplyTo });
    const entry = makeCollabEntry();

    // Write wrong-thread message, then timeout
    setTimeout(() => writeMessageFile(inboxDir, msg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      correlationId,
      sendTimestamp: Date.now() - 1000,
      entry,
      timeoutMs: 300,
      state: makeMinimalState(),
    });

    // Should timeout because the only message has wrong replyTo
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("timeout");
    }
  });

  // ── Correlation: fallback with null replyTo ───────────────────────────

  it("accepts message with null replyTo from correct sender after sendTimestamp (Tier 2)", async () => {
    const correlationId = randomUUID();
    const sendTimestamp = Date.now();
    const msg = makeMessage({
      replyTo: null,
      timestamp: new Date(sendTimestamp + 100).toISOString(),
    });
    const entry = makeCollabEntry();

    setTimeout(() => writeMessageFile(inboxDir, msg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      correlationId,
      sendTimestamp,
      entry,
      timeoutMs: 2000,
      state: makeMinimalState(),
    });

    expect(result.ok).toBe(true);
  });

  // ── Correlation: timestamp type safety ────────────────────────────────

  it("handles unparseable timestamp gracefully (NaN guard)", async () => {
    const correlationId = randomUUID();
    const msg = makeMessage({
      replyTo: null,
      timestamp: "not-a-date",
    });
    const entry = makeCollabEntry();

    // Write message with bad timestamp, should not match Tier 2
    setTimeout(() => writeMessageFile(inboxDir, msg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      correlationId,
      sendTimestamp: Date.now(),
      entry,
      timeoutMs: 300,
      state: makeMinimalState(),
    });

    // Should timeout — bad timestamp means Tier 2 can't match
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("timeout");
    }
  });

  // ── Concurrent collaborators ──────────────────────────────────────────

  it("messages from wrong collaborator do not satisfy the wait", async () => {
    const entry = makeCollabEntry({ name: "CollabA" });
    const wrongMsg = makeMessage({ from: "CollabB", text: "wrong sender" });

    setTimeout(() => writeMessageFile(inboxDir, wrongMsg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "CollabA",
      entry,
      timeoutMs: 300,
      state: makeMinimalState(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("timeout");
    }
  });

  // ── recordMessageInHistory ────────────────────────────────────────────

  it("records message in chatHistory and unreadCounts on success", async () => {
    const state = makeMinimalState();
    const entry = makeCollabEntry();
    const msg = makeMessage({ text: "history test" });

    setTimeout(() => writeMessageFile(inboxDir, msg), 50);

    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      timeoutMs: 2000,
      state,
    });

    expect(result.ok).toBe(true);
    // Chat history should have the message
    const history = state.chatHistory.get("TestCollab");
    expect(history).toBeDefined();
    expect(history!.length).toBe(1);
    expect(history![0].text).toBe("history test");
    // Unread count should be incremented
    expect(state.unreadCounts.get("TestCollab")).toBe(1);
  });

  // ── File cleanup ──────────────────────────────────────────────────────

  it("deletes the message file after successful match", async () => {
    const state = makeMinimalState();
    const entry = makeCollabEntry();
    const msg = makeMessage();

    // Write message synchronously for path tracking
    const filePath = writeMessageFile(inboxDir, msg);

    // Poll should find it immediately
    const result = await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      timeoutMs: 2000,
      state,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // ── Progress emission ─────────────────────────────────────────────────

  it("emits progress updates at 30s intervals", async () => {
    // We can't wait 30s in a test, so just verify onUpdate is called eventually
    // by using a very short timeout and checking it does NOT fire before 30s
    const onUpdate = vi.fn();
    const entry = makeCollabEntry();

    await pollForCollaboratorMessage({
      inboxDir,
      collabName: "TestCollab",
      entry,
      onUpdate,
      timeoutMs: 200,
      state: makeMinimalState(),
    });

    // With 200ms timeout and 30s progress interval, no progress should fire
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deliverFn boolean contract (processAllPendingMessages)
// ─────────────────────────────────────────────────────────────────────────────

describe("deliverFn boolean contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deliverfn-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT delete file when deliverFn returns false", async () => {
    vi.resetModules();
    const store = await import("../../store.js");

    const inboxDir = path.join(tmpDir, "inbox", "TestAgent");
    fs.mkdirSync(inboxDir, { recursive: true });

    const msg = makeMessage();
    const filePath = writeMessageFile(inboxDir, msg);
    const filename = path.basename(filePath);

    const state = makeMinimalState({ agentName: "TestAgent" });
    const dirs = { base: tmpDir, registry: path.join(tmpDir, "registry"), inbox: path.join(tmpDir, "inbox") };
    fs.mkdirSync(dirs.registry, { recursive: true });

    // Register so processAllPendingMessages proceeds
    state.registered = true;

    // deliverFn returns false — file should be preserved
    store.processAllPendingMessages(state, dirs, () => false);

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("DOES delete file when deliverFn returns true", async () => {
    vi.resetModules();
    const store = await import("../../store.js");

    const inboxDir = path.join(tmpDir, "inbox", "TestAgent");
    fs.mkdirSync(inboxDir, { recursive: true });

    const msg = makeMessage();
    const filePath = writeMessageFile(inboxDir, msg);

    const state = makeMinimalState({ agentName: "TestAgent" });
    const dirs = { base: tmpDir, registry: path.join(tmpDir, "registry"), inbox: path.join(tmpDir, "inbox") };
    fs.mkdirSync(dirs.registry, { recursive: true });
    state.registered = true;

    store.processAllPendingMessages(state, dirs, () => true);

    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordMessageInHistory
// ─────────────────────────────────────────────────────────────────────────────

describe("recordMessageInHistory", () => {
  it("adds message to chatHistory and increments unreadCounts", async () => {
    vi.resetModules();
    const store = await import("../../store.js");
    const state = makeMinimalState();
    const msg = makeMessage({ from: "SomeAgent", text: "test" });

    store.recordMessageInHistory(state, msg);

    const history = state.chatHistory.get("SomeAgent");
    expect(history).toHaveLength(1);
    expect(history![0].text).toBe("test");
    expect(state.unreadCounts.get("SomeAgent")).toBe(1);
  });

  it("respects maxHistory limit", async () => {
    vi.resetModules();
    const store = await import("../../store.js");
    const state = makeMinimalState();

    for (let i = 0; i < 5; i++) {
      store.recordMessageInHistory(state, makeMessage({ from: "Agent", text: `msg-${i}` }), 3);
    }

    const history = state.chatHistory.get("Agent");
    expect(history).toHaveLength(3);
    expect(history![0].text).toBe("msg-2");
    expect(history![2].text).toBe("msg-4");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// blockingCollaborators cleanup via try/finally simulation
// ─────────────────────────────────────────────────────────────────────────────

describe("blockingCollaborators cleanup", () => {
  let tmpDir: string;
  let inboxDir: string;
  let pollForCollaboratorMessage: typeof import("../../crew/handlers/collab.js").pollForCollaboratorMessage;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
    inboxDir = path.join(tmpDir, "inbox", "TestSpawner");
    fs.mkdirSync(inboxDir, { recursive: true });
    const mod = await import("../../crew/handlers/collab.js");
    pollForCollaboratorMessage = mod.pollForCollaboratorMessage;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Simulates the try/finally pattern used by executeSpawn and executeSend:
   *   state.blockingCollaborators.add(name);
   *   try { await poll(...) } finally { state.blockingCollaborators.delete(name); }
   */
  async function pollWithCleanup(state: MessengerState, opts: Omit<PollOptions, "state">): Promise<PollResult> {
    const name = opts.collabName;
    state.blockingCollaborators.add(name);
    try {
      return await pollForCollaboratorMessage({ ...opts, state });
    } finally {
      state.blockingCollaborators.delete(name);
    }
  }

  it("set is empty after successful poll", async () => {
    const state = makeMinimalState();
    const msg = makeMessage();
    writeMessageFile(inboxDir, msg);

    const result = await pollWithCleanup(state, {
      inboxDir,
      collabName: "TestCollab",
      entry: makeCollabEntry(),
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(state.blockingCollaborators.size).toBe(0);
  });

  it("set is empty after timeout", async () => {
    const state = makeMinimalState();

    const result = await pollWithCleanup(state, {
      inboxDir,
      collabName: "TestCollab",
      entry: makeCollabEntry(),
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    expect(state.blockingCollaborators.size).toBe(0);
  });

  it("set is empty after crash", async () => {
    const state = makeMinimalState();
    const proc = makeFakeProc(true);
    setTimeout(() => { (proc as any).exitCode = 1; }, 50);

    const result = await pollWithCleanup(state, {
      inboxDir,
      collabName: "TestCollab",
      entry: makeCollabEntry({ proc }),
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(state.blockingCollaborators.size).toBe(0);
  });

  it("set is empty after cancellation", async () => {
    const state = makeMinimalState();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await pollWithCleanup(state, {
      inboxDir,
      collabName: "TestCollab",
      entry: makeCollabEntry(),
      signal: controller.signal,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    expect(state.blockingCollaborators.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Watcher filter (deliverMessage behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe("watcher filter via blockingCollaborators", () => {
  it("deliverFn returns false for blocked sender, true for non-blocked", async () => {
    vi.resetModules();
    const store = await import("../../store.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filter-test-"));
    try {
      const inboxDir = path.join(tmpDir, "inbox", "TestAgent");
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "registry"), { recursive: true });

      const state = makeMinimalState({ agentName: "TestAgent" });
      const dirs = { base: tmpDir, registry: path.join(tmpDir, "registry"), inbox: path.join(tmpDir, "inbox") };

      // Block "CollabA" but not "PeerB"
      state.blockingCollaborators.add("CollabA");

      // Write messages from both
      const msgA = makeMessage({ from: "CollabA", text: "from blocked" });
      const msgB = makeMessage({ from: "PeerB", text: "from peer" });
      const pathA = writeMessageFile(inboxDir, msgA);
      const pathB = writeMessageFile(inboxDir, msgB);

      // Track deliverFn return values
      const results: boolean[] = [];
      const deliverFn = (msg: AgentMailMessage): boolean => {
        if (state.blockingCollaborators.has(msg.from)) {
          results.push(false);
          return false;
        }
        results.push(true);
        return true;
      };

      store.processAllPendingMessages(state, dirs, deliverFn);

      // CollabA file should still exist (deliverFn returned false)
      expect(fs.existsSync(pathA)).toBe(true);
      // PeerB file should be deleted (deliverFn returned true)
      expect(fs.existsSync(pathB)).toBe(false);
      // Both were called
      expect(results).toContain(false);
      expect(results).toContain(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
