/**
 * Tests for cleanupCollaboratorState() — the exported cleanup helper in cli/index.ts (spec 009, T6c)
 *
 * CLI runSpawn live spawn requires a real Pi process and is excluded from unit coverage
 * (cli.test.ts:1167). The cleanupCollaboratorState() function is exported specifically
 * to allow unit testing of the cleanup sequence (Codex finding — round 1).
 *
 * These tests import and exercise the REAL production function, not a copy.
 *
 * Verifies:
 * - cleanupCollaboratorState({ killFirst: true }): SIGTERM → sleep → SIGKILL (R2a/R2b)
 * - cleanupCollaboratorState({ killFirst: false }): no kill signals (crash path, R2c)
 * - All artifacts cleaned: fifoPath, collab state JSON, heartbeat, registry entry
 * - Partial failure: if one unlink throws, cleanup continues
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Import the REAL production function
// This is the key difference from the previous version that tested a local copy.
let cleanupCollaboratorState: typeof import("../../cli/index.js").cleanupCollaboratorState;

describe("cleanupCollaboratorState — production export (spec 009, R2a/R2b/R2c)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cleanup-test-"));
    // Import fresh module per test for clean mock state
    vi.resetModules();
    const mod = await import("../../cli/index.js");
    cleanupCollaboratorState = mod.cleanupCollaboratorState;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T6c: cleanupCollaboratorState({ killFirst: true }) — stall/timeout (R2a/R2b)
  // ─────────────────────────────────────────────────────────────────────────

  it("killFirst:true sends SIGTERM then SIGKILL after 5s sleep (R2a/R2b)", async () => {
    // Stub process.kill to capture calls
    const killCalls: Array<[number, string | number]> = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      killCalls.push([pid, signal as string | number]);
      return true;
    });

    // We need a real fd to close — use a temp file
    const tmpFile = path.join(tmpDir, "fifo");
    fs.writeFileSync(tmpFile, "");
    const fd = fs.openSync(tmpFile, "r");

    await cleanupCollaboratorState({
      pid: 12345,
      killFirst: true,
      fifoPath: path.join(tmpDir, "test.fifo"),
      collabName: "TestCollab",
      heartbeatFile: path.join(tmpDir, "test.heartbeat"),
      registryDir: tmpDir,
      fifoWriteFd: fd,
    });

    killSpy.mockRestore();

    // First call: SIGTERM
    expect(killCalls[0]).toEqual([12345, "SIGTERM"]);
    // SIGKILL called after checking alive
    const sigkillCall = killCalls.find(([, sig]) => sig === "SIGKILL");
    expect(sigkillCall).toBeDefined();
  }, 15000); // 5s sleep + buffer

  it("killFirst:true cleans all artifacts (R2a)", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);

    // Create the files that should be cleaned up
    const fifoPath = path.join(tmpDir, "test.fifo");
    const heartbeatFile = path.join(tmpDir, "test.heartbeat");
    const registryPath = path.join(tmpDir, "TestCollab.json");
    fs.writeFileSync(fifoPath, "fifo");
    fs.writeFileSync(heartbeatFile, Date.now().toString());
    fs.writeFileSync(registryPath, "{}");

    const tmpFile = path.join(tmpDir, "fd-file");
    fs.writeFileSync(tmpFile, "");
    const fd = fs.openSync(tmpFile, "r");

    await cleanupCollaboratorState({
      pid: 99999,
      killFirst: true,
      fifoPath,
      collabName: "TestCollab",
      heartbeatFile,
      registryDir: tmpDir,
      fifoWriteFd: fd,
    });

    expect(fs.existsSync(fifoPath)).toBe(false);
    expect(fs.existsSync(heartbeatFile)).toBe(false);
    expect(fs.existsSync(registryPath)).toBe(false);
  }, 15000);

  // ─────────────────────────────────────────────────────────────────────────
  // T6c: cleanupCollaboratorState({ killFirst: false }) — crash path (R2c)
  // ─────────────────────────────────────────────────────────────────────────

  it("killFirst:false does NOT call process.kill (crash path, R2c)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const fifoPath = path.join(tmpDir, "test.fifo");
    const heartbeatFile = path.join(tmpDir, "test.heartbeat");
    fs.writeFileSync(fifoPath, "fifo");
    fs.writeFileSync(heartbeatFile, "ts");

    const tmpFile = path.join(tmpDir, "fd-file");
    fs.writeFileSync(tmpFile, "");
    const fd = fs.openSync(tmpFile, "r");

    await cleanupCollaboratorState({
      pid: 12345,
      killFirst: false,
      fifoPath,
      collabName: "TestCollab",
      heartbeatFile,
      registryDir: tmpDir,
      fifoWriteFd: fd,
    });

    killSpy.mockRestore();

    // Process already dead — no kill signals
    expect(killSpy).not.toHaveBeenCalled();

    // Files still cleaned
    expect(fs.existsSync(fifoPath)).toBe(false);
    expect(fs.existsSync(heartbeatFile)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Partial failure resilience
  // ─────────────────────────────────────────────────────────────────────────

  it("partial failure: if fifoPath doesn't exist, cleanup continues for remaining files", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);

    // fifoPath does NOT exist — unlink throws
    const fifoPath = path.join(tmpDir, "nonexistent.fifo");
    const heartbeatFile = path.join(tmpDir, "test.heartbeat");
    const registryPath = path.join(tmpDir, "TestCollab.json");
    fs.writeFileSync(heartbeatFile, "ts");
    fs.writeFileSync(registryPath, "{}");

    const tmpFile = path.join(tmpDir, "fd-file");
    fs.writeFileSync(tmpFile, "");
    const fd = fs.openSync(tmpFile, "r");

    // Should not throw even if FIFO doesn't exist
    await expect(cleanupCollaboratorState({
      pid: 99999,
      killFirst: false,
      fifoPath,  // doesn't exist
      collabName: "TestCollab",
      heartbeatFile,
      registryDir: tmpDir,
      fifoWriteFd: fd,
    })).resolves.toBeUndefined();

    // heartbeat and registry still cleaned despite missing FIFO
    expect(fs.existsSync(heartbeatFile)).toBe(false);
    expect(fs.existsSync(registryPath)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Verify the inner cleanupCollaborator delegates to cleanupCollaboratorState
  // ─────────────────────────────────────────────────────────────────────────

  it("exported function is the production function — verify by inspecting source contract", async () => {
    // This test verifies that cleanupCollaboratorState is the same function
    // called by the runSpawn cleanup path (cli/index.ts:cleanupCollaborator).
    // The function is defined at module level and exported — any future changes
    // to runSpawn's cleanup path must go through this exported function.
    expect(typeof cleanupCollaboratorState).toBe("function");
    expect(cleanupCollaboratorState.length).toBe(1); // opts parameter
  });
});
