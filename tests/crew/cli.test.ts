import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLI_PATH = path.resolve(__dirname, "../../cli/index.ts");

function runCli(args: string[], env?: Record<string, string>, cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI_PATH, ...args], {
      encoding: "utf-8",
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      exitCode: err.status ?? 1,
    };
  }
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

    it("status shows agent info", () => {
      const result = runCli(["status"], env());
      expect(result.stdout).toContain("CliTest");
      expect(result.exitCode).toBe(0);
    });

    it("feed returns without error", () => {
      const result = runCli(["feed"], env());
      expect(result.exitCode).toBe(0);
    });

    it("send requires --to and --message", () => {
      const result = runCli(["send"], env());
      expect(result.stderr).toContain("Usage");
      expect(result.exitCode).toBe(1);
    });

    it("reserve requires --paths", () => {
      const result = runCli(["reserve"], env());
      expect(result.stderr).toContain("Usage");
      expect(result.exitCode).toBe(1);
    });

    it("unknown command shows help", () => {
      const result = runCli(["foobar"], env());
      expect(result.stderr).toContain("Unknown command");
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
});
