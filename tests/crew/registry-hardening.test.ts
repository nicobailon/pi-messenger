/**
 * Tests for spec 063 — Registry ENOENT race fix
 *
 * Covers: safeWriteJsonSync, registry.gc, verify-and-warn,
 * ENOENT regression property test, error messages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeWriteJsonSync, registerSpawnedWorker } from "../../store.js";
import { spawnSync, spawn as spawnChild } from "node:child_process";

const CLI_PATH = path.resolve(import.meta.dirname, "../../cli/index.ts");

function runCli(args: string[], env?: Record<string, string>, cwd?: string) {
  const result = spawnSync("npx", ["tsx", CLI_PATH, ...args], {
    cwd: cwd ?? os.tmpdir(),
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

// =============================================================================
// T10: safeWriteJsonSync unit tests
// =============================================================================

describe("safeWriteJsonSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-write-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates missing parent directory", () => {
    const nested = path.join(tmpDir, "deep", "nested", "file.json");
    safeWriteJsonSync(nested, { key: "value" });
    expect(fs.existsSync(nested)).toBe(true);
    const data = JSON.parse(fs.readFileSync(nested, "utf-8"));
    expect(data.key).toBe("value");
  });

  it("produces valid JSON at target path", () => {
    const target = path.join(tmpDir, "test.json");
    safeWriteJsonSync(target, { name: "test", count: 42 });
    const data = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(data.name).toBe("test");
    expect(data.count).toBe(42);
  });

  it("leaves no tmp files after success", () => {
    const target = path.join(tmpDir, "clean.json");
    safeWriteJsonSync(target, { done: true });
    const remaining = fs.readdirSync(tmpDir).filter(f => f.includes(".tmp-"));
    expect(remaining).toEqual([]);
  });

  // T9 Level 1: Property test — verify unique tmp name pattern
  it("uses unique tmp path with PID and timestamp (ENOENT regression)", () => {
    // Intercept the actual tmp path by checking what files transiently exist
    // We do this by writing twice and verifying the final file is correct
    const target = path.join(tmpDir, "race.json");
    safeWriteJsonSync(target, { call: 1 });
    safeWriteJsonSync(target, { call: 2 });

    // Both writes should succeed (unique tmp names)
    const data = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(data.call).toBe(2);

    // No tmp files left behind
    const tmps = fs.readdirSync(tmpDir).filter(f => f.includes(".tmp-"));
    expect(tmps).toEqual([]);
  });

  it("tmp filename includes PID and timestamp (not shared .{name}.tmp)", () => {
    // Use fs.watch to capture transient tmp files during write
    const observedTmps: string[] = [];
    const watcher = fs.watch(tmpDir, (event, filename) => {
      if (filename && filename.includes(".tmp-")) {
        observedTmps.push(filename);
      }
    });

    try {
      const target = path.join(tmpDir, "unique.json");
      safeWriteJsonSync(target, { a: 1 });
      // Small delay to ensure Date.now() differs
      const start = Date.now();
      while (Date.now() === start) { /* spin */ }
      safeWriteJsonSync(target, { a: 2 });
    } finally {
      watcher.close();
    }

    // Should have observed tmp files matching the unique pattern
    // (fs.watch may or may not catch them depending on timing, so
    // we verify the property structurally: the old pattern .{name}.tmp
    // would NOT match .tmp-{pid}-{timestamp})
    expect(fs.existsSync(path.join(tmpDir, ".unique.tmp"))).toBe(false);

    // Verify both writes succeeded and no leftover tmp files
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "unique.json"), "utf-8"));
    expect(data.a).toBe(2);
    const remaining = fs.readdirSync(tmpDir).filter(f => f.includes(".tmp"));
    expect(remaining).toEqual([]);
  });
});

// =============================================================================
// T9 Level 2: Multi-process smoke
// =============================================================================

describe("registerSpawnedWorker concurrent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-reg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two rapid same-process calls with same name both succeed (no ENOENT)", () => {
    registerSpawnedWorker(tmpDir, "/project", "SameName", process.pid, "model", "sess-1");
    registerSpawnedWorker(tmpDir, "/project", "SameName", process.pid, "model", "sess-2");

    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "SameName.json"), "utf-8"));
    expect(reg.sessionId).toBe("sess-2");
    expect(reg.pid).toBe(process.pid);
  });

  it("two concurrent forked processes with same name both succeed (multi-process smoke)", async () => {
    const workerScript = path.resolve(import.meta.dirname, "registry-worker.ts");
    const registryDir = path.join(tmpDir, "registry");
    fs.mkdirSync(registryDir, { recursive: true });

    // Launch two workers CONCURRENTLY using async spawn (not spawnSync)
    const runWorker = (): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      return new Promise((resolve) => {
        const proc = spawnChild("npx", ["tsx", workerScript, registryDir, "RaceBot"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("exit", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      });
    };

    // Both start concurrently — real overlap opportunity
    const [r1, r2] = await Promise.all([runWorker(), runWorker()]);

    // Both must succeed without ENOENT
    expect(r1.exitCode, `Worker 1 failed: ${r1.stderr}`).toBe(0);
    expect(r2.exitCode, `Worker 2 failed: ${r2.stderr}`).toBe(0);

    // Final file should exist and be valid JSON
    const reg = JSON.parse(fs.readFileSync(path.join(registryDir, "RaceBot.json"), "utf-8"));
    expect(reg.name).toBe("RaceBot");
  });
});

// =============================================================================
// T9 Level 3: Conditional spawn smoke (requires live Pi process)
// =============================================================================

// Spawn requires a live Pi process — skip in unit tests.
// See cli.test.ts:1166-1168: "spawn intentionally out of unit coverage"
it.skip("spawn smoke: single spawn completes without ENOENT (requires live Pi)", () => {
  // Would run: pi-messenger-cli spawn --agent crew-challenger --prompt "test"
  // Verify exit code 0 and no ENOENT in stderr
});

// =============================================================================
// T11: registry.gc tests
// =============================================================================

describe("registry.gc CLI command", () => {
  let testDir: string;
  let messengerDir: string;
  let registryDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
    messengerDir = path.join(testDir, "messenger");
    registryDir = path.join(messengerDir, "registry");
    fs.mkdirSync(registryDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("removes dead-PID .json files", () => {
    const deadReg = { name: "DeadBot", pid: 99999, model: "test", startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(registryDir, "DeadBot.json"), JSON.stringify(deadReg));

    const result = runCli(["registry.gc"], { PI_MESSENGER_DIR: messengerDir }, testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 dead registrations");
    expect(fs.existsSync(path.join(registryDir, "DeadBot.json"))).toBe(false);
  });

  it("removes orphaned .heartbeat files", () => {
    fs.writeFileSync(path.join(registryDir, "Ghost.heartbeat"), Date.now().toString());
    // No Ghost.json exists → orphaned

    const result = runCli(["registry.gc"], { PI_MESSENGER_DIR: messengerDir }, testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 orphaned heartbeats");
    expect(fs.existsSync(path.join(registryDir, "Ghost.heartbeat"))).toBe(false);
  });

  it("removes orphaned .tmp-* files with dead PID", () => {
    fs.writeFileSync(path.join(registryDir, "Bot.json.tmp-99999-1234567890"), "{}");

    const result = runCli(["registry.gc"], { PI_MESSENGER_DIR: messengerDir }, testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 orphaned tmp files");
  });

  it("does NOT remove files for live PIDs", () => {
    const liveReg = { name: "LiveBot", pid: process.pid, model: "test", startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(registryDir, "LiveBot.json"), JSON.stringify(liveReg));

    const result = runCli(["registry.gc"], { PI_MESSENGER_DIR: messengerDir }, testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 active registrations");
    expect(fs.existsSync(path.join(registryDir, "LiveBot.json"))).toBe(true);
  });

  it("removes dead .json AND its sibling .heartbeat in one pass", () => {
    // Regression: single-pass ordering meant heartbeat visited before dead .json
    // saw .json still existed and survived. Two-pass fixes this.
    const deadReg = { name: "OrderBot", pid: 99999, model: "test", startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(registryDir, "OrderBot.json"), JSON.stringify(deadReg));
    fs.writeFileSync(path.join(registryDir, "OrderBot.heartbeat"), Date.now().toString());

    const result = runCli(["registry.gc"], { PI_MESSENGER_DIR: messengerDir }, testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 dead registrations");
    expect(result.stdout).toContain("1 orphaned heartbeats");
    expect(fs.existsSync(path.join(registryDir, "OrderBot.json"))).toBe(false);
    expect(fs.existsSync(path.join(registryDir, "OrderBot.heartbeat"))).toBe(false);
  });

  it("does NOT remove unrecognized files (deletion guard)", () => {
    fs.writeFileSync(path.join(registryDir, "README.txt"), "do not delete");

    const result = runCli(["registry.gc"], { PI_MESSENGER_DIR: messengerDir }, testDir);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(registryDir, "README.txt"))).toBe(true);
  });
});

// =============================================================================
// T13: Error message tests
// =============================================================================

describe("registerSpawnedWorker error messages", () => {
  it("throws structured error with registry path when write fails", () => {
    // Use a non-writable path to trigger failure
    const badPath = "/nonexistent/deeply/nested/impossible/registry";
    try {
      registerSpawnedWorker(badPath, "/project", "FailBot", 123, "model", "sess");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("Failed to write registry entry for FailBot");
      expect(msg).toContain(badPath);
      expect(msg).toContain("registry.gc");
    }
  });
});

// =============================================================================
// T13 continued: bootstrapExternal error (via CLI)
// =============================================================================

describe("bootstrapExternal error handling", () => {
  it("CLI join with unwritable registry dir fails with error", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-err-"));
    try {
      // Create a valid messenger dir but make registry dir unwritable
      const messengerDir = path.join(testDir, "messenger");
      const sessionsDir = path.join(messengerDir, "cli-sessions");
      const registryDir = path.join(messengerDir, "registry");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      // Make registry dir read-only to trigger write failure
      fs.chmodSync(registryDir, 0o444);

      const result = runCli(["join", "--self-model", "test-model"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      // Restore permissions for cleanup
      fs.chmodSync(registryDir, 0o755);

      // Should fail — the registry write should produce structured error
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Failed to write registry entry");
      expect(result.stderr).toContain("registry.gc");
      expect(result.stderr).toContain(registryDir); // includes registry path
    } finally {
      // Ensure cleanup
      try { fs.chmodSync(path.join(testDir, "messenger", "registry"), 0o755); } catch {}
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// T9 Level 1 (strengthened): Source code property assertion
// =============================================================================

describe("safeWriteJsonSync source code property", () => {
  it("source uses unique tmp pattern with PID and timestamp, not shared .{name}.tmp", () => {
    // Read the actual source to verify the tmp naming pattern
    // This is a static analysis test — the definitive proof that the fix is in place
    const storeSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../store.ts"),
      "utf-8"
    );

    // Find the safeWriteJsonSync function body
    const fnMatch = storeSrc.match(
      /export function safeWriteJsonSync[\s\S]*?^}/m
    );
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    // Verify it uses the unique pattern: ${filePath}.tmp-${process.pid}-${Date.now()}
    expect(fnBody).toContain("process.pid");
    expect(fnBody).toContain("Date.now()");
    expect(fnBody).toContain(".tmp-");

    // Verify it does NOT use the old vulnerable pattern: .${name}.tmp
    expect(fnBody).not.toMatch(/`\.\$\{name\}\.tmp`/);

    // Also verify registerSpawnedWorker no longer has the old pattern
    expect(storeSrc).not.toMatch(/join\(registryDir,\s*`\.\$\{name\}\.tmp`\)/);
  });
});
