/**
 * Crew - Collaboration Handlers
 *
 * spawn/dismiss actions for agent-to-agent collaboration.
 * Wraps existing Crew subprocess machinery to let a running agent
 * programmatically spawn a collaborator, exchange messages, and dismiss it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { generateMemorableName } from "../../lib.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { loadCrewConfig } from "../utils/config.js";
import { pushModelArgs, resolveThinking, modelHasThinkingSuffix, SHUTDOWN_MESSAGE } from "../agents.js";
import {
  registerWorker,
  unregisterWorker,
  findCollaboratorByName,
  getCollaboratorsBySpawner,
  type CollaboratorEntry,
} from "../registry.js";
import { logFeedEvent } from "../../feed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "../..");
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 30_000;
const SIGKILL_DELAY_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// spawn
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSpawn(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
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

  // Security gate: only collaborator-role agents can be spawned via this action
  if (agentConfig.crewRole !== "collaborator") {
    return result(
      `Error: Agent "${agentName}" has crewRole "${agentConfig.crewRole ?? "none"}", not "collaborator". ` +
      `Only agents with crewRole: collaborator can be spawned via this action.`,
      { mode: "spawn", error: "not_collaborator_role", agent: agentName, crewRole: agentConfig.crewRole },
    );
  }

  // Generate a unique name
  const collabName = generateMemorableName();
  const collabId = randomUUID().slice(0, 8);

  // Build args
  const args = ["--mode", "json", "--no-session", "-p"];

  const model = params.model
    ?? config.models?.collaborator
    ?? agentConfig.model;
  if (model) pushModelArgs(args, model);

  const thinking = resolveThinking(
    config.thinking?.collaborator,
    agentConfig.thinking,
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

  // The user-facing prompt (the task description with context)
  args.push(prompt);

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

  // Spawn the process
  const proc = spawn("pi", args, {
    cwd,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    env,
  });

  if (logFd !== undefined) {
    try { fs.closeSync(logFd); } catch {}
  }

  // Register in worker registry
  const taskId = `__collab-${collabId}__`;
  const entry: CollaboratorEntry = {
    type: "collaborator",
    name: collabName,
    cwd,
    proc,
    taskId,
    spawnedBy: process.pid,
    startedAt: Date.now(),
    promptTmpDir,
    logFile,
  };
  registerWorker(entry);

  logFeedEvent(cwd, state.agentName, "spawn", collabName, agentName);

  // Poll until collaborator appears in registry (mesh-ready)
  const registryPath = path.join(dirs.registry, `${collabName}.json`);
  const ready = await pollUntilReady(registryPath, proc, POLL_TIMEOUT_MS);

  if (!ready) {
    // Collaborator failed to join mesh in time — clean up
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

  return result(
    `Collaborator "${collabName}" spawned and on the mesh. Agent: ${agentName}.\n\n` +
    `Send messages with: pi_messenger({ action: "send", to: "${collabName}", message: "..." })\n` +
    `Dismiss when done: pi_messenger({ action: "dismiss", name: "${collabName}" })`,
    { mode: "spawn", name: collabName, pid: proc.pid, agent: agentName },
  );
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
  await gracefulDismiss(entry, dirs);
  logFeedEvent(cwd, "crew", "dismiss", name);

  return result(
    `Collaborator "${name}" dismissed.`,
    { mode: "dismiss", dismissed: name },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared graceful shutdown — used by both dismiss and orphan cleanup
// ─────────────────────────────────────────────────────────────────────────────

export async function gracefulDismiss(
  entry: CollaboratorEntry,
  dirs: Dirs,
): Promise<void> {
  // Already exited?
  if (entry.proc.exitCode !== null) {
    unregisterWorker(entry.cwd, entry.taskId);
    cleanupTmpDir(entry.promptTmpDir);
    return;
  }

  // Send SHUTDOWN_MESSAGE to inbox
  const inboxDir = path.join(dirs.inbox, entry.name);
  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    const msg = {
      id: randomUUID(),
      from: "crew-orchestrator",
      to: entry.name,
      text: SHUTDOWN_MESSAGE,
      timestamp: new Date().toISOString(),
      replyTo: null,
    };
    const random = Math.random().toString(36).substring(2, 8);
    const msgFile = path.join(inboxDir, `${Date.now()}-${random}.json`);
    fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));
  } catch {
    // If inbox write fails, fall through to SIGTERM
  }

  // Wait for graceful exit
  const gracePeriodMs = 10_000; // Shorter than default worker grace — collaborators are lighter
  const exited = await pollUntilExited(entry.proc, gracePeriodMs);

  if (!exited) {
    // SIGTERM
    try { entry.proc.kill("SIGTERM"); } catch {}
    const killed = await pollUntilExited(entry.proc, SIGKILL_DELAY_MS);
    if (!killed) {
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
  }

  unregisterWorker(entry.cwd, entry.taskId);
  cleanupTmpDir(entry.promptTmpDir);
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

  await Promise.all(collaborators.map(entry => gracefulDismiss(entry, dirs)));
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
      // Process died?
      if (proc.exitCode !== null) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      // Registered?
      if (fs.existsSync(registryPath)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      // Timeout?
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
