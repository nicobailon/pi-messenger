/**
 * Crew - Collaboration Handlers
 *
 * spawn/dismiss actions for agent-to-agent collaboration.
 * Uses RPC mode (stdin/stdout JSON protocol) to keep collaborator
 * subprocesses alive between message exchanges. No keepalive needed —
 * the open stdin pipe keeps the process alive. Messages are delivered
 * via the extension's FSWatcher + pi.sendMessage(triggerTurn) path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs, AgentMailMessage } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { generateMemorableName } from "../../lib.js";
import { recordMessageInHistory, validateTargetAgent } from "../../store.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { loadCrewConfig, type CrewConfig } from "../utils/config.js";
import { pushModelArgs, resolveThinking, modelHasThinkingSuffix } from "../agents.js";
import { resolveModel } from "../utils/model.js";
import {
  registerWorker,
  unregisterWorker,
  findCollaboratorByName,
  getCollaboratorsBySpawner,
  type CollaboratorEntry,
} from "../registry.js";
import { logFeedEvent } from "../../feed.js";
import { isStalled, type LivenessType } from "../utils/stall.js";

/** Stall type for PollResult — includes poll-loop ceiling hits ("timeout") in addition
 *  to the liveness types emitted by isStalled(). */
export type PollStallType = LivenessType | "timeout";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "../..");
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 30_000;
const STDIN_CLOSE_GRACE_MS = 15_000;
const SIGKILL_DELAY_MS = 5_000;

const PROGRESS_INTERVAL_MS = 30_000;              // 30 seconds

/** Default stall threshold: 2 minutes of zero log growth before declaring stalled. */
export const DEFAULT_STALL_THRESHOLD_MS = 120_000;
/** Minimum allowed stall threshold — prevents instant-stall from bad config. */
export const MIN_STALL_THRESHOLD_MS = 1_000;
/** Default absolute poll timeout: 5 minutes wall-clock from poll start. Never resets. */
export const DEFAULT_POLL_TIMEOUT_MS = 300_000;
/** Default absolute poll timeout for spawn: 15 minutes. Spawn boot sequences
 *  (system prompt loading, file reads, thinking) legitimately take 5-10 min. */
export const DEFAULT_SPAWN_POLL_TIMEOUT_MS = 900_000;

// ─────────────────────────────────────────────────────────────────────────────
// Spawn poll timeout resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the poll timeout for spawn context from crew config.
 * Reads `collaboration.spawnPollTimeoutMs` with validation, falling back to
 * DEFAULT_SPAWN_POLL_TIMEOUT_MS (900s). Exported for testing.
 */
export function resolveSpawnPollTimeout(config: CrewConfig): number {
  const raw = config.collaboration?.spawnPollTimeoutMs;
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(MIN_STALL_THRESHOLD_MS, raw)
    : DEFAULT_SPAWN_POLL_TIMEOUT_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking poll for collaborator messages
// ─────────────────────────────────────────────────────────────────────────────

export interface PollOptions {
  inboxDir: string;
  collabName: string;
  correlationId?: string;
  sendTimestamp?: number;
  entry: CollaboratorEntry;
  signal?: AbortSignal;
  onUpdate?: (update: string) => void;
  /** Stall threshold: both heartbeat and log must exceed this for a stall (spec 009, R1). */
  stallThresholdMs?: number;
  /** D5 fallback ceiling: fires when no heartbeat active (old absolute timeout, backward compat). */
  pollTimeoutMs?: number;
  /** Heartbeat file for dual-signal stall detection. Falls back to entry.heartbeatFile. */
  heartbeatFile?: string;
  /** Hard ceiling — fires regardless of heartbeat freshness. spawn=3600s, send=max(D5×3,900s). */
  hardCeilingMs?: number;
  state: MessengerState;
}

export type PollResult =
  | { ok: true; message: AgentMailMessage; peerComplete?: boolean }
  | { ok: false; error: "crashed" | "cancelled" | "stalled"; exitCode?: number; logTail?: string; stallDurationMs?: number; stallType?: PollStallType };

/**
 * Returns true if a spawn-path message should be accepted as a valid first response.
 * A message is fresh if its timestamp is >= spawnStartTime (cannot be from a prior session).
 * Exported for unit-testing and shared use by cli/index.ts (spec 057).
 */
export function isFreshSpawnMessage(msg: AgentMailMessage, spawnStartTime: number): boolean {
  const msgTime = Date.parse(msg.timestamp);
  return !isNaN(msgTime) && msgTime >= spawnStartTime;
}

/**
 * Sweep provably-stale inbox files for a collaborator name from a spawner's inbox.
 * Only deletes files where isFreshSpawnMessage returns false (timestamp < spawnStartTime).
 * Safe to call before poll — the new collaborator's reply cannot have timestamp < spawnStartTime.
 * Exported for unit-testing (spec 057).
 */
export function sweepStaleSpawnMessages(
  inboxDir: string,
  collabName: string,
  spawnStartTime: number,
): void {
  if (!fs.existsSync(inboxDir)) return;
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

/**
 * Poll the spawner's inbox for a message from a specific collaborator.
 * Used by both executeSpawn (first message) and executeSend (reply).
 *
 * Tiered message matching:
 * 1. msg.replyTo === correlationId → match (strongest)
 * 2. msg.replyTo is null AND from matches AND timestamp >= sendTimestamp → match (fallback)
 * 3. msg.replyTo is non-null AND !== correlationId → reject (different thread)
 * 4. spawn path (no correlationId) → from matches + timestamp guard (spec 057)
 */
export function pollForCollaboratorMessage(opts: PollOptions): Promise<PollResult> {
  const {
    inboxDir, collabName, correlationId, sendTimestamp,
    entry, signal, onUpdate, state,
  } = opts;
  const resolvedStallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const resolvedPollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  // A4: Setup for dual-signal stall detection (spec 009)
  const heartbeatFile = opts.heartbeatFile ?? entry.heartbeatFile;
  const heartbeatIntervalMs = Math.max(1000, Math.min(10000, resolvedStallThresholdMs / 8));
  const gracePeriodMs = heartbeatIntervalMs * 2;
  const spawnedAt = entry.startedAt;
  const hardCeilingMs = opts.hardCeilingMs ?? 3600_000;

  return new Promise<PollResult>((resolve) => {
    const startTime = Date.now();
    // Progress reporting accumulators (size-based) — separate from stall detection
    let progressLastLogSize = 0;
    let lastProgressTime = startTime;

    // Initialize progress size tracking
    if (entry.logFile) {
      try {
        const stat = fs.statSync(entry.logFile);
        progressLastLogSize = stat.size;
      } catch {
        // Log file may not exist yet
      }
    }

    function checkMessage(filePath: string): AgentMailMessage | null {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const msg: AgentMailMessage = JSON.parse(content);
        if (msg.from !== collabName) return null;

        if (correlationId) {
          // Tier 1: exact replyTo match
          if (msg.replyTo === correlationId) return msg;
          // Tier 3: replyTo exists but doesn't match → reject (different thread)
          if (msg.replyTo !== null && msg.replyTo !== undefined) return null;
          // Tier 2: replyTo is null, check timestamp fallback
          if (sendTimestamp !== undefined) {
            const msgTime = Date.parse(msg.timestamp);
            if (!isNaN(msgTime) && msgTime >= sendTimestamp) return msg;
          }
          return null;
        }

        // Tier 4: spawn path — no correlationId, match on from + timestamp guard (spec 057)
        if (sendTimestamp !== undefined && !isFreshSpawnMessage(msg, sendTimestamp)) {
          return null;
        }
        return msg;
      } catch {
        return null;
      }
    }

    function readLogTail(): string {
      if (!entry.logFile) return "";
      try {
        const stat = fs.statSync(entry.logFile);
        const size = stat.size;
        if (size === 0) return "";
        const tailSize = Math.min(size, 2048);
        const buf = Buffer.alloc(tailSize);
        const fd = fs.openSync(entry.logFile, "r");
        fs.readSync(fd, buf, 0, tailSize, size - tailSize);
        fs.closeSync(fd);
        return buf.toString("utf-8").trim();
      } catch {
        return "";
      }
    }

    function emitProgress(): void {
      if (!onUpdate) return;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (!entry.logFile) {
        onUpdate(`Waiting for ${collabName}... ${elapsed}s elapsed (no log available)`);
        return;
      }
      let logDelta = 0;
      try {
        const stat = fs.statSync(entry.logFile);
        logDelta = stat.size - progressLastLogSize;
        progressLastLogSize = stat.size;
      } catch {
        // Ignore
      }
      const evidence = logDelta > 0 ? ` (+${logDelta} bytes logged)` : "";
      onUpdate(`Waiting for ${collabName}... ${elapsed}s elapsed${evidence}`);
    }

    const timer = setInterval(() => {
      // Check cancellation
      if (signal?.aborted) {
        clearInterval(timer);
        resolve({ ok: false, error: "cancelled" });
        return;
      }

      // Check crash
      if (entry.proc.exitCode !== null) {
        clearInterval(timer);
        const logTail = readLogTail();
        resolve({
          ok: false,
          error: "crashed",
          exitCode: entry.proc.exitCode,
          logTail: logTail || undefined,
        });
        return;
      }

      // Check inbox BEFORE stall — a message at the stall boundary is a success
      try {
        if (fs.existsSync(inboxDir)) {
          const files = fs.readdirSync(inboxDir)
            .filter(f => f.endsWith(".json"))
            .sort();

          for (const file of files) {
            const filePath = path.join(inboxDir, file);
            const msg = checkMessage(filePath);
            if (msg) {
              clearInterval(timer);
              try { fs.unlinkSync(filePath); } catch {}
              recordMessageInHistory(state, msg);
              const peerComplete = msg.phase === "complete";
              if (peerComplete) {
                entry.peerTerminal = true;
              }
              resolve({ ok: true, message: msg, peerComplete: peerComplete || undefined });
              return;
            }
          }
        }
      } catch {
        // Inbox read error — try again next tick
      }

      const now = Date.now();

      // A4: Three-tier stall detection (spec 009, AD2)
      // Tier 1: liveness via isStalled() — replaces log-size check + log-drip heuristic
      const stallResult = isStalled({
        heartbeatFile,
        logFile: entry.logFile,
        stallThresholdMs: resolvedStallThresholdMs,
        gracePeriodMs,
        spawnedAt,
      });
      if (stallResult.stalled) {
        clearInterval(timer);
        const logTail = readLogTail();
        resolve({
          ok: false,
          error: "stalled",
          logTail: logTail || undefined,
          stallDurationMs: stallResult.stalledMs,
          stallType: stallResult.type,
        });
        return;
      }

      // Tier 2/3: ceiling — heartbeat freshness selects which ceiling applies
      // Active heartbeat → hard ceiling (D5 suppressed per R5)
      // No heartbeat → resolvedPollTimeoutMs (old D5 behavior, backward compat)
      const ceiling = stallResult.heartbeatActive ? hardCeilingMs : resolvedPollTimeoutMs;
      if (now - startTime >= ceiling) {
        clearInterval(timer);
        const logTail = readLogTail();
        resolve({
          ok: false,
          error: "stalled",
          logTail: logTail || undefined,
          stallDurationMs: now - startTime,
          stallType: "timeout",
        });
        return;
      }

      // Emit progress at 30s intervals
      if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
        lastProgressTime = now;
        emitProgress();
      }
    }, POLL_INTERVAL_MS);

    // Also listen for abort signal to break immediately
    if (signal) {
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        resolve({ ok: false, error: "cancelled" });
      }, { once: true });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSpawn(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: (update: string) => void,
) {
  const agentName = params.agent ?? params.name;
  const prompt = params.prompt;

  if (!agentName) {
    return result(
      "Error: `agent` is required for spawn (e.g., 'crew-challenger').",
      { mode: "spawn", error: "missing_agent" },
    );
  }
  if (!prompt) {
    return result(
      "Error: `prompt` is required for spawn — the collaborator needs to know what to do.",
      { mode: "spawn", error: "missing_prompt" },
    );
  }

  const cwd = ctx.cwd ?? process.cwd();
  const crewDir = path.join(cwd, ".pi", "messenger", "crew");
  const config = loadCrewConfig(crewDir);

  // Discover agent definition
  const agents = discoverCrewAgents(cwd);
  const agentConfig = agents.find(a => a.name === agentName);
  if (!agentConfig) {
    const available = agents.map(a => a.name).join(", ");
    return result(
      `Error: Agent "${agentName}" not found. Available: ${available}`,
      { mode: "spawn", error: "agent_not_found", available: agents.map(a => a.name) },
    );
  }

  // Security gate: only collaborator-role agents can be spawned
  if (agentConfig.crewRole !== "collaborator") {
    return result(
      `Error: Agent "${agentName}" has crewRole "${agentConfig.crewRole ?? "none"}", not "collaborator". ` +
      `Only agents with crewRole: collaborator can be spawned via this action.`,
      { mode: "spawn", error: "not_collaborator_role", agent: agentName, crewRole: agentConfig.crewRole },
    );
  }

  // Generate unique name with collision avoidance against BOTH
  // in-memory collaborators AND live mesh agents (registry files)
  let collabName = generateMemorableName();
  for (let i = 0; i < 5; i++) {
    const existingCollab = findCollaboratorByName(collabName);
    const meshValidation = validateTargetAgent(collabName, dirs);
    // Retry if name collides with a live collaborator OR any live mesh agent
    if ((!existingCollab || existingCollab.proc.exitCode !== null) && !meshValidation.valid) break;
    collabName = generateMemorableName();
  }
  // Clear any stale terminal state for this name
  state.completedCollaborators.delete(collabName);

  const collabId = randomUUID().slice(0, 8);

  // Build args — RPC mode, no -p flag (prompt goes via stdin)
  const args = ["--mode", "rpc", "--no-session"];

  const resolved = resolveModel(
    undefined,
    params.model,
    config.models?.collaborator,
    config.defaultModel,
    agentConfig.model,
  );
  const model = resolved.model;
  if (model) {
    pushModelArgs(args, model);
    logFeedEvent(cwd, collabName, "model.resolved", model, `source: ${resolved.source}`);
  }

  const thinking = resolveThinking(
    config.thinking?.collaborator,
    agentConfig?.thinking,
  );
  if (thinking && !modelHasThinkingSuffix(model)) {
    args.push("--thinking", thinking);
  }

  // Tool restrictions from agent frontmatter
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

  // Load pi-messenger extension so collaborator can use pi_messenger tool
  args.push("--extension", EXTENSION_DIR);

  // System prompt from agent .md
  let promptTmpDir: string | null = null;
  if (agentConfig.systemPrompt) {
    promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-collab-"));
    const promptPath = path.join(promptTmpDir, `${agentName.replace(/[^\w.-]/g, "_")}.md`);
    fs.writeFileSync(promptPath, agentConfig.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", promptPath);
  }

  // Env setup
  const envOverrides = config.work.env ?? {};
  const env = {
    ...process.env,
    ...envOverrides,
    PI_AGENT_NAME: collabName,
    PI_CREW_COLLABORATOR: "1",
  };

  // Stdout/stderr → temp log file
  let logFile: string | null = null;
  let logFd: number | undefined;
  try {
    const logDir = promptTmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-collab-"));
    if (!promptTmpDir) promptTmpDir = logDir;
    logFile = path.join(logDir, "collab.log");
    logFd = fs.openSync(logFile, "w");
  } catch {
    // Fall back to /dev/null if log file creation fails
  }

  const spawnStartTime = Date.now();  // capture BEFORE spawn — correct lower bound (spec 057)

  // Spawn: stdin is PIPE (keeps process alive), stdout/stderr to log
  const proc = spawn("pi", args, {
    cwd,
    stdio: ["pipe", logFd ?? "ignore", logFd ?? "ignore"],
    env,
  });

  if (logFd !== undefined) {
    try { fs.closeSync(logFd); } catch {}
  }

  // Send initial prompt via RPC protocol on stdin
  // Prepend spawner name so the collaborator knows who to reply to
  const fullPrompt = `Reply to: ${state.agentName}\n\n${prompt}`;
  const rpcPrompt = JSON.stringify({ type: "prompt", message: fullPrompt });
  proc.stdin!.write(rpcPrompt + "\n");
  // Do NOT close stdin — the open pipe keeps the process alive

  // Register in worker registry
  const taskId = `__collab-${collabId}__`;
  const entry: CollaboratorEntry = {
    type: "collaborator",
    name: collabName,
    cwd,
    proc,
    taskId,
    spawnedBy: process.pid,
    startedAt: spawnStartTime,
    promptTmpDir,
    logFile,
    // A4c: heartbeat file path — convention-based, same dir as registry JSON (spec 009)
    heartbeatFile: path.join(dirs.registry, `${collabName}.heartbeat`),
  };
  registerWorker(entry);

  logFeedEvent(cwd, state.agentName, "spawn", collabName, agentName);

  // Add to blocking filter BEFORE mesh polling (closes race window)
  state.blockingCollaborators.add(collabName);

  // Sweep provably-stale inbox files before poll (spec 057)
  sweepStaleSpawnMessages(path.join(dirs.inbox, state.agentName), collabName, spawnStartTime);

  try {
    // Poll until collaborator appears in registry (mesh-ready)
    const registryPath = path.join(dirs.registry, `${collabName}.json`);
    const ready = await pollUntilReady(registryPath, proc, POLL_TIMEOUT_MS);

    if (!ready) {
      // Collaborator failed to join mesh — clean up
      try { proc.stdin!.end(); } catch {}
      if (proc.exitCode === null) proc.kill("SIGTERM");
      unregisterWorker(cwd, taskId);
      cleanupTmpDir(promptTmpDir);

      const exitCode = proc.exitCode;
      const hint = exitCode !== null
        ? ` (process exited with code ${exitCode})`
        : " (timed out after 30s)";

      return result(
        `Error: Collaborator "${collabName}" failed to join the mesh${hint}. Check if pi is available and the agent definition is valid.`,
        { mode: "spawn", error: "mesh_timeout", name: collabName },
      );
    }

    // Block for the collaborator's first message
    const rawStall = config.collaboration?.stallThresholdMs;
    const stallThresholdMs = typeof rawStall === "number" && Number.isFinite(rawStall)
      ? Math.max(MIN_STALL_THRESHOLD_MS, rawStall)
      : DEFAULT_STALL_THRESHOLD_MS;
    const pollTimeoutMs = resolveSpawnPollTimeout(config);

    const pollResult = await pollForCollaboratorMessage({
      inboxDir: path.join(dirs.inbox, state.agentName),
      collabName,
      sendTimestamp: spawnStartTime,   // rejects stale messages from prior sessions (spec 057)
      // No correlationId — first message has no prior ID to correlate with
      entry,
      signal,
      onUpdate,
      stallThresholdMs,
      pollTimeoutMs,                    // D5 fallback ceiling (used when no heartbeat)
      heartbeatFile: entry.heartbeatFile, // A4c: dual-signal stall detection (spec 009)
      hardCeilingMs: 3600_000,            // R5.1: spawn hard ceiling
      state,
    });

    if (!pollResult.ok) {
      // Extract error details — TypeScript may lose narrowing after await
      const errResult = pollResult as { ok: false; error: string; exitCode?: number; logTail?: string; stallDurationMs?: number };
      const { error, exitCode, logTail, stallDurationMs } = errResult;

      if (error === "crashed") {
        await gracefulDismiss(entry);
        return result(
          `Error: Collaborator "${collabName}" crashed (exit code ${exitCode ?? "unknown"}).` +
          (logTail ? `\n\nLog tail:\n${logTail}` : ""),
          { mode: "spawn", error: "collaborator_crashed", name: collabName, exitCode, logTail },
        );
      }
      if (error === "cancelled") {
        await gracefulDismiss(entry);
        return result(
          `Spawn cancelled — collaborator "${collabName}" dismissed.`,
          { mode: "spawn", error: "cancelled", name: collabName },
        );
      }
      // stalled — do NOT dismiss, collaborator may resume
      return result(
        `Error: Collaborator "${collabName}" appears stalled — no output for ${Math.round((stallDurationMs ?? 0) / 1000)}s. ` +
        `The collaborator is still running. Retry, dismiss and re-spawn, or ask the user for guidance. ` +
        `Do NOT proceed without a collaborator — tell the user about the failure.`,
        { mode: "spawn", error: "stalled", name: collabName, stallDurationMs },
      );
    }

    // Success — first message received
    if (pollResult.ok && pollResult.peerComplete) {
      // One-shot collaborator — auto-dismiss
      state.completedCollaborators.add(collabName);
      unregisterWorker(cwd, taskId);
      gracefulDismiss(entry).catch(() => {});
      logFeedEvent(cwd, "crew", "dismiss", collabName);

      return result(
        `Collaborator "${collabName}" spawned (${agentName}). First message:\n\n` +
        `${pollResult.message.text}\n\nConversation complete — collaborator dismissed.`,
        { mode: "spawn", name: collabName, agent: agentName,
          firstMessage: pollResult.message.text, conversationComplete: true, dismissed: collabName },
      );
    }

    // Normal (non-terminal) spawn
    return result(
      `Collaborator "${collabName}" spawned (${agentName}). First message:\n\n` +
      `${pollResult.message.text}\n\n` +
      `Send messages: pi_messenger({ action: "send", to: "${collabName}", message: "..." })\n` +
      `Dismiss when done: pi_messenger({ action: "dismiss", name: "${collabName}" })`,
      { mode: "spawn", name: collabName, pid: proc.pid, agent: agentName, firstMessage: pollResult.message.text },
    );
  } finally {
    state.blockingCollaborators.delete(collabName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// dismiss
// ─────────────────────────────────────────────────────────────────────────────

export async function executeDismiss(
  params: CrewParams,
  _state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const name = params.name;
  if (!name) {
    return result(
      "Error: `name` is required for dismiss.",
      { mode: "dismiss", error: "missing_name" },
    );
  }

  const entry = findCollaboratorByName(name);
  if (!entry) {
    return result(
      `Error: No active collaborator named "${name}". Check pi_messenger({ action: "list" }) for active agents.`,
      { mode: "dismiss", error: "not_found", name },
    );
  }

  const cwd = ctx.cwd ?? process.cwd();
  await gracefulDismiss(entry);
  logFeedEvent(cwd, "crew", "dismiss", name);

  return result(
    `Collaborator "${name}" dismissed.`,
    { mode: "dismiss", dismissed: name },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — close stdin, process exits naturally
// ─────────────────────────────────────────────────────────────────────────────

export async function gracefulDismiss(
  entry: CollaboratorEntry,
): Promise<void> {
  // A5: Helper to unlink heartbeat file — called from BOTH branches (spec 009, AD4/R2e)
  // Crash path takes the early-return branch; without this the file would be orphaned.
  const unlinkHeartbeat = () => {
    if (entry.heartbeatFile) {
      try { fs.unlinkSync(entry.heartbeatFile); } catch {}
    }
  };

  // Already exited? (crash path)
  if (entry.proc.exitCode !== null) {
    unregisterWorker(entry.cwd, entry.taskId);
    cleanupTmpDir(entry.promptTmpDir);
    unlinkHeartbeat(); // ← ADDED: early-return branch (crash path)
    return;
  }

  // Close stdin — pi sees EOF and exits cleanly
  try { entry.proc.stdin!.end(); } catch {}

  // Wait for clean exit
  const exited = await pollUntilExited(entry.proc, STDIN_CLOSE_GRACE_MS);

  if (!exited) {
    // SIGTERM fallback
    try { entry.proc.kill("SIGTERM"); } catch {}
    const killed = await pollUntilExited(entry.proc, SIGKILL_DELAY_MS);
    if (!killed) {
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
  }

  unregisterWorker(entry.cwd, entry.taskId);
  cleanupTmpDir(entry.promptTmpDir);
  unlinkHeartbeat(); // ← normal exit path
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan cleanup — called from session_shutdown
// ─────────────────────────────────────────────────────────────────────────────

export async function shutdownCollaborators(
  spawnerPid: number,
  dirs: Dirs,
): Promise<void> {
  const collaborators = getCollaboratorsBySpawner(spawnerPid);
  if (collaborators.length === 0) return;

  await Promise.all(collaborators.map(entry => gracefulDismiss(entry)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pollUntilReady(
  registryPath: string,
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    const startTime = Date.now();
    const timer = setInterval(() => {
      if (proc.exitCode !== null) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      if (fs.existsSync(registryPath)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startTime >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
        return;
      }
    }, POLL_INTERVAL_MS);
  });
}

function pollUntilExited(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    if (proc.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function cleanupTmpDir(dir: string | null): void {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
