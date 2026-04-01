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
import { generateMemorableName, isValidAgentName } from "../lib.js";
import type { MessengerState, Dirs, AgentMailMessage } from "../lib.js";
import { discoverCrewAgents } from "../crew/utils/discover.js";
import { loadCrewConfig } from "../crew/utils/config.js";
import { resolveModel } from "../crew/utils/model.js";
import { pushModelArgs, resolveThinking, modelHasThinkingSuffix } from "../crew/agents.js";
import { isStalled } from "../crew/utils/stall.js";
import { isFreshSpawnMessage } from "../crew/handlers/collab.js";

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
// CWD Fallback Session Lookup
// =============================================================================

/**
 * Find a CLI session by CWD alone (ignoring model in key).
 * Used as fallback when exact sha256(cwd+model) lookup misses and
 * --self-model was NOT explicitly provided.
 *
 * Returns: null (0 matches), CliSession (exactly 1 match),
 * throws Error (2+ matches — ambiguous, user must specify --self-model).
 */
function findSessionByCwd(dirs: Dirs, cwd: string): CliSession | null {
  const sessionsDir = getCliSessionsDir(dirs);
  if (!fs.existsSync(sessionsDir)) return null;

  const matches: CliSession[] = [];
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    try {
      const candidate = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, f), "utf-8"),
      ) as CliSession;
      // Same field validation as readCliSession (line ~231)
      if (!candidate.name || !candidate.model || !candidate.cwd || !candidate.startedAt) continue;
      if (candidate.cwd === cwd) {
        const age = Date.now() - new Date(candidate.startedAt).getTime();
        if (age <= CLI_SESSION_TTL_MS) {
          matches.push(candidate);
        }
      }
    } catch { /* skip malformed */ }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  throw new Error(
    "Multiple sessions found for this CWD. Use --self-model to specify which session.",
  );
}

// =============================================================================
// External Bootstrap
// =============================================================================

/**
 * External agent mode: Self-register with a stable name.
 *
 * Uses a session file (keyed by sha256(cwd+model)) to persist identity across
 * CLI invocations. Agents get the same name + model on every command within a
 * session (8h TTL), fixing the identity rotation problem for non-pi runtimes.
 *
 * Session lookup chain:
 * 1. detectModel() in try/catch
 * 2. Exact key: readCliSession(dirs, cwd, model)
 * 3. CWD fallback: findSessionByCwd(dirs, cwd) — ONLY when --self-model was NOT explicit
 *
 * Session creation is join-only. Non-join commands error if no session found.
 * CWD fallback overrides resolvedModel with session.model for identity stability.
 *
 * Returns { name, model } so bootstrap() can propagate model to state.
 */
function bootstrapExternal(dirs: Dirs, cwd: string, modelFlag?: string, action?: string): { name: string; model: string } {
  const explicitModel = !!modelFlag;
  let resolvedModel: string | undefined;
  let session: CliSession | null = null;

  try {
    resolvedModel = detectModel(modelFlag);
    session = readCliSession(dirs, cwd, resolvedModel);
    if (!session && !explicitModel) {
      // CWD fallback ONLY when model was auto-detected (not explicit --self-model)
      const cwdSession = findSessionByCwd(dirs, cwd); // may throw on 2+
      if (cwdSession) {
        session = cwdSession;
        resolvedModel = cwdSession.model; // identity stability: use session's model
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("Multiple sessions")) {
      // Ambiguity error from findSessionByCwd — rethrow for caller to handle
      throw e;
    }
    // detectModel() threw — try CWD fallback (no explicit model available)
    try {
      const cwdSession = findSessionByCwd(dirs, cwd);
      if (cwdSession) {
        session = cwdSession;
        resolvedModel = cwdSession.model;
      }
    } catch (e2) {
      if (e2 instanceof Error && e2.message.includes("Multiple sessions")) throw e2;
      // Both detectModel and CWD scan failed — fall through to error handling below
    }
  }

  let name: string;

  if (session) {
    // Reuse existing session identity
    name = session.name;
  } else if (action === "join" && resolvedModel) {
    // Only join creates new sessions
    name = generateMemorableName();
    writeCliSession(dirs, cwd, resolvedModel, name);
  } else if (action === "join") {
    // join but no model detected and no existing session
    process.stderr.write("✗ No model detected. Use --self-model <model> to join.\n");
    process.exit(1);
  } else {
    // Non-join command with no session found
    process.stderr.write("✗ No active session. Run: pi-messenger-cli join --self-model <model>\n");
    process.exit(1);
  }

  // Write/update registration
  const regDir = dirs.registry;
  try {
    fs.mkdirSync(regDir, { recursive: true });
  } catch {}

  const registration = {
    name,
    pid: process.pid,
    sessionId: `cli-${process.pid}`,
    cwd,
    model: resolvedModel!,
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };

  const tmpPath = path.join(regDir, `.${name}.tmp`);
  const finalPath = path.join(regDir, `${name}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(registration, null, 2));
  fs.renameSync(tmpPath, finalPath);

  return { name, model: resolvedModel! };
}

// =============================================================================
// Inbox Reader (shared by receive and send --wait)
// =============================================================================

interface InboxMessage {
  msg: AgentMailMessage;
  filePath: string;
}

function isValidInboxMessage(obj: unknown): obj is AgentMailMessage {
  return typeof obj === "object" && obj !== null
    && typeof (obj as any).from === "string"
    && typeof (obj as any).text === "string"
    && typeof (obj as any).timestamp === "string";
}

/**
 * Read all valid messages from an inbox directory.
 * Returns parsed messages and filenames of malformed files (for caller to warn).
 * Shape-validates required fields (from, text, timestamp) — parseable JSON
 * without these fields is treated as malformed.
 */
function readInboxMessages(inboxDir: string): { messages: InboxMessage[]; malformed: string[] } {
  if (!fs.existsSync(inboxDir)) return { messages: [], malformed: [] };
  const files = fs.readdirSync(inboxDir)
    .filter(f => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  const messages: InboxMessage[] = [];
  const malformed: string[] = [];
  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isValidInboxMessage(parsed)) throw new Error("missing required fields");
      messages.push({ msg: parsed, filePath });
    } catch {
      malformed.push(file);
    }
  }
  return { messages, malformed };
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

function bootstrap(cwd: string, options?: { register?: boolean; selfModel?: string; action?: string }): { state: MessengerState; dirs: Dirs } {
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
    const result = bootstrapExternal(dirs, cwd, options?.selfModel, options?.action);
    name = result.name;
    resolvedModel = result.model;
  } else {
    // Read-only path: same three-step chain with CWD fallback
    const explicitModel = !!options?.selfModel;
    let sessionModel: string | undefined;
    try {
      const detectedModel = detectModel(options?.selfModel);
      const session = readCliSession(dirs, cwd, detectedModel);
      if (session) {
        name = session.name;
        sessionModel = session.model;
      } else if (!explicitModel) {
        // CWD fallback (only when --self-model was NOT explicit)
        try {
          const cwdSession = findSessionByCwd(dirs, cwd);
          if (cwdSession) {
            name = cwdSession.name;
            sessionModel = cwdSession.model;
          } else {
            name = "anonymous";
          }
        } catch (e) {
          // Ambiguity error — surface it for read-only commands too
          if (e instanceof Error && e.message.includes("Multiple sessions")) {
            process.stderr.write(`✗ ${e.message}\n`);
            process.exitCode = 1;
            name = "anonymous";
          } else {
            name = "anonymous";
          }
        }
      } else {
        name = "anonymous";
      }
    } catch {
      // detectModel threw — CWD fallback
      try {
        const cwdSession = findSessionByCwd(dirs, cwd);
        if (cwdSession) {
          name = cwdSession.name;
          sessionModel = cwdSession.model;
        } else {
          name = "anonymous";
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("Multiple sessions")) {
          process.stderr.write(`✗ ${e.message}\n`);
          process.exitCode = 1;
        }
        name = "anonymous";
      }
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
    action: cmd.action,
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
      process.stdout.write(`✓ Joined mesh as ${state.agentName}\nTo check for messages: pi-messenger-cli receive\n`);
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
      const wait = cmd.args.wait === true;
      const rawTimeout = cmd.args.timeout ? parseInt(cmd.args.timeout as string, 10) : undefined;
      if (rawTimeout !== undefined && (isNaN(rawTimeout) || rawTimeout <= 0)) {
        process.stderr.write("✗ Invalid --timeout value. Must be a positive integer (seconds).\n");
        process.exitCode = 1;
        return;
      }
      const timeoutSec = rawTimeout ?? 300;

      if (!to || !message) {
        process.stderr.write("✗ Usage: pi-messenger-cli send --to <name> --message <text> [--wait] [--timeout <seconds>] [--phase <phase>]\n");
        process.exitCode = 1;
        return;
      }

      // B1: Block send --wait to known collaborators. Collaborators exit after their first
      // turn (FIFO EOF). send --wait will always time out on a dead process.
      // Guard is --wait only: non-wait sends are fire-and-forget and don't block.
      // isValidAgentName enforced inside readCollabState (defense in depth per B0).
      if (wait) {
        const collabCheck = readCollabState(to);
        if (collabCheck) {
          process.stderr.write(
            `✗ "${to}" is a known collaborator (spawned ${new Date(collabCheck.startedAt).toLocaleString()}).\n` +
            `  Collaborators exit after their first turn — send --wait will always time out.\n` +
            `  Use spawn-per-turn: dismiss "${to}", fix your code, then spawn fresh with accumulated context.\n` +
            `  See: docs/agent-collaboration.md § CLI Agents (Mode 3)\n`
          );
          process.exitCode = 1;
          break;
        }
      }

      const phase = cmd.args.phase as string | undefined;
      const sendResult = await handlers.executeSend(state, dirs, cwd, to, false, message, undefined, phase);
      // replyTo (pos 7) not exposed via CLI yet — explicit undefined prevents positional confusion
      printResult(sendResult);

      const sendDetails = sendResult.details as Record<string, unknown>;
      // Double-wait guard: skip CLI poll when executeSend already returned a
      // collaborator reply (handlers.ts:373-463 blocks and returns reply inline)
      if (!wait || sendDetails.error || sendDetails.reply || sendDetails.conversationComplete) break;

      // Non-collaborator send: poll inbox for reply from recipient
      const sendInboxDir = path.join(dirs.inbox, state.agentName);
      const deadline = Date.now() + (timeoutSec * 1000);
      const failedFiles = new Set<string>();
      process.stderr.write(`Waiting for reply from ${to}... (timeout: ${timeoutSec}s)\n`);

      while (Date.now() < deadline) {
        const { messages: waitMessages, malformed: waitMalformed } = readInboxMessages(sendInboxDir);
        for (const mf of waitMalformed) {
          if (!failedFiles.has(mf)) {
            failedFiles.add(mf);
            process.stderr.write(`⚠ Skipping malformed inbox file: ${mf}\n`);
          }
        }
        for (const { msg: waitMsg, filePath: waitFilePath } of waitMessages) {
          if (waitMsg.from === to) {
            try { fs.unlinkSync(waitFilePath); } catch {} // race-safe
            process.stdout.write(`\n✓ Reply from ${to}:\n\n${waitMsg.text}\n`);
            return;
          }
        }
        await sleep(100);
      }

      process.stderr.write(
        `✗ No reply from ${to} within ${timeoutSec}s.\n` +
        `  If "${to}" was a collaborator, it may have exited after its first turn.\n` +
        `  Dismiss it and re-spawn with accumulated context (see: docs/agent-collaboration.md § CLI Agents).\n` +
        `  Otherwise, check for delayed replies with: pi-messenger-cli receive\n`
      );
      process.exitCode = 1;
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

    case "receive": {
      if (state.agentName === "anonymous") {
        process.stdout.write("No active session. Run: pi-messenger-cli join --self-model <model>\n");
        break;
      }
      const recvInboxDir = path.join(dirs.inbox, state.agentName);
      const { messages: recvMessages, malformed: recvMalformed } = readInboxMessages(recvInboxDir);

      for (const mf of recvMalformed) {
        process.stderr.write(`⚠ Skipping malformed message: ${mf}\n`);
      }

      if (recvMessages.length === 0 && recvMalformed.length === 0) {
        process.stdout.write("No new messages.\n");
        break;
      }

      let recvCount = 0;
      for (const { msg, filePath } of recvMessages) {
        process.stdout.write(`[${msg.from} ${msg.timestamp}] ${msg.text}\n`);
        try { fs.unlinkSync(filePath); } catch {} // race-safe
        recvCount++;
      }

      if (recvCount > 0) {
        process.stdout.write(`\n${recvCount} message${recvCount === 1 ? "" : "s"} received.\n`);
      }
      break;
    }

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
      // Same three-step chain as bootstrapExternal + read-only bootstrap:
      // exact key → CWD fallback (only if no --self-model) → "no session"
      const explicitLeaveModel = !!cmd.args.selfModel;
      let leaveSession: CliSession | null = null;
      try {
        try {
          const leaveModel = detectModel(cmd.args.selfModel as string | undefined);
          leaveSession = readCliSession(dirs, cwd, leaveModel);
          if (!leaveSession && !explicitLeaveModel) {
            leaveSession = findSessionByCwd(dirs, cwd); // may throw on 2+
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("Multiple sessions")) {
            process.stderr.write(`✗ ${e.message}\n`);
            process.exitCode = 1;
            break;
          }
          // detectModel threw — CWD fallback
          try {
            leaveSession = findSessionByCwd(dirs, cwd);
          } catch (e2) {
            if (e2 instanceof Error && e2.message.includes("Multiple sessions")) {
              process.stderr.write(`✗ ${(e2 as Error).message}\n`);
              process.exitCode = 1;
              break;
            }
          }
        }
        if (!leaveSession) {
          process.stdout.write("No active session found.\n");
          break;
        }
        const sessionName = leaveSession.name;

        // Ownership validation: if registry entry has an active PID that isn't us, don't touch it
        const regPath = path.join(dirs.registry, `${sessionName}.json`);
        let canCleanRegistry = true;
        if (fs.existsSync(regPath)) {
          try {
            const reg = JSON.parse(fs.readFileSync(regPath, "utf-8")) as { pid: number };
            if (reg.pid && reg.pid !== process.pid) {
              try {
                process.kill(reg.pid, 0); // probe — throws if dead
                process.stdout.write(
                  `Session identity "${sessionName}" is in use by PID ${reg.pid} — clearing session file only.\n`,
                );
                canCleanRegistry = false;
              } catch {
                // PID is dead — safe to clean
              }
            }
          } catch { /* Can't read registry — safe to proceed */ }
        }

        // Delete session file (always) — key by the session's actual model
        const sessionsDir = getCliSessionsDir(dirs);
        const key = getCliSessionKey(cwd, leaveSession.model);
        try { fs.unlinkSync(path.join(sessionsDir, `${key}.json`)); } catch {}

        if (canCleanRegistry) {
          try { fs.unlinkSync(regPath); } catch {}
          const inboxDir = path.join(dirs.inbox, sessionName);
          try { fs.rmSync(inboxDir, { recursive: true, force: true }); } catch {}
        }

        process.stdout.write("✓ Left mesh. Session cleared.\n");
      } catch {
        process.stderr.write("✗ Failed to leave mesh cleanly. Session file may still exist.\n");
        process.exitCode = 1;
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
  if (!isValidAgentName(name)) return null;   // prevents path traversal on raw CLI input
  const filePath = path.join(getCollabStateDir(), `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeCollabState(state: CollabState): void {
  if (!isValidAgentName(state.name)) return;  // prevents path traversal
  const filePath = path.join(getCollabStateDir(), `${state.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function deleteCollabState(name: string): void {
  if (!isValidAgentName(name)) return;        // prevents path traversal
  const filePath = path.join(getCollabStateDir(), `${name}.json`);
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Exported cleanup helper for collaborator state (spec 009, R2a/R2b/R2c).
 * Exported to allow unit testing of the cleanup sequence without a live process.
 * Called by cleanupCollaborator() inside runSpawn.
 */
export async function cleanupCollaboratorState(opts: {
  pid: number;
  killFirst: boolean;
  fifoPath: string;
  collabName: string;
  heartbeatFile: string;
  registryDir: string;
  fifoWriteFd: number;
}): Promise<void> {
  const { pid, killFirst, fifoPath, collabName, heartbeatFile, registryDir, fifoWriteFd } = opts;
  if (killFirst) {
    // SIGTERM → 5s grace → SIGKILL (R2a/R2b)
    try { process.kill(pid, "SIGTERM"); } catch {}
    await sleep(5000);
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
  }
  // Full state cleanup
  try { fs.unlinkSync(fifoPath); } catch {}                                      // FIFO
  deleteCollabState(collabName);                                                  // collab state JSON
  try { fs.unlinkSync(heartbeatFile); } catch {}                                  // heartbeat file
  const regPath = path.join(registryDir, `${collabName}.json`);
  try { fs.unlinkSync(regPath); } catch {}                                        // registry entry
  try { fs.closeSync(fifoWriteFd); } catch {}                                     // FIFO write fd
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

  const spawnStartTime = Date.now(); // spec 057: stale-message guard — capture BEFORE spawn

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

  // T5a: Setup for dual-signal stall detection (spec 009, R4/R5.1)
  const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThreshold / 8));
  const gracePeriodMs = heartbeatIntervalMs * 2;
  const hardCeilingMs = 3600_000; // R5.1: spawn hard ceiling
  const heartbeatFile = path.join(dirs.registry, `${collabName}.heartbeat`);

  // T5b: Cleanup helper — delegates to exported cleanupCollaboratorState (spec 009, R2a/R2b/R2c)
  // Using the exported function ensures unit tests cover the production code path.
  async function cleanupCollaborator(killFirst: boolean): Promise<void> {
    await cleanupCollaboratorState({
      pid: proc.pid,
      killFirst,
      fifoPath,
      collabName,
      heartbeatFile,
      registryDir: dirs.registry,
      fifoWriteFd,
    });
  }

  // Sweep provably-stale inbox files for this collaborator name — spec 057 (timestamp-safe, same predicate as Tier 4)
  if (fs.existsSync(inboxDir)) {
    for (const f of fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"))) {
      try {
        const m: AgentMailMessage = JSON.parse(
          fs.readFileSync(path.join(inboxDir, f), "utf-8")
        );
        if (m.from === collabName && !isFreshSpawnMessage(m, spawnStartTime)) {
          fs.unlinkSync(path.join(inboxDir, f));
        }
      } catch {}
    }
  }

  while (true) {
    // T5d: Check if process crashed (R2c — full cleanup, expanded from original)
    try {
      process.kill(proc.pid, 0); // signal 0 = check alive
    } catch {
      process.stderr.write(`✗ Collaborator "${collabName}" crashed.\n`);
      const tail = readLogTailFromFile(logFile);
      if (tail) process.stderr.write(`Log tail:\n${tail}\n`);
      await cleanupCollaborator(false); // process already dead — no kill needed
      process.exitCode = 1;
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
            // spec 057: reject stale messages — delegates to shared predicate (tested in collab-blocking.test.ts)
            if (msg.from === collabName && isFreshSpawnMessage(msg, spawnStartTime)) {
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

    const now = Date.now();

    // T5c: Three-tier stall detection (spec 009, AD2/R5.1)
    // Tier 1: liveness via isStalled() — replaces log-size heuristic
    const stallResult = isStalled({
      heartbeatFile,
      logFile,
      stallThresholdMs: stallThreshold,
      gracePeriodMs,
      spawnedAt: startTime,
    });
    if (stallResult.stalled) {
      process.stderr.write(
        `✗ Collaborator "${collabName}" stalled (${Math.round(stallResult.stalledMs / 1000)}s, ${stallResult.type}).\n`,
      );
      await cleanupCollaborator(true); // R2a: kill + full cleanup
      process.exitCode = 1;
      return;
    }

    // Tier 2/3: ceiling — heartbeat freshness selects which ceiling applies
    // Active heartbeat → hard ceiling (D5 suppressed per R5.1)
    // No heartbeat → spawnTimeout (old D5 behavior, backward compat)
    const ceiling = stallResult.heartbeatActive ? hardCeilingMs : spawnTimeout;
    if (now - startTime >= ceiling) {
      process.stderr.write(
        `✗ Collaborator "${collabName}" timed out (${Math.round((now - startTime) / 1000)}s, ceiling ${Math.round(ceiling / 1000)}s).\n`,
      );
      await cleanupCollaborator(true); // R2b: kill + full cleanup
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
    [--wait] [--timeout <seconds>] [--phase <phase>]   Block for reply (default 300s)
  receive                            Check for new messages
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
  --wait                Block after send until recipient replies.
  --timeout <seconds>   Timeout for --wait (default: 300).
  --phase <phase>       Phase marker forwarded to recipient (review|challenge|revise|approved|complete).

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
