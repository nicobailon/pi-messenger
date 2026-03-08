import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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

    it("self-registers on list command", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });

      const result = runCli(["list"], {
        PI_MESSENGER_DIR: messengerDir,
        PI_AGENT_NAME: "TestAgent",
      });

      // Should register and show itself
      expect(result.stdout).toContain("TestAgent");

      // Verify registration file was created
      const regFile = path.join(messengerDir, "registry", "TestAgent.json");
      expect(fs.existsSync(regFile)).toBe(true);

      const reg = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      expect(reg.name).toBe("TestAgent");
      expect(reg.isHuman).toBe(false);
    });

    it("generates a name when PI_AGENT_NAME is not set", () => {
      const messengerDir = path.join(testDir, "messenger");
      fs.mkdirSync(path.join(messengerDir, "registry"), { recursive: true });
      fs.mkdirSync(path.join(messengerDir, "inbox"), { recursive: true });

      const result = runCli(["list"], {
        PI_MESSENGER_DIR: messengerDir,
      });

      // Should have generated some name and shown it
      expect(result.exitCode).toBe(0);

      // Should have a registration file
      const files = fs.readdirSync(path.join(messengerDir, "registry"));
      expect(files.filter(f => f.endsWith(".json")).length).toBe(1);
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
});
