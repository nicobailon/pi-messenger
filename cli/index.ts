#!/usr/bin/env -S npx tsx
/**
 * pi-messenger-cli — Standalone CLI for non-pi runtimes
 *
 * Allows Claude Code, Codex, Gemini CLI, and external agents to interact
 * with the pi-messenger mesh without requiring the pi extension system.
 *
 * Two modes:
 * - Crew-spawned (PI_CREW_WORKER=1): Worker was pre-registered by spawner
 * - External agent: Self-registers on every command
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as store from "../store.js";
import * as crewStore from "../crew/store.js";
import * as handlers from "../handlers.js";
import { logFeedEvent } from "../feed.js";
import { generateMemorableName } from "../lib.js";
import type { MessengerState, Dirs } from "../lib.js";

// =============================================================================
// Bootstrap
// =============================================================================

function getMessengerDirs(): Dirs {
  const baseDir = process.env.PI_MESSENGER_DIR || path.join(os.homedir(), ".pi", "agent", "messenger");
  return {
    base: baseDir,
    registry: path.join(baseDir, "registry"),
    inbox: path.join(baseDir, "inbox"),
  };
}

function createMinimalState(name: string, cwd: string): MessengerState {
  return {
    agentName: name,
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
    model: process.env.PI_AGENT_MODEL ?? "unknown",
    gitBranch: getGitBranch(cwd),
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    customStatus: false,
  };
}

function getGitBranch(cwd: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf-8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Crew-spawned mode: The spawner pre-registered us. Read our name from the
 * registry and verify PID match. Retry up to 3 times to handle spawn race.
 */
function bootstrapCrewSpawned(dirs: Dirs): string | null {
  const expectedName = process.env.PI_AGENT_NAME;
  if (!expectedName) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const regPath = path.join(dirs.registry, `${expectedName}.json`);
      if (fs.existsSync(regPath)) {
        const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
        // Verify PID is alive (could be stale)
        if (reg.pid && isProcessAlive(reg.pid)) {
          return expectedName;
        }
      }
    } catch {}

    if (attempt < 2) {
      // Sleep 100ms between retries
      const start = Date.now();
      while (Date.now() - start < 100) { /* spin */ }
    }
  }
  return null;
}

/**
 * External agent mode: Self-register with a memorable name.
 * Re-registers on every command to stay current.
 */
function bootstrapExternal(dirs: Dirs, cwd: string): string {
  const name = process.env.PI_AGENT_NAME || generateMemorableName();
  const regDir = dirs.registry;

  try {
    fs.mkdirSync(regDir, { recursive: true });
  } catch {}

  const registration = {
    name,
    pid: process.pid,
    sessionId: `cli-${process.pid}`,
    cwd,
    model: process.env.PI_AGENT_MODEL ?? "unknown",
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };

  // Atomic write: tmp file + rename
  const tmpPath = path.join(regDir, `.${name}.tmp`);
  const finalPath = path.join(regDir, `${name}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(registration, null, 2));
  fs.renameSync(tmpPath, finalPath);

  return name;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Command Parsing
// =============================================================================

interface ParsedCommand {
  action: string;
  args: Record<string, string | string[] | boolean>;
}

function parseArgs(argv: string[]): ParsedCommand {
  const [action, ...rest] = argv;
  if (!action) {
    return { action: "help", args: {} };
  }

  const args: Record<string, string | string[] | boolean> = {};
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
        i++;
      } else {
        // Collect multiple values for known array args
        if (key === "paths") {
          const paths: string[] = [];
          while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
            paths.push(rest[++i]);
          }
          args[key] = paths;
        } else {
          args[key] = next;
          i += 2;
        }
      }
    } else {
      // Positional argument — used as "id" for task commands
      if (!args.id) args.id = arg;
      i++;
    }
  }

  return { action, args };
}

// =============================================================================
// Output Formatting
// =============================================================================

function formatResult(result: { content: Array<{ text: string }>; details: Record<string, unknown> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function printResult(result: { content: Array<{ text: string }>; details: Record<string, unknown> }): void {
  const text = formatResult(result);
  const isError = (result.details as { error?: string }).error;
  if (isError) {
    process.stderr.write(`✗ ${text}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`✓ ${text}\n`);
  }
}

// =============================================================================
// Command Handlers
// =============================================================================

function bootstrap(cwd: string): { state: MessengerState; dirs: Dirs } {
  const dirs = getMessengerDirs();
  const isCrewSpawned = process.env.PI_CREW_WORKER === "1";

  let name: string;
  if (isCrewSpawned) {
    const crewName = bootstrapCrewSpawned(dirs);
    if (!crewName) {
      process.stderr.write("✗ Crew-spawned worker: registration not found after retries.\n");
      process.exit(1);
    }
    name = crewName;
  } else {
    name = bootstrapExternal(dirs, cwd);
  }

  const state = createMinimalState(name, cwd);
  return { state, dirs };
}

async function runCommand(cmd: ParsedCommand, cwd: string): Promise<void> {
  if (cmd.action === "help" || cmd.action === "--help" || cmd.action === "-h") {
    printHelp();
    return;
  }

  if (cmd.action === "version" || cmd.action === "--version") {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
    process.stdout.write(`pi-messenger-cli v${pkg.version}\n`);
    return;
  }

  const { state, dirs } = bootstrap(cwd);

  switch (cmd.action) {
    case "join":
      // External agents: self-register (already done in bootstrap)
      logFeedEvent(cwd, state.agentName, "join");
      process.stdout.write(`✓ Joined mesh as ${state.agentName}\n`);
      break;

    case "status":
      printResult(handlers.executeStatus(state, dirs, cwd));
      break;

    case "list":
      printResult(handlers.executeList(state, dirs, cwd));
      break;

    case "send": {
      const to = cmd.args.to as string;
      const message = cmd.args.message as string;
      if (!to || !message) {
        process.stderr.write("✗ Usage: pi-messenger-cli send --to <name> --message <text>\n");
        process.exitCode = 1;
        return;
      }
      printResult(handlers.executeSend(state, dirs, cwd, to, false, message));
      break;
    }

    case "reserve": {
      const paths = cmd.args.paths as string[] | undefined;
      if (!paths || paths.length === 0) {
        process.stderr.write("✗ Usage: pi-messenger-cli reserve --paths <path1> [path2...]\n");
        process.exitCode = 1;
        return;
      }
      // handlers.executeReserve needs ctx — use a minimal stand-in
      const minimalCtx = { cwd, hasUI: false } as any;
      printResult(handlers.executeReserve(state, dirs, minimalCtx, paths, cmd.args.reason as string));
      break;
    }

    case "release": {
      const paths = cmd.args.paths as string[] | undefined;
      const minimalCtx = { cwd, hasUI: false } as any;
      printResult(handlers.executeRelease(state, dirs, minimalCtx, paths ?? true));
      break;
    }

    case "feed":
      printResult(handlers.executeFeed(cwd, cmd.args.limit ? parseInt(cmd.args.limit as string, 10) : undefined));
      break;

    case "task.start": {
      const id = cmd.args.id as string;
      if (!id) {
        process.stderr.write("✗ Usage: pi-messenger-cli task.start <task-id>\n");
        process.exitCode = 1;
        return;
      }
      const taskHandlers = await import("../crew/handlers/task.js");
      printResult(taskHandlers.execute("start", { id }, state, { cwd, hasUI: false } as any));
      break;
    }

    case "task.done": {
      const id = cmd.args.id as string;
      const summary = cmd.args.summary as string;
      if (!id) {
        process.stderr.write("✗ Usage: pi-messenger-cli task.done <task-id> --summary <text>\n");
        process.exitCode = 1;
        return;
      }
      const taskHandlers = await import("../crew/handlers/task.js");
      printResult(taskHandlers.execute("done", { id, summary }, state, { cwd, hasUI: false } as any));
      break;
    }

    case "task.list": {
      const taskHandlers = await import("../crew/handlers/task.js");
      printResult(taskHandlers.execute("list", {}, state, { cwd, hasUI: false } as any));
      break;
    }

    case "task.show": {
      const id = cmd.args.id as string;
      if (!id) {
        process.stderr.write("✗ Usage: pi-messenger-cli task.show <task-id>\n");
        process.exitCode = 1;
        return;
      }
      const taskHandlers = await import("../crew/handlers/task.js");
      printResult(taskHandlers.execute("show", { id }, state, { cwd, hasUI: false } as any));
      break;
    }

    default:
      process.stderr.write(`✗ Unknown command: ${cmd.action}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  process.stdout.write(`pi-messenger-cli — Mesh access for non-pi runtimes

Commands:
  join                              Register on the mesh
  status                            Show your status
  list                              List active agents
  send --to <name> --message <text> Send a message
  reserve --paths <path...>         Reserve files
  release [--paths <path...>]       Release reservations
  feed [--limit <n>]                Show activity feed
  task.list                         List all tasks
  task.show <id>                    Show task details
  task.start <id>                   Claim and start a task
  task.done <id> --summary <text>   Complete a task

Environment:
  PI_AGENT_NAME     Agent name (auto-generated if not set)
  PI_AGENT_MODEL    Model identifier for registration
  PI_CREW_WORKER=1  Crew-spawned mode (reads pre-registration)
  PI_MESSENGER_DIR  Override messenger directory
`);
}

// =============================================================================
// Main
// =============================================================================

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const cwd = process.cwd();
const cmd = parseArgs(process.argv.slice(2));

runCommand(cmd, cwd).catch((err) => {
  process.stderr.write(`✗ Fatal: ${err.message}\n`);
  process.exitCode = 1;
});
