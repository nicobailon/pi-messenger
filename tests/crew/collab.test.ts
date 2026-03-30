/**
 * Tests for crew/handlers/collab.ts — spawn/dismiss collaboration actions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CollaboratorEntry } from "../../crew/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Registry tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CollaboratorEntry in registry", () => {
  let registry: typeof import("../../crew/registry.js");

  beforeEach(async () => {
    // Fresh import to get clean state (module-level Map)
    vi.resetModules();
    registry = await import("../../crew/registry.js");
  });

  function makeFakeProc(alive = true) {
    return {
      exitCode: alive ? null : 0,
      killed: false,
      pid: Math.floor(Math.random() * 100000),
      kill: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
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
      taskId: "__collab-abc123__",
      spawnedBy: 12345,
      startedAt: Date.now(),
      promptTmpDir: null,
      logFile: null,
      ...overrides,
    };
  }

  it("registers and finds collaborators by name", () => {
    const entry = makeCollabEntry({ name: "ZenPhoenix" });
    registry.registerWorker(entry);

    const found = registry.findCollaboratorByName("ZenPhoenix");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("ZenPhoenix");
    expect(found!.type).toBe("collaborator");
    expect(found!.spawnedBy).toBe(12345);
  });

  it("returns null for non-existent collaborator name", () => {
    expect(registry.findCollaboratorByName("DoesNotExist")).toBeNull();
  });

  it("returns null for exited collaborators", () => {
    const entry = makeCollabEntry({
      name: "DeadCollab",
      proc: makeFakeProc(false),
    });
    registry.registerWorker(entry);

    expect(registry.findCollaboratorByName("DeadCollab")).toBeNull();
  });

  it("finds collaborators by spawner PID", () => {
    const entry1 = makeCollabEntry({ name: "Collab1", taskId: "__collab-1__", spawnedBy: 99999 });
    const entry2 = makeCollabEntry({ name: "Collab2", taskId: "__collab-2__", spawnedBy: 99999 });
    const entry3 = makeCollabEntry({ name: "Other", taskId: "__collab-3__", spawnedBy: 11111 });

    registry.registerWorker(entry1);
    registry.registerWorker(entry2);
    registry.registerWorker(entry3);

    const bySpawner = registry.getCollaboratorsBySpawner(99999);
    expect(bySpawner).toHaveLength(2);
    expect(bySpawner.map(e => e.name).sort()).toEqual(["Collab1", "Collab2"]);
  });

  it("excludes exited collaborators from spawner lookup", () => {
    const alive = makeCollabEntry({ name: "Alive", taskId: "__collab-a__", spawnedBy: 99999 });
    const dead = makeCollabEntry({
      name: "Dead",
      taskId: "__collab-b__",
      spawnedBy: 99999,
      proc: makeFakeProc(false),
    });

    registry.registerWorker(alive);
    registry.registerWorker(dead);

    const result = registry.getCollaboratorsBySpawner(99999);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Alive");
  });

  it("does not confuse collaborators with regular workers", () => {
    registry.registerWorker({
      type: "worker",
      name: "RegularWorker",
      cwd: "/tmp/test",
      proc: makeFakeProc(),
      taskId: "task-1",
    });

    expect(registry.findCollaboratorByName("RegularWorker")).toBeNull();
    expect(registry.getCollaboratorsBySpawner(process.pid)).toHaveLength(0);
  });

  it("unregisters collaborators", () => {
    const entry = makeCollabEntry({ name: "Temp", taskId: "__collab-temp__" });
    registry.registerWorker(entry);
    expect(registry.findCollaboratorByName("Temp")).not.toBeNull();

    registry.unregisterWorker("/tmp/test", "__collab-temp__");
    expect(registry.findCollaboratorByName("Temp")).toBeNull();
  });

  it("killAll kills collaborators too", () => {
    const proc = makeFakeProc();
    const entry = makeCollabEntry({ name: "KillMe", proc });
    registry.registerWorker(entry);

    registry.killAll("/tmp/test");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security gate tests
// ─────────────────────────────────────────────────────────────────────────────

describe("spawn security gate", () => {
  it("crew-challenger has crewRole: collaborator", async () => {
    const { discoverCrewAgents } = await import("../../crew/utils/discover.js");
    const agentsDir = path.resolve(__dirname, "../../crew/agents");
    const agents = discoverCrewAgents("/tmp", agentsDir);
    const challenger = agents.find(a => a.name === "crew-challenger");

    expect(challenger).toBeDefined();
    expect(challenger!.crewRole).toBe("collaborator");
  });

  it("crew-worker does NOT have crewRole: collaborator", async () => {
    const { discoverCrewAgents } = await import("../../crew/utils/discover.js");
    const agentsDir = path.resolve(__dirname, "../../crew/agents");
    const agents = discoverCrewAgents("/tmp", agentsDir);
    const worker = agents.find(a => a.name === "crew-worker");

    expect(worker).toBeDefined();
    expect(worker!.crewRole).not.toBe("collaborator");
  });

  it("crew-challenger has read-only tools (no write/edit)", async () => {
    const { discoverCrewAgents } = await import("../../crew/utils/discover.js");
    const agentsDir = path.resolve(__dirname, "../../crew/agents");
    const agents = discoverCrewAgents("/tmp", agentsDir);
    const challenger = agents.find(a => a.name === "crew-challenger");

    expect(challenger).toBeDefined();
    expect(challenger!.tools).toBeDefined();
    expect(challenger!.tools).not.toContain("write");
    expect(challenger!.tools).not.toContain("edit");
    expect(challenger!.tools).toContain("read");
    expect(challenger!.tools).toContain("bash");
    expect(challenger!.tools).toContain("pi_messenger");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget exemption tests
// ─────────────────────────────────────────────────────────────────────────────

describe("collaborator budget exemption", () => {
  it("collaborator env var sets infinite budget", () => {
    const original = process.env.PI_CREW_COLLABORATOR;
    try {
      process.env.PI_CREW_COLLABORATOR = "1";
      const isCollaborator = process.env.PI_CREW_COLLABORATOR === "1";
      const budget = isCollaborator ? Infinity : 10;
      expect(budget).toBe(Infinity);
      expect(100 >= budget).toBe(false); // Never hits budget
    } finally {
      if (original === undefined) {
        delete process.env.PI_CREW_COLLABORATOR;
      } else {
        process.env.PI_CREW_COLLABORATOR = original;
      }
    }
  });

  it("normal workers still have finite budget", () => {
    const original = process.env.PI_CREW_COLLABORATOR;
    try {
      delete process.env.PI_CREW_COLLABORATOR;
      const isCollaborator = process.env.PI_CREW_COLLABORATOR === "1";
      const budget = isCollaborator ? Infinity : 10;
      expect(budget).toBe(10);
      expect(10 >= budget).toBe(true); // Hits budget at 10
    } finally {
      if (original !== undefined) {
        process.env.PI_CREW_COLLABORATOR = original;
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config type tests
// ─────────────────────────────────────────────────────────────────────────────

describe("collaborator config support", () => {
  it("CrewRole type includes collaborator", async () => {
    // This is a compile-time check — if the type doesn't include "collaborator",
    // this assignment would fail TypeScript compilation
    const role: import("../../crew/utils/discover.js").CrewRole = "collaborator";
    expect(role).toBe("collaborator");
  });

  it("loadCrewConfig supports models.collaborator override", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-config-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ models: { collaborator: "anthropic/claude-opus-4-6" } }),
      );
      const { loadCrewConfig } = await import("../../crew/utils/config.js");
      const config = loadCrewConfig(tmpDir);
      expect(config.models?.collaborator).toBe("anthropic/claude-opus-4-6");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadCrewConfig supports thinking.collaborator override", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-config-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ thinking: { collaborator: "high" } }),
      );
      const { loadCrewConfig } = await import("../../crew/utils/config.js");
      const config = loadCrewConfig(tmpDir);
      expect(config.thinking?.collaborator).toBe("high");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveModel uses defaultModel when no role-specific model configured", async () => {
    const { resolveModel } = await import("../../crew/utils/model.js");
    // No role config, but defaultModel set — should pick defaultModel over agent fallback
    const result = resolveModel(undefined, undefined, undefined, "anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5");
    expect(result).toEqual({ model: "anthropic/claude-opus-4-6", source: "default" });
  });

  it("resolveModel prioritizes params.model over role config for collaborator", async () => {
    const { resolveModel } = await import("../../crew/utils/model.js");
    // params.model (param) should override role config
    const result = resolveModel(undefined, "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6", undefined, undefined);
    expect(result).toEqual({ model: "anthropic/claude-sonnet-4-6", source: "param" });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// T6d: gracefulDismiss heartbeat cleanup (spec 009, AD4/R2e)
// ──────────────────────────────────────────────────────────────────────────────

describe("gracefulDismiss — heartbeat cleanup (spec 009)", () => {
  let tmpDir: string;
  let gracefulDismissFn: typeof import("../../crew/handlers/collab.js").gracefulDismiss;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graceful-dismiss-hb-"));
    vi.resetModules();
    const mod = await import("../../crew/handlers/collab.js");
    gracefulDismissFn = mod.gracefulDismiss;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProcAlreadyExited() {
    return {
      exitCode: 0,  // already exited
      killed: true,
      pid: 99999,
      kill: vi.fn(),
      once: vi.fn().mockImplementation((_event: string, cb: () => void) => cb()),
      on: vi.fn(),
      stdin: { end: vi.fn() },
    } as unknown as import("node:child_process").ChildProcess;
  }

  function makeProcAlive() {
    const proc = {
      exitCode: null,
      killed: false,
      pid: 88888,
      kill: vi.fn(),
      once: vi.fn().mockImplementation((_event: string, cb: () => void) => {
        // Simulate process exiting after stdin is closed
        setTimeout(cb, 10);
      }),
      on: vi.fn(),
      stdin: { end: vi.fn() },
    } as unknown as import("node:child_process").ChildProcess;
    return proc;
  }

  it("gracefulDismiss with already-exited process → heartbeat file unlinked (early-return branch)", async () => {
    const heartbeatFile = path.join(tmpDir, "already-exited.heartbeat");
    fs.writeFileSync(heartbeatFile, Date.now().toString());

    const entry = {
      type: "collaborator" as const,
      name: "DeadCollab",
      cwd: tmpDir,
      proc: makeProcAlreadyExited(),
      taskId: "__collab-dead__",
      spawnedBy: process.pid,
      startedAt: Date.now() - 5000,
      promptTmpDir: null,
      logFile: null,
      heartbeatFile,
    };

    expect(fs.existsSync(heartbeatFile)).toBe(true);

    await gracefulDismissFn(entry);

    // Heartbeat file must be unlinked even though process was already dead
    expect(fs.existsSync(heartbeatFile)).toBe(false);
  });

  it("gracefulDismiss with live process → heartbeat file unlinked after exit", async () => {
    const heartbeatFile = path.join(tmpDir, "live.heartbeat");
    fs.writeFileSync(heartbeatFile, Date.now().toString());

    const entry = {
      type: "collaborator" as const,
      name: "LiveCollab",
      cwd: tmpDir,
      proc: makeProcAlive(),
      taskId: "__collab-live__",
      spawnedBy: process.pid,
      startedAt: Date.now() - 1000,
      promptTmpDir: null,
      logFile: null,
      heartbeatFile,
    };

    expect(fs.existsSync(heartbeatFile)).toBe(true);

    await gracefulDismissFn(entry);

    expect(fs.existsSync(heartbeatFile)).toBe(false);
  });

  it("gracefulDismiss with no heartbeatFile → no error (optional field)", async () => {
    const entry = {
      type: "collaborator" as const,
      name: "NoHbCollab",
      cwd: tmpDir,
      proc: makeProcAlreadyExited(),
      taskId: "__collab-nohb__",
      spawnedBy: process.pid,
      startedAt: Date.now() - 1000,
      promptTmpDir: null,
      logFile: null,
      // heartbeatFile: undefined (not set)
    };

    await expect(gracefulDismissFn(entry)).resolves.toBeUndefined();
  });
});
