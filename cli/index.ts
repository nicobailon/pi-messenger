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
import { createHash, randomUUID } from "node:crypto";
import { spawn as spawnProcess, execFileSync } from "node:child_process";
import * as store from "../store.js";
import * as crewStore from "../crew/store.js";
import * as handlers from "../handlers.js";
import { logFeedEvent } from "../feed.js";
import { generateMemorableName } from "../lib.js";
import type { MessengerState, Dirs, AgentMailMessage } from "../lib.js";
import { discoverCrewAgents } from "../crew/utils/discover.js";
import { loadCrewConfig } from "../crew/utils/config.js";
import { resolveModel } from "../crew/utils/model.js";
import { pushModelArgs, resolveThinking, modelHasThinkingSuffix } from "../crew/agents.js";

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
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    registrationContextSent: false,
    blockingCollaborators: new Set(),
    completedCollaborators: new Set(),
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
 * Defense-in-depth identity verification for crew-spawned workers.
 * Prevents accidental CLI invocation from wrong worker process.
 * NOT a security boundary — nonce is an env var readable by same-user processes,
 * hashed with unsalted SHA-256. Protects against cross-talk, not adversaries.
 *
 * No-ops for legacy registrations (no nonceHash) and external agents.
 */
function validateNonce(dirs: Dirs, agentName: string): void {
  const nonce = process.env.PI_CREW_NONCE;
  const regPath = path.join(dirs.registry, `${agentName}.json`);
  try {
    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!reg.nonceHash) return; // legacy or external agent — no nonce required
    if (!nonce) {
      throw new Error("PI_CREW_NONCE required for mutating commands on crew-spawned workers");
    }
    const hash = createHash("sha256").update(nonce).digest("hex");
    if (hash !== reg.nonceHash) {
      throw new Error("Nonce mismatch — wrong worker identity");
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes("Nonce") || e.message.includes("PI_CREW_NONCE"))) {
      throw e; // Re-throw nonce-specific errors
    }
    // Registration file not found or unparseable — skip nonce check
  }
}

const MUTATING_COMMANDS = new Set(["send", "reserve", "release", "task.start", "task.done"]);

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

// =============================================================================
// Model Detection (Task 1)
// =============================================================================

interface CliSession {
  name: string;
  model: string;
  cwd: string;
  startedAt: string;
}

/**
 * Detect the model/harness identifier for a non-pi runtime.
 *
 * Priority stack (first match wins):
 * 1. `--self-model` CLI flag (explicit override)
 * 2. PI_AGENT_MODEL environment variable
 * 3. Codex config probe: ~/.codex/config.toml → top-level `model = "..."` field
 * 4. Harness detection: presence of known config files / API key env vars
 * 5. Error — caller must supply --self-model or set PI_AGENT_MODEL
 *
 * Never returns "unknown".
 */
function detectModel(modelFlag?: string): string {
  // 1. Explicit flag
  if (modelFlag) return modelFlag;

  // 2. Environment variable
  const envModel = process.env.PI_AGENT_MODEL;
  if (envModel && envModel !== "unknown") return envModel;

  // 3. Codex config probe: read ~/.codex/config.toml, extract top-level model field
  const codexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
  if (fs.existsSync(codexConfigPath)) {
    try {
      const content = fs.readFileSync(codexConfigPath, "utf-8");
      for (const line of content.split("\n")) {
        // Stop at first [section] header — we only want top-level keys
        if (/^\s*\[/.test(line)) break;
        // Skip comment lines
        if (/^\s*#/.test(line)) continue;
        // Match: model = "value"
        const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
        if (m) return m[1];
      }
      // Config exists but has no top-level model — fall through to harness detection
      // Still identify as codex harness
      return "codex";
    } catch {
      // Read error — fall through
    }
  }

  // 4. Harness detection via environment signals
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "claude-code";

  // 5. Nothing detected — throw so callers can decide whether to exit or fall back
  throw new Error(
    "No model detected. Use --self-model <model> or set PI_AGENT_MODEL.\n" +
    "  Examples: pi-messenger-cli join --self-model gpt-5.3-codex\n" +
    "            PI_AGENT_MODEL=gemini-2.5-pro pi-messenger-cli join",
  );
}

// =============================================================================
// Session Persistence (Task 2)
// =============================================================================

const CLI_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function getCliSessionsDir(dirs: Dirs): string {
  return path.join(dirs.base, "cli-sessions");
}

function getCliSessionKey(cwd: string, model: string): string {
  return createHash("sha256").update(cwd + model).digest("hex");
}

/**
 * Read an existing CLI session for this CWD+model combination.
 * Returns null if not found or expired (TTL exceeded).
 * Exact key only — no fuzzy fallback (preserves harness isolation).
 */
function readCliSession(dirs: Dirs, cwd: string, model: string): CliSession | null {
  const sessionsDir = getCliSessionsDir(dirs);
  const key = getCliSessionKey(cwd, model);
  const sessionPath = path.join(sessionsDir, `${key}.json`);

  if (!fs.existsSync(sessionPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf-8")) as CliSession;
    // Validate required fields
    if (!data.name || !data.model || !data.cwd || !data.startedAt) return null;
    // Check TTL
    const age = Date.now() - new Date(data.startedAt).getTime();
    if (age > CLI_SESSION_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write a CLI session file atomically.
 */
function writeCliSession(dirs: Dirs, cwd: string, model: string, name: string): void {
  const sessionsDir = getCliSessionsDir(dirs);
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
  } catch {}

  const key = getCliSessionKey(cwd, model);
  const session: CliSession = { name, model, cwd, startedAt: new Date().toISOString() };
  const tmpPath = path.join(sessionsDir, `.${key}.tmp`);
  const finalPath = path.join(sessionsDir, `${key}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

// =============================================================================
// External Bootstrap (Task 3)
// =============================================================================

/**
 * External agent mode: Self-register with a stable name.
 *
 * Uses a session file (keyed by sha256(cwd+model)) to persist identity across
 * CLI invocations. Agents get the same name + model on every command within a
 * session (8h TTL), fixing the identity rotation problem for non-pi runtimes.
 *
 * Returns { name, model } so bootstrap() can propagate model to state.
 */
function bootstrapExternal(dirs: Dirs, cwd: string, modelFlag?: string): { name: string; model: string } {
  let resolvedModel: string;
  try {
    resolvedModel = detectModel(modelFlag);
  } catch (e) {
    process.stderr.write(`✗ ${(e as Error).message}\n`);
    process.exit(1);
  }

  // Check for existing session
  const existing = readCliSession(dirs, cwd, resolvedModel);
  // Always use generateMemorableName() for new sessions — do NOT fall back to PI_AGENT_NAME.
  // PI_AGENT_NAME leaks from parent environments and would defeat harness isolation: two
  // different models in the same CWD would inherit the same name from the env var.
  const name = existing ? existing.name : generateMemorableName();

  // Write session if new
  if (!existing) {
    writeCliSession(dirs, cwd, resolvedModel, name);
  }

  const regDir = dirs.registry;
  try {
    fs.mkdirSync(regDir, { recursive: true });
  } catch {}

  const registration = {
    name,
    pid: process.pid,
    sessionId: `cli-${process.pid}`,
    cwd,
    model: resolvedModel,
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

  return { name, model: resolvedModel };
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
        if (key === "self-model") {
          // Normalize --self-model to args.selfModel for camelCase access
          args["selfModel"] = next;
          i += 2;
        } else if (key === "paths") {
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

/**
 * Commands that must NOT re-register in the mesh — prevents PID clobber
 * of long-running processes (e.g., spawn). These commands may still
 * read or write state (e.g., receive deletes inbox files).
 */
const NO_REGISTER_COMMANDS = new Set([
  "list", "status", "feed", "task.list", "task.show", "help", "version",
  "leave",
  "receive",
]);

function bootstrap(cwd: string, options?: { register?: boolean; selfModel?: string }): { state: MessengerState; dirs: Dirs } {
  const dirs = getMessengerDirs();
  const isCrewSpawned = process.env.PI_CREW_WORKER === "1";
  const shouldRegister = options?.register !== false;

  let name: string;
  let resolvedModel: string | undefined;

  if (isCrewSpawned) {
    const crewName = bootstrapCrewSpawned(dirs);
    if (!crewName) {
      process.stderr.write("✗ Crew-spawned worker: registration not found after retries.\n");
      process.exit(1);
    }
    name = crewName;
    // pi-native crew workers get model from their own registration — no override needed
  } else if (shouldRegister) {
    // Registering path: bootstrapExternal handles model detection + session persistence
    const result = bootstrapExternal(dirs, cwd, options?.selfModel);
    name = result.name;
    resolvedModel = result.model;
  } else {
    // Read-only path: check session file for identity, fall back to env/anonymous
    let sessionModel: string | undefined;
    try {
      const detectedModel = detectModel(options?.selfModel);
      const session = readCliSession(dirs, cwd, detectedModel);
      if (session) {
        name = session.name;
        sessionModel = session.model;
      } else {
        name = process.env.PI_AGENT_NAME || "anonymous";
      }
    } catch {
      // detectModel may throw (error exit) — for read-only commands, fall back gracefully
      name = process.env.PI_AGENT_NAME || "anonymous";
    }
    resolvedModel = sessionModel;
  }

  const state = createMinimalState(name, cwd);
  // Propagate resolved model to state — overrides the env-based default in createMinimalState
  if (resolvedModel !== undefined) {
    state.model = resolvedModel;
  }
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

  const { state, dirs } = bootstrap(cwd, {
    register: !NO_REGISTER_COMMANDS.has(cmd.action),
    selfModel: cmd.args.selfModel as string | undefined,
  });

  // Validate nonce for mutating commands on crew-spawned workers
  if (MUTATING_COMMANDS.has(cmd.action) && process.env.PI_CREW_WORKER === "1") {
    try {
      validateNonce(dirs, state.agentName);
    } catch (e) {
      process.stderr.write(`✗ ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
  }

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
      printResult(await handlers.executeSend(state, dirs, cwd, to, false, message));
      break;
    }

    case "reserve": {
      const paths = cmd.args.paths as string[] | undefined;
      if (!paths || paths.length === 0) {
        process.stderr.write("✗ Usage: pi-messenger-cli reserve --paths <path1> [path2...]\n");
        process.exitCode = 1;
        return;
      }
      const minimalCtx = { cwd, hasUI: false };
      printResult(handlers.executeReserve(state, dirs, minimalCtx, paths, cmd.args.reason as string));
      break;
    }

    case "release": {
      const paths = cmd.args.paths as string[] | undefined;
      const minimalCtx = { cwd, hasUI: false };
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
      printResult(taskHandlers.execute("start", { id }, state, { cwd, hasUI: false }));
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
      printResult(taskHandlers.execute("done", { id, summary }, state, { cwd, hasUI: false }));
      break;
    }

    case "task.list": {
      const taskHandlers = await import("../crew/handlers/task.js");
      printResult(taskHandlers.execute("list", {}, state, { cwd, hasUI: false }));
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
      printResult(taskHandlers.execute("show", { id }, state, { cwd, hasUI: false }));
      break;
    }

    case "spawn": {
      const agent = cmd.args.agent as string;
      const prompt = cmd.args.prompt as string;
      if (!agent || !prompt) {
        process.stderr.write("✗ Usage: pi-messenger-cli spawn --agent <name> --prompt <text>\n");
        process.exitCode = 1;
        return;
      }
      await runSpawn(state, dirs, cwd, agent, prompt, cmd.args.model as string | undefined);
      break;
    }

    case "dismiss": {
      const name = cmd.args.name as string;
      if (!name) {
        process.stderr.write("✗ Usage: pi-messenger-cli dismiss --name <name>\n");
        process.exitCode = 1;
        return;
      }
      await runDismiss(state, dirs, cwd, name);
      break;
    }

    case "leave": {
      // leave is in NO_REGISTER_COMMANDS — bootstrap did NOT re-register.
      // We read the session file to find the identity, then clean up.
      let leftMesh = false;
      try {
        // Try to find the session file. If model detection fails (no --self-model,
        // no env, no config), fall back to scanning cli-sessions/ for any file
        // matching this CWD — so leave works even in environments where model
        // detection is unavailable (plan task §6: "catch error — leave should work
        // even without model detection").
        let session: CliSession | null = null;
        try {
          const leaveModel = detectModel(cmd.args.selfModel as string | undefined);
          session = readCliSession(dirs, cwd, leaveModel);
        } catch {
          // Model detection failed — scan all session files for one matching this CWD
          const sessionsDir = getCliSessionsDir(dirs);
          if (fs.existsSync(sessionsDir)) {
            for (const f of fs.readdirSync(sessionsDir)) {
              if (!f.endsWith(".json") || f.startsWith(".")) continue;
              try {
                const candidate = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8")) as CliSession;
                if (candidate.cwd === cwd) {
                  const age = Date.now() - new Date(candidate.startedAt).getTime();
                  if (age <= CLI_SESSION_TTL_MS) {
                    session = candidate;
                    break;
                  }
                }
              } catch { /* skip malformed file */ }
            }
          }
        }
        if (!session) {
          process.stdout.write("No active session found.\n");
          break;
        }
        const sessionName = session.name;

        // Ownership validation: if registry entry has an active PID that isn't us, don't touch it
        const regPath = path.join(dirs.registry, `${sessionName}.json`);
        let canCleanRegistry = true;
        if (fs.existsSync(regPath)) {
          try {
            const reg = JSON.parse(fs.readFileSync(regPath, "utf-8")) as { pid: number };
            if (reg.pid && reg.pid !== process.pid) {
              try {
                process.kill(reg.pid, 0); // probe — throws if dead
                // PID is alive and not us
                process.stdout.write(
                  `Session identity "${sessionName}" is in use by PID ${reg.pid} — clearing session file only.\n`,
                );
                canCleanRegistry = false;
              } catch {
                // PID is dead — safe to clean
              }
            }
          } catch {
            // Can't read registry — safe to proceed
          }
        }

        // Delete session file (always) — key by the session's actual model
        const sessionsDir = getCliSessionsDir(dirs);
        const key = getCliSessionKey(cwd, session.model);
        try { fs.unlinkSync(path.join(sessionsDir, `${key}.json`)); } catch {}

        if (canCleanRegistry) {
          // Delete registry entry
          try { fs.unlinkSync(regPath); } catch {}
          // Delete inbox directory
          const inboxDir = path.join(dirs.inbox, sessionName);
          try { fs.rmSync(inboxDir, { recursive: true, force: true }); } catch {}
        }

        leftMesh = true;
      } catch {
        // detectModel may throw if no model detected.
        // If we get here some other error occurred.
        process.stderr.write("✗ Failed to leave mesh cleanly. Session file may still exist.\n");
        process.exitCode = 1;
        break;
      }
      if (leftMesh) {
        process.stdout.write("✓ Left mesh. Session cleared.\n");
      }
      break;
    }

    default:
      process.stderr.write(`✗ Unknown command: ${cmd.action}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

// =============================================================================
// Spawn / Dismiss — collaborator lifecycle for non-pi runtimes
// =============================================================================

/** Directory for collaborator state files (PID, FIFO path, log file) */
function getCollabStateDir(): string {
  const dir = path.join(os.homedir(), ".pi", "agent", "messenger", "collaborators");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface CollabState {
  name: string;
  pid: number;
  fifoPath: string;
  logFile: string;
  agent: string;
  spawnedBy: string;
  startedAt: string;
}

function readCollabState(name: string): CollabState | null {
  const filePath = path.join(getCollabStateDir(), `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeCollabState(state: CollabState): void {
  const filePath = path.join(getCollabStateDir(), `${state.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function deleteCollabState(name: string): void {
  const filePath = path.join(getCollabStateDir(), `${name}.json`);
  try { fs.unlinkSync(filePath); } catch {}
}

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

async function runSpawn(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  agentName: string,
  prompt: string,
  modelOverride?: string,
): Promise<void> {
  // 1. Discover agent definition
  const agents = discoverCrewAgents(cwd);
  const agentConfig = agents.find(a => a.name === agentName);
  if (!agentConfig) {
    const available = agents.map(a => a.name).join(", ");
    process.stderr.write(`✗ Agent "${agentName}" not found. Available: ${available}\n`);
    process.exitCode = 1;
    return;
  }

  if (agentConfig.crewRole !== "collaborator") {
    process.stderr.write(`✗ Agent "${agentName}" has crewRole "${agentConfig.crewRole ?? "none"}", not "collaborator".\n`);
    process.exitCode = 1;
    return;
  }

  // 2. Resolve model
  const crewDir = path.join(cwd, ".pi", "messenger", "crew");
  const config = loadCrewConfig(crewDir);
  const resolved = resolveModel(
    undefined,
    modelOverride,
    config.models?.collaborator,
    config.defaultModel,
    agentConfig.model,
  );

  // 3. Generate unique name
  let collabName = generateMemorableName();
  for (let i = 0; i < 5; i++) {
    const regPath = path.join(dirs.registry, `${collabName}.json`);
    if (!fs.existsSync(regPath)) break;
    collabName = generateMemorableName();
  }

  // 4. Build pi args
  const args = ["--mode", "rpc", "--no-session"];

  if (resolved.model) {
    pushModelArgs(args, resolved.model);
  }

  const thinking = resolveThinking(
    config.thinking?.collaborator,
    agentConfig?.thinking,
  );
  if (thinking && !modelHasThinkingSuffix(resolved.model)) {
    args.push("--thinking", thinking);
  }

  if (agentConfig.tools?.length) {
    const builtinTools: string[] = [];
    const extensionPaths: string[] = [];
    for (const tool of agentConfig.tools) {
      if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
        extensionPaths.push(tool);
      } else if (BUILTIN_TOOLS.has(tool)) {
        builtinTools.push(tool);
      }
    }
    if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
    for (const ext of extensionPaths) args.push("--extension", ext);
  }

  // Load pi-messenger extension so collaborator can use pi_messenger
  const extensionDir = path.resolve(__dirname, "..");
  args.push("--extension", extensionDir);

  // System prompt
  let promptTmpDir: string | null = null;
  if (agentConfig.systemPrompt) {
    promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-cli-collab-"));
    const promptPath = path.join(promptTmpDir, `${agentName.replace(/[^\w.-]/g, "_")}.md`);
    fs.writeFileSync(promptPath, agentConfig.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", promptPath);
  }

  // 5. Create FIFO for stdin (keeps process alive between CLI invocations)
  const collabId = randomUUID().slice(0, 8);
  const tmpBase = promptTmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-cli-collab-"));
  if (!promptTmpDir) promptTmpDir = tmpBase;
  const fifoPath = path.join(tmpBase, "stdin.fifo");
  const logFile = path.join(tmpBase, "collab.log");

  try {
    execFileSync("mkfifo", [fifoPath]);
  } catch (err) {
    process.stderr.write(`✗ Failed to create FIFO: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // Open log file
  const logFd = fs.openSync(logFile, "w");

  // 6. Spawn pi process with FIFO as stdin
  const env = {
    ...process.env,
    PI_AGENT_NAME: collabName,
    PI_CREW_COLLABORATOR: "1",
  };

  // Open FIFO for reading in the child (non-blocking open for spawn)
  const fifoReadFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);

  const proc = spawnProcess("pi", args, {
    cwd,
    stdio: [fifoReadFd, logFd, logFd],
    env,
    detached: true,
  });

  // Close the fds in the parent — child owns them now
  fs.closeSync(fifoReadFd);
  fs.closeSync(logFd);

  if (!proc.pid) {
    process.stderr.write("✗ Failed to spawn pi process\n");
    process.exitCode = 1;
    return;
  }

  // Unref so CLI can exit while pi process continues
  proc.unref();

  // 7. Write initial prompt via FIFO
  const fullPrompt = `Reply to: ${state.agentName}\n\n${prompt}`;
  const rpcPrompt = JSON.stringify({ type: "prompt", message: fullPrompt });
  const fifoWriteFd = fs.openSync(fifoPath, fs.constants.O_WRONLY);
  fs.writeSync(fifoWriteFd, rpcPrompt + "\n");
  // Keep FIFO write end open — closing it sends EOF to the reader (kills pi)
  // We'll store the path and open it again for dismiss

  // 8. Save state file
  const collabState: CollabState = {
    name: collabName,
    pid: proc.pid,
    fifoPath,
    logFile,
    agent: agentName,
    spawnedBy: state.agentName,
    startedAt: new Date().toISOString(),
  };
  writeCollabState(collabState);

  // Pre-register in mesh registry
  store.registerSpawnedWorker(
    dirs.registry, cwd, collabName, proc.pid,
    resolved.model ?? "unknown", `cli-collab-${collabId}`,
  );

  logFeedEvent(cwd, state.agentName, "spawn", collabName, agentName);

  process.stderr.write(`Spawning collaborator ${collabName} (${agentName})...\n`);

  // 9. Poll own inbox for first message
  const inboxDir = path.join(dirs.inbox, state.agentName);
  const startTime = Date.now();
  const spawnTimeout = config.collaboration?.spawnPollTimeoutMs ?? 900_000;
  const stallThreshold = config.collaboration?.stallThresholdMs ?? 120_000;
  let lastLogSize = 0;
  let lastLogChangeTime = startTime;

  try {
    const stat = fs.statSync(logFile);
    lastLogSize = stat.size;
  } catch {}

  while (true) {
    // Check if process crashed
    try {
      process.kill(proc.pid, 0); // signal 0 = check alive
    } catch {
      process.stderr.write(`✗ Collaborator "${collabName}" crashed.\n`);
      const tail = readLogTailFromFile(logFile);
      if (tail) process.stderr.write(`Log tail:\n${tail}\n`);
      deleteCollabState(collabName);
      process.exitCode = 1;
      fs.closeSync(fifoWriteFd);
      return;
    }

    // Check inbox for message
    try {
      if (fs.existsSync(inboxDir)) {
        const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).sort();
        for (const file of files) {
          const filePath = path.join(inboxDir, file);
          try {
            const msg: AgentMailMessage = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            if (msg.from === collabName) {
              fs.unlinkSync(filePath);
              // Close FIFO write end — but NOT yet. The collaborator needs to stay alive
              // for subsequent send/dismiss. We close it in dismiss.
              fs.closeSync(fifoWriteFd);
              process.stdout.write(`✓ Collaborator "${collabName}" spawned (${agentName}). First message:\n\n${msg.text}\n`);
              return;
            }
          } catch {}
        }
      }
    } catch {}

    // Check log-based stall
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > lastLogSize) {
        lastLogSize = stat.size;
        lastLogChangeTime = Date.now();
      }
    } catch {}

    const now = Date.now();
    const stallDuration = now - lastLogChangeTime;
    if (stallDuration >= stallThreshold) {
      process.stderr.write(`✗ Collaborator "${collabName}" stalled (${Math.round(stallDuration / 1000)}s no log growth).\n`);
      fs.closeSync(fifoWriteFd);
      process.exitCode = 1;
      return;
    }

    // Absolute timeout
    if (now - startTime >= spawnTimeout) {
      process.stderr.write(`✗ Collaborator "${collabName}" timed out (${Math.round((now - startTime) / 1000)}s).\n`);
      fs.closeSync(fifoWriteFd);
      process.exitCode = 1;
      return;
    }

    // Progress
    if ((now - startTime) % 30000 < 100) {
      const elapsed = Math.round((now - startTime) / 1000);
      process.stderr.write(`  Waiting for ${collabName}... ${elapsed}s elapsed\n`);
    }

    await sleep(100);
  }
}

function readLogTailFromFile(logFile: string): string {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return "";
    const tailSize = Math.min(stat.size, 2048);
    const buf = Buffer.alloc(tailSize);
    const fd = fs.openSync(logFile, "r");
    fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    fs.closeSync(fd);
    return buf.toString("utf-8").trim();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDismiss(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  name: string,
): Promise<void> {
  const collabState = readCollabState(name);
  if (!collabState) {
    process.stderr.write(`✗ No active collaborator named "${name}".\n`);
    process.exitCode = 1;
    return;
  }

  // Kill the process
  try {
    process.kill(collabState.pid, "SIGTERM");
  } catch {
    // Already dead
  }

  // Clean up FIFO
  try { fs.unlinkSync(collabState.fifoPath); } catch {}

  // Clean up state file
  deleteCollabState(name);

  // Clean up registry
  const regPath = path.join(dirs.registry, `${name}.json`);
  try { fs.unlinkSync(regPath); } catch {}

  logFeedEvent(cwd, state.agentName, "dismiss", name);
  process.stdout.write(`✓ Collaborator "${name}" dismissed.\n`);
}

function printHelp(): void {
  process.stdout.write(`pi-messenger-cli — Mesh access for non-pi runtimes

Commands:
  join [--self-model <model>]        Register on the mesh
  leave                              Leave mesh and clear session
  status                             Show your status
  list                               List active agents
  send --to <name> --message <text>  Send a message
  reserve --paths <path...>          Reserve files
  release [--paths <path...>]        Release reservations
  feed [--limit <n>]                 Show activity feed
  task.list                          List all tasks
  task.show <id>                     Show task details
  task.start <id>                    Claim and start a task
  task.done <id> --summary <text>    Complete a task
  spawn --agent <name> --prompt <text>   Spawn a collaborator (blocks for first message)
  dismiss --name <name>              Dismiss a collaborator

Flags:
  --self-model <model>  Set your model identity (e.g., 'gpt-5.3-codex').
                        Auto-detected for Codex from ~/.codex/config.toml.
                        Distinct from --model on spawn (which sets collaborator model).

Environment:
  PI_AGENT_NAME     Agent name (auto-generated if not set)
  PI_AGENT_MODEL    Model identifier for registration (auto-detected if not set;
                    Codex reads from ~/.codex/config.toml, others from API key env vars)
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
