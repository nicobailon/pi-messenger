import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MessengerState } from "../../lib.js";
import type { CollaboratorEntry } from "../../crew/registry.js";

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
    completedCollaborators: new Set(),
    ...overrides,
  };
}

function makeProc() {
  const proc = {
    exitCode: null as number | null,
    killed: false,
    pid: Math.floor(Math.random() * 100000),
    kill: vi.fn().mockImplementation(() => {
      proc.killed = true;
      proc.exitCode = proc.exitCode ?? 0;
      return true;
    }),
    once: vi.fn(),
    on: vi.fn(),
    stdin: {
      write: vi.fn(),
      end: vi.fn().mockImplementation(() => {
        proc.exitCode = 0;
      }),
    },
    stdout: null,
    stderr: null,
  };
  return proc as unknown as import("node:child_process").ChildProcess;
}

describe("provider_error cleanup invariants", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-cleanup-"));
  });

  afterEach(async () => {
    const registry = await import("../../crew/registry.js");
    registry.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("send path: provider_error completes exchange cleanup invariants", async () => {
    const registry = await import("../../crew/registry.js");

    const pollMock = vi.fn().mockResolvedValue({
      ok: false,
      error: "provider_error",
      providerError: {
        statusCode: 429,
        errorType: "rate_limit_error",
        errorMessage: "429 too many",
        requestId: "req_cleanup_send",
        provider: "anthropic",
        model: "claude-opus-4-6",
        raw: "Bearer sk-ant-oat01-secret",
      },
      logTail: "Authorization: Bearer sk-ant-oat01-secret",
    });

    vi.doMock("../../crew/handlers/collab.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../crew/handlers/collab.js")>();
      return {
        ...original,
        pollForCollaboratorMessage: pollMock,
      };
    });

    const handlers = await import("../../handlers.js");

    const collabEntry: CollaboratorEntry = {
      type: "collaborator",
      name: "NavAgent",
      cwd: tmpDir,
      proc: makeProc(),
      taskId: "task-cleanup-send",
      spawnedBy: process.pid,
      startedAt: Date.now(),
      promptTmpDir: null,
      logFile: path.join(tmpDir, "collab.log"),
    };
    fs.writeFileSync(collabEntry.logFile!, "boot\n");
    registry.registerWorker(collabEntry);

    const state = makeMinimalState();
    const dirs = {
      base: tmpDir,
      registry: path.join(tmpDir, "registry"),
      inbox: path.join(tmpDir, "inbox"),
    } as any;
    fs.mkdirSync(dirs.registry, { recursive: true });
    fs.mkdirSync(path.join(dirs.inbox, state.agentName), { recursive: true });
    fs.writeFileSync(
      path.join(dirs.registry, "NavAgent.json"),
      JSON.stringify({
        name: "NavAgent",
        pid: process.pid,
        sessionId: "sess-cleanup",
        cwd: tmpDir,
        model: "anthropic/claude-opus-4-6",
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      }),
    );

    const result = await handlers.executeSend(
      state,
      dirs,
      tmpDir,
      "NavAgent",
      undefined,
      "Please review",
      undefined,
      "review",
    );

    expect(result.details.error).toBe("provider_error");
    expect((result.details as any).conversationComplete).toBe(true);
    expect(state.completedCollaborators.has("NavAgent")).toBe(true);
    expect(state.blockingCollaborators.has("NavAgent")).toBe(false);

    // Registry/worker visibility invariant: collaborator is no longer active.
    expect(registry.hasActiveWorker(collabEntry.cwd, collabEntry.taskId)).toBe(false);
    expect(registry.findCollaboratorByName("NavAgent")).toBeNull();

    // Optional debug payloads are sanitized.
    expect((result.details as any).providerError.raw).not.toContain("sk-ant-oat01");
    expect((result.details as any).logTail).not.toContain("sk-ant-oat01");
  });

  it("spawn path: provider_error helper enforces cleanup invariants and output contract", async () => {
    const registry = await import("../../crew/registry.js");
    const collab = await import("../../crew/handlers/collab.js");

    const collabEntry: CollaboratorEntry = {
      type: "collaborator",
      name: "SpawnAgent",
      cwd: tmpDir,
      proc: makeProc(),
      taskId: "task-cleanup-spawn",
      spawnedBy: process.pid,
      startedAt: Date.now(),
      promptTmpDir: null,
      logFile: path.join(tmpDir, "spawn.log"),
    };
    fs.writeFileSync(collabEntry.logFile!, "boot\n");
    registry.registerWorker(collabEntry);

    const result = await collab.finalizeSpawnProviderError(
      collabEntry,
      "SpawnAgent",
      {
        statusCode: 429,
        errorType: "rate_limit_error",
        errorMessage: "Provider 429",
        requestId: "req_cleanup_spawn",
        provider: "anthropic",
        model: "claude-opus-4-6",
        raw: "Authorization: Bearer sk-ant-oat01-secret",
      },
      "Authorization: Bearer sk-ant-oat01-secret",
    );

    expect(result.details.error).toBe("provider_error");
    expect((result.details as any).providerError.provider).toBe("anthropic");
    expect((result.details as any).providerError.model).toBe("claude-opus-4-6");
    expect((result.details as any).providerError.requestId).toBe("req_cleanup_spawn");
    expect((result.details as any).providerError.raw).not.toContain("sk-ant-oat01");
    expect((result.details as any).logTail).not.toContain("sk-ant-oat01");

    // Registry/worker visibility invariant: collaborator is no longer active.
    expect(registry.hasActiveWorker(collabEntry.cwd, collabEntry.taskId)).toBe(false);
    expect(registry.findCollaboratorByName("SpawnAgent")).toBeNull();
  });
});
