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

      const result = runCli(["join"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "TestAgent",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TestAgent");

      // Verify registration file WAS created
      const regFile = path.join(messengerDir, "registry", "TestAgent.json");
      expect(fs.existsSync(regFile)).toBe(true);

      const reg = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      expect(reg.name).toBe("TestAgent");
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
      const result = runCli(["join"], env());
      expect(result.stdout).toContain("Joined mesh as CliTest");
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
});
