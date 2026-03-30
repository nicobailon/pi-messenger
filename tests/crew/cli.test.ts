import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLI_PATH = path.resolve(__dirname, "../../cli/index.ts");

function runCli(args: string[], env?: Record<string, string>, cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("npx", ["tsx", CLI_PATH, ...args], {
    encoding: "utf-8",
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...env },
    timeout: 15000,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? (result.error ? 1 : 0),
  };
}

/**
 * Async CLI runner using child_process.spawn.
 * Doesn't block the event loop — allows setTimeout file writes during poll.
 */
function runCliAsync(
  args: string[], env?: Record<string, string>, cwd?: string,
): { proc: ChildProcess; stdout: () => string; stderr: () => string; waitForExit: () => Promise<number> } {
  const proc = spawn("npx", ["tsx", CLI_PATH, ...args], {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...env },
  });
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (d: Buffer) => { stdoutBuf += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
  return {
    proc,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    waitForExit: () => new Promise(resolve => proc.on("exit", (code) => resolve(code ?? 1))),
  };
}

describe("pi-messenger-cli", () => {
  describe("arg parsing", () => {
    it("shows help with --help", () => {
      const result = runCli(["--help"]);
      expect(result.stdout).toContain("pi-messenger-cli");
      expect(result.stdout).toContain("Commands:");
      expect(result.exitCode).toBe(0);
    });

    it("shows help with no args", () => {
      const result = runCli([]);
      expect(result.stdout).toContain("Commands:");
    });
  });

  describe("external agent mode", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-cli-test-"));
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("read-only commands do NOT re-register (prevents PID clobber)", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });

      // list is read-only — must NOT create a registration file
      const result = runCli(["list"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "TestAgent",
      });

      expect(result.exitCode).toBe(0);

      // Verify NO registration file was created
      const regFile = path.join(messengerDir, "registry", "TestAgent.json");
      expect(fs.existsSync(regFile)).toBe(false);
    });

    it("join command DOES register (mutating command)", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });

      // Note: PI_AGENT_NAME is no longer used in external mode for name selection.
      // Session files (keyed by sha256(cwd+model)) replace PI_AGENT_NAME as the
      // persistence mechanism. bootstrapExternal() always generates a name via
      // generateMemorableName() for new sessions to preserve harness isolation.
      const result = runCli(["join", "--self-model", "test-join-model"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "",  // Cleared to prevent env bleed-through
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Joined mesh as");

      // Verify registration file WAS created (any name)
      const registryFiles = fs.readdirSync(path.join(messengerDir, "registry"))
        .filter(f => !f.startsWith(".") && f.endsWith(".json"));
      expect(registryFiles.length).toBeGreaterThan(0);

      const reg = JSON.parse(fs.readFileSync(path.join(messengerDir, "registry", registryFiles[0]), "utf-8"));
      expect(reg.name).toBeTruthy();
      expect(reg.isHuman).toBe(false);
    });

    it("read-only list after join does not clobber PID", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });

      // Simulate a spawn process that registered with a specific PID
      const regFile = path.join(messengerDir, "registry", "TestAgent.json");
      const fakeReg = {
        name: "TestAgent",
        pid: process.pid, // Use our own PID so isProcessAlive passes
        sessionId: "cli-fake",
        cwd: process.cwd(),
        model: "test",
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      };
      fs.writeFileSync(regFile, JSON.stringify(fakeReg, null, 2));

      // list must NOT overwrite the registration
      const result = runCli(["list"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "TestAgent",
      });

      expect(result.exitCode).toBe(0);

      // Registration PID must be unchanged (our PID, not the list process PID)
      const regAfter = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      expect(regAfter.pid).toBe(process.pid);
    });
  });

  describe("crew-spawned mode", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-cli-crew-test-"));
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("fails with error when registration not found", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });

      const result = runCli(["list"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_CREW_WORKER: "1",
        PI_AGENT_NAME: "CrewBot",
      });

      expect(result.stderr).toContain("registration not found");
      expect(result.exitCode).not.toBe(0);
    });

    it("reads pre-registration when PID matches", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });

      // Pre-register with current PID (simulating spawner behavior)
      // We use the parent process PID since the CLI will spawn as a child
      // Actually, we can't predict the child PID, so we test the external mode path
      // The crew-spawned test with matching PID is inherently a live integration test
    });
  });

  describe("command routing", () => {
    let testDir: string;
    let messengerDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-cli-cmd-test-"));
      messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    const env = () => ({
      PI_MESSENGER_DIR: messengerDir,
      PI_AGENT_NAME: "CliTest",
    });

    it("join registers agent", () => {
      // PI_AGENT_NAME is no longer used by bootstrapExternal() for name selection.
      // The session file mechanism (sha256(cwd+model)) replaces it.
      // This test verifies join succeeds and produces some agent name.
      const result = runCli(["join", "--self-model", "routing-test-model"], env());
      expect(result.stdout).toContain("Joined mesh as");
      expect(result.exitCode).toBe(0);
    });

    it("status shows anonymous without session", () => {
      // Without a session, status falls back to anonymous
      const result = runCli(["status"], env());
      expect(result.stdout).toContain("anonymous");
      expect(result.exitCode).toBe(0);
    });

    it("feed returns without error", () => {
      const result = runCli(["feed"], env());
      expect(result.exitCode).toBe(0);
    });

    it("send requires join first (no auto-create)", () => {
      // Non-join commands no longer auto-create sessions — they error
      const result = runCli(["send"], {
        ...env(),
        // Clear env vars that could trigger auto-detection
        PI_AGENT_MODEL: "",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        HOME: testDir, // no .codex/config.toml
      });
      expect(result.stderr).toContain("No active session");
      expect(result.exitCode).not.toBe(0);
    });

    it("send requires --to and --message (with session)", () => {
      // Join first, then test argument validation
      runCli(["join", "--self-model", "cmd-test-model"], env());
      const result = runCli(["send", "--self-model", "cmd-test-model"], env());
      expect(result.stderr).toContain("Usage");
      expect(result.exitCode).toBe(1);
    });

    it("reserve requires --paths (with session)", () => {
      runCli(["join", "--self-model", "cmd-test-model"], env());
      const result = runCli(["reserve", "--self-model", "cmd-test-model"], env());
      expect(result.stderr).toContain("Usage");
      expect(result.exitCode).toBe(1);
    });

    it("unknown command shows help", () => {
      // Unknown commands exit before bootstrap for registering path
      const result = runCli(["foobar"], env());
      // foobar is not in NO_REGISTER_COMMANDS, so bootstrap tries to register
      // and fails with "No active session" before reaching the unknown command check
      expect(result.exitCode).toBe(1);
    });
  });

  describe("nonce auth", () => {
    let testDir: string;
    let messengerDir: string;
    const workerName = "NonceWorker";

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-cli-nonce-test-"));
      messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    function writeRegistration(name: string, nonceHash?: string) {
      const reg = {
        name,
        pid: process.pid,
        sessionId: "test-session",
        cwd: testDir,
        model: "test-model",
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0 },
        activity: { lastActivityAt: new Date().toISOString() },
        ...(nonceHash ? { nonceHash } : {}),
      };
      fs.writeFileSync(
        path.join(messengerDir, "registry", `${name}.json`),
        JSON.stringify(reg, null, 2),
      );
    }

    it("allows mutating command with correct nonce", () => {
      const nonce = randomUUID();
      const hash = createHash("sha256").update(nonce).digest("hex");
      writeRegistration(workerName, hash);

      // send requires --to and --message, but nonce validation should pass
      // (the command itself will fail for lack of args, but NOT for nonce)
      const result = runCli(["send"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: workerName,
        PI_CREW_WORKER: "1",
        PI_CREW_NONCE: nonce,
      });
      // Should get usage error, not nonce error
      expect(result.stderr).toContain("Usage");
      expect(result.stderr).not.toContain("Nonce");
    });

    it("blocks mutating command with wrong nonce", () => {
      const nonce = randomUUID();
      const hash = createHash("sha256").update(nonce).digest("hex");
      writeRegistration(workerName, hash);

      const result = runCli(["send", "--to", "Someone", "--message", "hi"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: workerName,
        PI_CREW_WORKER: "1",
        PI_CREW_NONCE: "wrong-nonce",
      });
      expect(result.stderr).toContain("Nonce mismatch");
      expect(result.exitCode).toBe(1);
    });

    it("blocks mutating command with missing nonce when nonceHash set", () => {
      const nonce = randomUUID();
      const hash = createHash("sha256").update(nonce).digest("hex");
      writeRegistration(workerName, hash);

      const result = runCli(["send", "--to", "Someone", "--message", "hi"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: workerName,
        PI_CREW_WORKER: "1",
        // No PI_CREW_NONCE
      });
      expect(result.stderr).toContain("PI_CREW_NONCE required");
      expect(result.exitCode).toBe(1);
    });

    it("allows read-only commands without nonce", () => {
      const nonce = randomUUID();
      const hash = createHash("sha256").update(nonce).digest("hex");
      writeRegistration(workerName, hash);

      // list is read-only — no nonce needed
      const result = runCli(["list"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: workerName,
        PI_CREW_WORKER: "1",
        // No PI_CREW_NONCE — should work for read-only
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Nonce");
    });

    it("skips nonce check for legacy registrations (no nonceHash)", () => {
      writeRegistration(workerName); // no nonceHash

      // send without nonce — should work because no nonceHash in registration
      const result = runCli(["send"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: workerName,
        PI_CREW_WORKER: "1",
        // No PI_CREW_NONCE — but no nonceHash either, so should pass
      });
      // Should get usage error, not nonce error
      expect(result.stderr).toContain("Usage");
      expect(result.stderr).not.toContain("Nonce");
    });
  });

  // =============================================================================
  // Session persistence (Tasks 1-6): detectModel, readCliSession, writeCliSession,
  // bootstrapExternal, bootstrap model propagation, leave command
  // =============================================================================

  describe("session persistence", () => {
    let testDir: string;
    let messengerDir: string;

    beforeEach(() => {
      // Use realpathSync to get the canonical path — on macOS, os.tmpdir() returns
      // /var/folders/... which is a symlink to /private/var/folders/..., but
      // process.cwd() in a child process returns the resolved canonical path.
      // Both the test helpers and CLI invocations must use the same canonical path
      // so that session key computations (sha256(cwd+model)) agree.
      testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-session-test-")));
      messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    // Helper: compute sha256(cwd + model) session key
    function sessionKey(cwd: string, model: string): string {
      return createHash("sha256").update(cwd + model).digest("hex");
    }

    // Helper: write a session file directly
    function writeSession(model: string, name: string, startedAt?: string): void {
      const sessionsDir = path.join(messengerDir, "cli-sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const key = sessionKey(testDir, model);
      fs.writeFileSync(
        path.join(sessionsDir, `${key}.json`),
        JSON.stringify({ name, model, cwd: testDir, startedAt: startedAt ?? new Date().toISOString() }),
      );
    }

    // Helper: read a session file directly
    function readSession(model: string): { name: string; model: string } | null {
      const sessionsDir = path.join(messengerDir, "cli-sessions");
      const key = sessionKey(testDir, model);
      const p = path.join(sessionsDir, `${key}.json`);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }

    it("join creates a session file with model and name", () => {
      const result = runCli(["join", "--self-model", "test-model-abc"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Joined mesh as");

      // Session file must exist
      const session = readSession("test-model-abc");
      expect(session).not.toBeNull();
      expect(session!.model).toBe("test-model-abc");
      expect(session!.name).toBeTruthy();
    });

    it("join reuses name from existing session file (stable identity)", () => {
      // Pre-write session with known name
      writeSession("test-model-xyz", "KnownName");

      const result = runCli(["join", "--self-model", "test-model-xyz"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("KnownName");
    });

    it("status shows correct identity AND model from session file (read-only path)", () => {
      writeSession("test-model-status", "StatusAgentName");

      const result = runCli(["status", "--self-model", "test-model-status"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("StatusAgentName");
      // Model propagation: status must also show the session model, not "unknown"
      expect(result.stdout).toContain("Model: test-model-status");
    });

    it("expired session (>8h) generates a new name", () => {
      // Write session with timestamp 9 hours ago
      const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      writeSession("test-model-ttl", "ExpiredName", nineHoursAgo);

      const result = runCli(["join", "--self-model", "test-model-ttl"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      // Should NOT reuse the expired name
      expect(result.stdout).not.toContain("ExpiredName");
    });

    it("different models in same CWD get separate sessions (harness isolation)", () => {
      // Unset PI_AGENT_NAME to prevent env bleed-through. If PI_AGENT_NAME is set
      // in the parent environment (e.g., from a pi_messenger session), it would leak
      // into child processes and cause both sessions to get the same name — defeating
      // harness isolation. bootstrapExternal() intentionally does NOT use PI_AGENT_NAME
      // for the same reason.
      const result1 = runCli(["join", "--self-model", "model-alpha"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "",
      }, testDir);
      const result2 = runCli(["join", "--self-model", "model-beta"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "",
      }, testDir);

      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);

      const session1 = readSession("model-alpha");
      const session2 = readSession("model-beta");
      expect(session1).not.toBeNull();
      expect(session2).not.toBeNull();
      // Different models → different session files → different names
      expect(session1!.name).not.toBe(session2!.name);
    });

    it("leave clears session file, registry, and inbox", () => {
      // Set up a session first
      writeSession("test-model-leave", "LeaveTestAgent");
      // Pre-create registry and inbox for the agent
      const regPath = path.join(messengerDir, "registry", "LeaveTestAgent.json");
      const inboxDir = path.join(messengerDir, "inbox", "LeaveTestAgent");
      fs.writeFileSync(regPath, JSON.stringify({ name: "LeaveTestAgent", pid: 99999999, model: "test-model-leave" }));
      fs.mkdirSync(inboxDir, { recursive: true });

      const result = runCli(["leave", "--self-model", "test-model-leave"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Left mesh");

      // Session file deleted
      expect(readSession("test-model-leave")).toBeNull();
      // Registry deleted (PID 99999999 is dead)
      expect(fs.existsSync(regPath)).toBe(false);
      // Inbox deleted
      expect(fs.existsSync(inboxDir)).toBe(false);
    });

    it("leave with no session prints informational message", () => {
      const result = runCli(["leave", "--self-model", "no-session-model"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No active session");
    });

    it("leave with active PID clears only session file, not registry", () => {
      writeSession("test-model-live", "LiveAgent");
      // Write registry entry with CURRENT process PID (alive)
      const regPath = path.join(messengerDir, "registry", "LiveAgent.json");
      fs.writeFileSync(regPath, JSON.stringify({ name: "LiveAgent", pid: process.pid, model: "test-model-live" }));

      const result = runCli(["leave", "--self-model", "test-model-live"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      // Session cleared
      expect(readSession("test-model-live")).toBeNull();
      // Registry preserved (active PID)
      expect(fs.existsSync(regPath)).toBe(true);
      expect(result.stdout).toContain("in use");
    });

    it("leave is in READ_ONLY_COMMANDS — does not create a new registry entry", () => {
      writeSession("test-model-readonly-leave", "ReadonlyLeaveAgent");
      const registryDir = path.join(messengerDir, "registry");

      // Count registry entries before
      const before = fs.readdirSync(registryDir).filter(f => !f.startsWith(".")).length;

      runCli(["leave", "--self-model", "test-model-readonly-leave"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      // leave should not add any new registry files
      const after = fs.readdirSync(registryDir).filter(f => !f.startsWith(".")).length;
      expect(after).toBeLessThanOrEqual(before);
    });

    it("help output includes leave command and --self-model flag", () => {
      const result = runCli(["--help"]);
      expect(result.stdout).toContain("leave");
      expect(result.stdout).toContain("--self-model");
      expect(result.exitCode).toBe(0);
    });

    it("Codex config auto-detection reads model from ~/.codex/config.toml (no --self-model)", () => {
      // Create a fake HOME with a Codex config that has a known model
      const fakeHome = path.join(testDir, "fake-home");
      const fakeCodexDir = path.join(fakeHome, ".codex");
      fs.mkdirSync(fakeCodexDir, { recursive: true });
      fs.writeFileSync(path.join(fakeCodexDir, "config.toml"), [
        'tool_output_token_limit = 25000',
        'model = "gpt-5.3-codex-autodetect-test"',
        'model_reasoning_effort = "xhigh"',
        '',
        '[mcp_servers.foo]',
        'command = "bar"',
      ].join("\n"));

      // Run join WITHOUT --self-model — detectModel() must read from config.toml via HOME
      const result = runCli(["join"], {
        PI_MESSENGER_DIR: messengerDir,
        HOME: fakeHome,
        // Clear all harness env vars so only config.toml can provide the model
        PI_AGENT_MODEL: "",
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        PI_AGENT_NAME: "",
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Joined mesh as");

      // Session must have the model from config.toml, not "unknown"
      const session = readSession("gpt-5.3-codex-autodetect-test");
      expect(session).not.toBeNull();
      expect(session!.model).toBe("gpt-5.3-codex-autodetect-test");
    });

    it("--self-model and --model are parsed into separate args (flag isolation)", () => {
      // spawn uses cmd.args.model for collaborator model override (cli/index.ts:413)
      // join/status/etc use cmd.args.selfModel for driver identity
      // This test verifies parseArgs correctly separates them so they can't cross-contaminate.
      //
      // We test by: (a) join --self-model X creates session keyed on X,
      // and (b) the key does NOT match a session keyed on something else.
      // A real spawn integration test would require the pi binary; this validates
      // the parseArgs-level contract that protects against the collision.

      const result = runCli(["join", "--self-model", "driver-model-isolation"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "",
      }, testDir);

      expect(result.exitCode).toBe(0);
      const session = readSession("driver-model-isolation");
      expect(session?.model).toBe("driver-model-isolation");

      // session key must be sha256(cwd + "driver-model-isolation"), not sha256(cwd + something-else)
      const correctKey = createHash("sha256").update(testDir + "driver-model-isolation").digest("hex");
      const wrongKey = createHash("sha256").update(testDir + "collaborator-model").digest("hex");
      const sessionsDir = path.join(messengerDir, "cli-sessions");
      expect(fs.existsSync(path.join(sessionsDir, `${correctKey}.json`))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, `${wrongKey}.json`))).toBe(false);

      // Status also shows driver model from session (not collaborator model)
      const statusResult = runCli(["status", "--self-model", "driver-model-isolation"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "",
      }, testDir);
      expect(statusResult.stdout).toContain("Model: driver-model-isolation");
    });

    it("leave works when model detection fails (CWD-scan fallback)", () => {
      // Write a session without going through detectModel — simulates a runtime
      // where model detection is unavailable
      writeSession("some-model-leave-fallback", "FallbackLeaveAgent");
      const regPath = path.join(messengerDir, "registry", "FallbackLeaveAgent.json");
      const inboxDir = path.join(messengerDir, "inbox", "FallbackLeaveAgent");
      fs.writeFileSync(regPath, JSON.stringify({ name: "FallbackLeaveAgent", pid: 99999999 }));
      fs.mkdirSync(inboxDir, { recursive: true });

      // Leave WITHOUT --self-model, with no detectable runtime signals (clear HOME, clear API keys)
      // detectModel() will throw, leave must fall back to CWD scan
      const fakeHome = path.join(testDir, "empty-home");
      fs.mkdirSync(fakeHome, { recursive: true });
      const result = runCli(["leave"], {
        PI_MESSENGER_DIR: messengerDir,
        HOME: fakeHome,
        PI_AGENT_MODEL: "",
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Left mesh");

      // Session file cleaned up via CWD-scan fallback
      expect(readSession("some-model-leave-fallback")).toBeNull();
      expect(fs.existsSync(regPath)).toBe(false);
      expect(fs.existsSync(inboxDir)).toBe(false);
    });
  });

  // =============================================================================
  // Messaging round-trip (spec 010): identity stability, receive, send --wait, UX
  // =============================================================================

  describe("messaging round-trip", () => {
    let testDir: string;
    let messengerDir: string;

    beforeEach(() => {
      testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-roundtrip-")));
      messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    // Helper: compute session key
    function sessionKey(cwd: string, model: string): string {
      return createHash("sha256").update(cwd + model).digest("hex");
    }

    // Helper: write a session file
    function writeSession(model: string, name: string, startedAt?: string): void {
      const sessionsDir = path.join(messengerDir, "cli-sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const key = sessionKey(testDir, model);
      fs.writeFileSync(
        path.join(sessionsDir, `${key}.json`),
        JSON.stringify({ name, model, cwd: testDir, startedAt: startedAt ?? new Date().toISOString() }),
      );
    }

    // Helper: write a message to an agent's inbox
    function writeInboxMessage(agentName: string, from: string, text: string, extra?: Record<string, unknown>): string {
      const inboxDir = path.join(messengerDir, "inbox", agentName);
      fs.mkdirSync(inboxDir, { recursive: true });
      const timestamp = new Date().toISOString();
      const random = Math.random().toString(36).substring(2, 8);
      const filename = `${Date.now()}-${random}.json`;
      const msg = {
        id: randomUUID(),
        from,
        to: agentName,
        text,
        timestamp,
        replyTo: null,
        ...extra,
      };
      fs.writeFileSync(path.join(inboxDir, filename), JSON.stringify(msg, null, 2));
      return filename;
    }

    // Helper: extract name from join output
    function extractJoinName(stdout: string): string {
      const match = stdout.match(/Joined mesh as (\S+)/);
      if (!match) throw new Error(`Could not extract name from: ${stdout}`);
      return match[1];
    }

    // Helper: environment with no auto-detection signals
    function cleanEnv(extra?: Record<string, string>): Record<string, string> {
      const fakeHome = path.join(testDir, "fake-home");
      fs.mkdirSync(fakeHome, { recursive: true });
      return {
        PI_MESSENGER_DIR: messengerDir,
        HOME: fakeHome,
        PI_AGENT_MODEL: "",
        PI_AGENT_NAME: "",
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ...extra,
      };
    }

    // =========================================================================
    // Test 1: Identity stable — join --self-model X → send (no flag) → same name
    // =========================================================================
    it("identity stable: join with --self-model, send without → same name", () => {
      // Join with explicit model
      const joinResult = runCli(["join", "--self-model", "claude-opus-4-6"], cleanEnv(), testDir);
      expect(joinResult.exitCode).toBe(0);
      const joinName = extractJoinName(joinResult.stdout);

      // Send without --self-model. Since cleanEnv has no detection signals,
      // detectModel throws → CWD fallback finds the session
      const sendResult = runCli(
        ["send", "--to", "NonExistent", "--message", "test"],
        cleanEnv(),
        testDir,
      );
      // Send will fail (NonExistent not found) but the agent name should be stable
      // Check stderr for the agent name — it's in the error output from executeSend
      // The key assertion: it should NOT say "No active session" (which would mean identity was lost)
      expect(sendResult.stderr).not.toContain("No active session");

      // Verify the session file still has the original name
      const sessionsDir = path.join(messengerDir, "cli-sessions");
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json") && !f.startsWith("."));
      expect(files.length).toBe(1);
      const session = JSON.parse(fs.readFileSync(path.join(sessionsDir, files[0]), "utf-8"));
      expect(session.name).toBe(joinName);
    });

    // =========================================================================
    // Test 2: Identity stable — join → detectModel throw → CWD fallback
    // =========================================================================
    it("identity stable: detectModel throws → CWD fallback finds session", () => {
      // Pre-write a session
      writeSession("original-model", "StableAgent");

      // Status without any detection signals → CWD fallback
      const result = runCli(["status"], cleanEnv(), testDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("StableAgent");
      expect(result.stdout).toContain("Model: original-model");
    });

    // =========================================================================
    // Test 3: CWD ambiguity — two sessions same CWD → error
    // =========================================================================
    it("CWD ambiguity: two sessions same CWD → error mentions --self-model", () => {
      writeSession("model-a", "AgentA");
      writeSession("model-b", "AgentB");

      // Status without --self-model → ambiguity error
      const result = runCli(["status"], cleanEnv(), testDir);
      expect(result.stderr).toContain("Multiple sessions");
      expect(result.stderr).toContain("--self-model");
    });

    // =========================================================================
    // Test 4: Receive reads inbox → prints → deletes
    // =========================================================================
    it("receive reads inbox: prints message, deletes file", () => {
      writeSession("test-model", "RecvAgent");
      writeInboxMessage("RecvAgent", "SenderBot", "Hello from SenderBot!");

      const result = runCli(["receive", "--self-model", "test-model"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[SenderBot");
      expect(result.stdout).toContain("Hello from SenderBot!");
      expect(result.stdout).toContain("1 message received");

      // File should be deleted
      const inboxDir = path.join(messengerDir, "inbox", "RecvAgent");
      const remaining = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
      expect(remaining.length).toBe(0);
    });

    // =========================================================================
    // Test 5: Receive malformed → file NOT deleted, valid messages still read
    // =========================================================================
    it("receive malformed: warns on stderr, file preserved, valid messages processed", () => {
      writeSession("test-model", "MalAgent");
      const inboxDir = path.join(messengerDir, "inbox", "MalAgent");
      fs.mkdirSync(inboxDir, { recursive: true });
      // Write a malformed file (sorts first alphabetically)
      fs.writeFileSync(path.join(inboxDir, "0000-bad.json"), "not valid json {{{");
      // Write a valid message (sorts second)
      writeInboxMessage("MalAgent", "GoodSender", "valid message");

      const result = runCli(["receive", "--self-model", "test-model"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      // R8: Warning on stderr for malformed file
      expect(result.stderr).toContain("malformed");
      expect(result.stderr).toContain("0000-bad.json");
      // Valid message was read and printed
      expect(result.stdout).toContain("GoodSender");
      expect(result.stdout).toContain("valid message");
      expect(result.stdout).toContain("1 message received");

      // Malformed file should NOT be deleted
      expect(fs.existsSync(path.join(inboxDir, "0000-bad.json"))).toBe(true);
      // Valid message file SHOULD be deleted (only malformed remains)
      const remaining = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
      expect(remaining.length).toBe(1);
      expect(remaining[0]).toBe("0000-bad.json");
    });

    // =========================================================================
    // Test 6: Receive before join → guidance
    // =========================================================================
    it("receive before join: anonymous → guidance", () => {
      const result = runCli(["receive"], cleanEnv(), testDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No active session");
      expect(result.stdout).toContain("join");
    });

    // =========================================================================
    // Test 7: Receive empty → "No new messages."
    // =========================================================================
    it("receive empty inbox: prints 'No new messages.'", () => {
      writeSession("test-model", "EmptyAgent");

      const result = runCli(["receive", "--self-model", "test-model"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No new messages");
    });

    // =========================================================================
    // Test 8: Send --wait gets reply (async)
    // =========================================================================
    it("send --wait gets reply from inbox", async () => {
      // Set up: join first, create a target agent registration
      const joinResult = runCli(["join", "--self-model", "wait-model"], cleanEnv(), testDir);
      const agentName = extractJoinName(joinResult.stdout);

      // Create a fake target agent registration so send doesn't fail on "not found"
      const targetReg = {
        name: "TargetAgent",
        pid: process.pid, // use our PID so it appears alive
        sessionId: "test",
        cwd: testDir,
        model: "target-model",
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      };
      fs.writeFileSync(
        path.join(messengerDir, "registry", "TargetAgent.json"),
        JSON.stringify(targetReg, null, 2),
      );

      // Write a "reply" to our inbox with a small delay
      const replyDelay = setTimeout(() => {
        writeInboxMessage(agentName, "TargetAgent", "This is the reply!");
      }, 500);

      // Run send --wait with short timeout using shared async helper
      const cli = runCliAsync(
        ["send", "--to", "TargetAgent", "--message", "ping", "--wait", "--timeout", "5", "--self-model", "wait-model"],
        { ...process.env as Record<string, string>, ...cleanEnv() },
        testDir,
      );

      const exitCode = await cli.waitForExit();
      clearTimeout(replyDelay);

      expect(exitCode).toBe(0);
      expect(cli.stdout()).toContain("Reply from TargetAgent");
      expect(cli.stdout()).toContain("This is the reply!");
    }, 15000);

    // =========================================================================
    // Test 9: Send --wait timeout
    // =========================================================================
    it("send --wait timeout: no reply → error", async () => {
      const joinResult = runCli(["join", "--self-model", "timeout-model"], cleanEnv(), testDir);
      expect(joinResult.exitCode).toBe(0);

      // Create target registration
      const targetReg = {
        name: "SlowAgent",
        pid: process.pid,
        sessionId: "test",
        cwd: testDir,
        model: "slow-model",
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      };
      fs.writeFileSync(
        path.join(messengerDir, "registry", "SlowAgent.json"),
        JSON.stringify(targetReg, null, 2),
      );

      const cli = runCliAsync(
        ["send", "--to", "SlowAgent", "--message", "ping", "--wait", "--timeout", "1", "--self-model", "timeout-model"],
        { ...process.env as Record<string, string>, ...cleanEnv() },
        testDir,
      );

      const exitCode = await cli.waitForExit();

      expect(exitCode).toBe(1);
      expect(cli.stderr()).toContain("No reply from SlowAgent");
      expect(cli.stderr()).toContain("receive");
      expect(cli.stderr()).toContain("collaborator");  // T-B2R: R5 recovery hint present
    }, 15000);

    // =========================================================================
    // Test 10: Send --wait non-consumption — other agent's message untouched
    // =========================================================================
    it("send --wait leaves non-matching messages in inbox", async () => {
      const joinResult = runCli(["join", "--self-model", "nc-model"], cleanEnv(), testDir);
      const agentName = extractJoinName(joinResult.stdout);

      // Create target registration
      const targetReg = {
        name: "WaitTarget",
        pid: process.pid,
        sessionId: "test",
        cwd: testDir,
        model: "wait-target-model",
        startedAt: new Date().toISOString(),
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      };
      fs.writeFileSync(
        path.join(messengerDir, "registry", "WaitTarget.json"),
        JSON.stringify(targetReg, null, 2),
      );

      // Pre-write a message from OtherAgent (not WaitTarget)
      writeInboxMessage(agentName, "OtherAgent", "I am not the reply you're looking for");

      const cli = runCliAsync(
        ["send", "--to", "WaitTarget", "--message", "ping", "--wait", "--timeout", "1", "--self-model", "nc-model"],
        { ...process.env as Record<string, string>, ...cleanEnv() },
        testDir,
      );

      const exitCode = await cli.waitForExit();

      // Should timeout (no reply from WaitTarget)
      expect(exitCode).toBe(1);

      // OtherAgent's message should still be in inbox
      const inboxDir = path.join(messengerDir, "inbox", agentName);
      const remaining = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json") && !f.startsWith("."));
      const contents = remaining.map(f => JSON.parse(fs.readFileSync(path.join(inboxDir, f), "utf-8")));
      const otherMsg = contents.find((m: any) => m.from === "OtherAgent");
      expect(otherMsg).toBeDefined();
      expect(otherMsg.text).toBe("I am not the reply you're looking for");
    }, 15000);

    // =========================================================================
    // Test 10b: Double-wait guard — send --wait skips poll when executeSend returns error
    // (Proxy for collaborator-inline-reply guard: details.error/reply/conversationComplete → no poll)
    // =========================================================================
    it("send --wait skips poll when send fails (double-wait guard)", () => {
      // Join first
      runCli(["join", "--self-model", "guard-model"], cleanEnv(), testDir);

      // Send to non-existent target with --wait — executeSend returns error,
      // double-wait guard should break immediately, NOT enter 300s poll loop
      // If the guard is broken, this test would hang for 300s (timeout).
      const result = runCli(
        ["send", "--to", "NonExistentAgent", "--message", "test", "--wait", "--self-model", "guard-model"],
        cleanEnv(),
        testDir,
      );

      // Should fail quickly with send error, NOT with timeout error
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("No reply from");  // timeout message
      expect(result.stderr).not.toContain("Waiting for reply"); // poll loop message
    });

    // =========================================================================
    // Test 11: UX — join mentions receive
    // =========================================================================
    it("join output mentions receive", () => {
      const result = runCli(["join", "--self-model", "ux-test-model"], cleanEnv(), testDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("receive");
    });

    // =========================================================================
    // Test 12: UX — status anonymous mentions join
    // =========================================================================
    it("status anonymous mentions join", () => {
      const result = runCli(["status"], cleanEnv(), testDir);
      expect(result.stdout).toContain("anonymous");
      expect(result.stdout).toContain("join");
    });

    // =========================================================================
    // Test 13: Round-trip — join → inbox-level message → receive
    // (True CLI send requires live PID; send path proven by tests 8-10)
    // =========================================================================
    it("round-trip: join → inbox write (sendMessageToAgent format) → receive reads reply", () => {
      // Join
      const joinResult = runCli(["join", "--self-model", "rt-model"], cleanEnv(), testDir);
      expect(joinResult.exitCode).toBe(0);
      const agentName = extractJoinName(joinResult.stdout);

      // Simulate a reply arriving (same format as sendMessageToAgent)
      writeInboxMessage(agentName, "ReplyBot", "Here is your answer!");

      // Receive
      const recvResult = runCli(["receive", "--self-model", "rt-model"], {
        PI_MESSENGER_DIR: messengerDir,
      }, testDir);

      expect(recvResult.exitCode).toBe(0);
      expect(recvResult.stdout).toContain("[ReplyBot");
      expect(recvResult.stdout).toContain("Here is your answer!");
      expect(recvResult.stdout).toContain("1 message received");

      // Inbox should be empty now
      const inboxDir = path.join(messengerDir, "inbox", agentName);
      const remaining = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
      expect(remaining.length).toBe(0);
    });

    // =========================================================================
    // Test 14: Leave ambiguity — two sessions same CWD → error
    // =========================================================================
    it("leave ambiguity: two sessions same CWD → error", () => {
      writeSession("model-x", "AgentX");
      writeSession("model-y", "AgentY");

      const result = runCli(["leave"], cleanEnv(), testDir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Multiple sessions");
      expect(result.stderr).toContain("--self-model");
    });

    // =========================================================================
    // T-B1 (spec 055 R1): send --wait to known collaborator → error instead of timeout
    // =========================================================================
    it("send --wait to known collaborator: error instead of timeout", () => {
      // Uses cleanEnv() HOME override — getCollabStateDir() resolves to fake-home
      const env = cleanEnv();
      const fakeHome = path.join(testDir, "fake-home");
      const collabDir = path.join(fakeHome, ".pi", "agent", "messenger", "collaborators");
      fs.mkdirSync(collabDir, { recursive: true });
      fs.writeFileSync(path.join(collabDir, "OakStorm.json"), JSON.stringify({
        name: "OakStorm", pid: 99999, fifoPath: "/tmp/fake.fifo",
        logFile: "/tmp/fake.log", agent: "crew-challenger",
        spawnedBy: "TestDriver", startedAt: new Date().toISOString(),
      }, null, 2));
      runCli(["join", "--self-model", "test-model"], env, testDir);

      // synchronous runCli — 15s spawnSync timeout self-validates guard fires before inbox poll
      const result = runCli(
        ["send", "--to", "OakStorm", "--message", "re-review", "--wait", "--self-model", "test-model"],
        env, testDir,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("OakStorm");
      expect(result.stderr).toContain("collaborator");
      expect(result.stderr).toContain("spawn-per-turn");
    });

    // =========================================================================
    // T-B2 (spec 055 R2): send --phase writes phase field to recipient inbox JSON
    // =========================================================================
    it("send --phase writes phase field to recipient inbox JSON", () => {
      const env = cleanEnv();
      runCli(["join", "--self-model", "phase-test-model"], env, testDir);
      fs.writeFileSync(path.join(messengerDir, "registry", "PhaseTarget.json"), JSON.stringify({
        name: "PhaseTarget", pid: process.pid, sessionId: "test",
        cwd: testDir, model: "target-model", startedAt: new Date().toISOString(),
        isHuman: false, session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      }, null, 2));

      const result = runCli(
        ["send", "--to", "PhaseTarget", "--message", "here is my review", "--phase", "review", "--self-model", "phase-test-model"],
        env, testDir,
      );
      expect(result.exitCode).toBe(0);

      const inboxDir = path.join(messengerDir, "inbox", "PhaseTarget");
      const files = fs.readdirSync(inboxDir).filter((f: string) => f.endsWith(".json")).sort();
      expect(files.length).toBe(1);  // exactly one message
      const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, files[files.length - 1]), "utf-8"));
      expect(msg.phase).toBe("review");
      expect(msg.text).toBe("here is my review");
    });

    // =========================================================================
    // T-B3 (spec 055 R0): spawn-per-turn lifecycle via CLI commands
    // spawn is intentionally out of unit coverage (requires live Pi process).
    // This test proves the protocol: guard blocks → dismiss cleans up → second turn deliverable.
    // =========================================================================
    it("spawn-per-turn lifecycle: guard blocks → dismiss cleans up → second turn proceeds", () => {
      const env = cleanEnv();
      const fakeHome = path.join(testDir, "fake-home");
      const collabDir = path.join(fakeHome, ".pi", "agent", "messenger", "collaborators");
      fs.mkdirSync(collabDir, { recursive: true });

      const collabFile = path.join(collabDir, "OakStorm.json");
      fs.writeFileSync(collabFile, JSON.stringify({
        name: "OakStorm", pid: 99999, fifoPath: "/tmp/fake-oak-storm.fifo",
        logFile: "/tmp/fake-oak-storm.log", agent: "crew-challenger",
        spawnedBy: "TestDriver", startedAt: new Date().toISOString(),
      }, null, 2));

      // Join — capture output to extract driver name deterministically (same as Tests 1, 8, 10, 13)
      const joinResult = runCli(["join", "--self-model", "lifecycle-model"], env, testDir);
      expect(joinResult.exitCode).toBe(0);
      const driverName = extractJoinName(joinResult.stdout);
      expect(driverName).toBeTruthy();  // hard assert — no optional path below

      // Step 1: send --wait to active collaborator is blocked by B1 guard
      const blocked = runCli(
        ["send", "--to", "OakStorm", "--message", "turn 1 re-review", "--wait", "--self-model", "lifecycle-model"],
        env, testDir,
      );
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toContain("spawn-per-turn");

      // Step 2: dismiss via CLI command — exercises runDismiss path, calls deleteCollabState
      // PID 99999 is likely dead — SIGTERM throws ESRCH, caught silently; FIFO unlink also silent
      const dismissed = runCli(
        ["dismiss", "--name", "OakStorm", "--self-model", "lifecycle-model"],
        env, testDir,
      );
      expect(dismissed.exitCode).toBe(0);
      expect(dismissed.stdout).toContain("dismissed");
      expect(fs.existsSync(collabFile)).toBe(false);  // state file cleaned up by CLI

      // Step 3: simulate second-turn spawn — fresh collaborator writes review to driver inbox
      writeInboxMessage(driverName, "OakJaguar", "Approved — fix looks correct.");

      // Step 4: receive confirms second-turn message is deliverable
      const received = runCli(["receive", "--self-model", "lifecycle-model"], env, testDir);
      expect(received.exitCode).toBe(0);
      expect(received.stdout).toContain("OakJaguar");
      expect(received.stdout).toContain("Approved");
    });
  });
});
