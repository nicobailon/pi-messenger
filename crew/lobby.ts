/**
 * Crew - Lobby Workers
 *
 * Spawns idle workers that join the mesh, explore the project, and chat
 * while waiting for task assignments. When tasks become available, they
 * receive assignments via steer message and transition to work mode.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateMemorableName } from "../lib.js";
import { resolveThinking, modelHasThinkingSuffix } from "./agents.js";
import { discoverCrewAgents } from "./utils/discover.js";
import { loadCrewConfig, type CrewConfig } from "./utils/config.js";
import {
  createProgress,
  parseJsonlLine,
  updateProgress,
} from "./utils/progress.js";
import { updateLiveWorker, removeLiveWorker } from "./live-progress.js";
import * as store from "./store.js";
import { logFeedEvent } from "../feed.js";
import {
  registerWorker,
  unregisterWorker,
  getLobbyWorkers as registryGetLobbyWorkers,
  getAvailableLobbyWorkers as registryGetAvailableLobbyWorkers,
  getLobbyWorkerCount as registryGetLobbyWorkerCount,
  type LobbyWorkerEntry,
} from "./registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export const LOBBY_TOKEN_BUDGETS: Record<string, number> = {
  none: 10_000,
  minimal: 20_000,
  moderate: 50_000,
  chatty: 100_000,
};

export type LobbyWorker = LobbyWorkerEntry;

function lobbyTaskId(id: string): string {
  return `__lobby-${id}__`;
}

export function spawnLobbyWorker(cwd: string, promptOverride?: string): LobbyWorker | null {
  const agents = discoverCrewAgents(cwd);
  const workerConfig = agents.find(a => a.name === "crew-worker");
  if (!workerConfig) return null;

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  const id = randomUUID().slice(0, 6);
  let name = generateMemorableName();
  for (let i = 0; i < 5; i++) {
    const existing = registryGetLobbyWorkers(cwd);
    const collision = existing.some(w => w.name === name && w.proc.exitCode === null);
    if (!collision) break;
    name = generateMemorableName();
  }
  const prompt = promptOverride ?? buildLobbyPrompt(cwd, config);

  const args = ["--mode", "json", "--no-session", "-p"];
  const model = config.models?.worker ?? workerConfig.model;
  if (model) args.push("--model", model);

  const thinking = resolveThinking(
    config.thinking?.worker,
    workerConfig.thinking,
  );
  if (thinking && !modelHasThinkingSuffix(model)) {
    args.push("--thinking", thinking);
  }

  if (workerConfig.tools?.length) {
    const builtinTools: string[] = [];
    const extensionPaths: string[] = [];
    for (const tool of workerConfig.tools) {
      if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
        extensionPaths.push(tool);
      } else if (BUILTIN_TOOLS.has(tool)) {
        builtinTools.push(tool);
      }
    }
    if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
    for (const ext of extensionPaths) args.push("--extension", ext);
  }

  args.push("--extension", EXTENSION_DIR);

  let promptTmpDir: string | null = null;
  if (workerConfig.systemPrompt) {
    promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-lobby-"));
    const promptPath = path.join(promptTmpDir, "crew-worker.md");
    fs.writeFileSync(promptPath, workerConfig.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", promptPath);
  }

  args.push(prompt);

  const envOverrides = config.work.env ?? {};
  const env = { ...process.env, ...envOverrides, PI_AGENT_NAME: name, PI_CREW_WORKER: "1", PI_LOBBY_ID: id };

  const proc = spawn("pi", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const aliveFile = path.join(crewDir, `lobby-${id}.alive`);
  try { fs.writeFileSync(aliveFile, "", { mode: 0o600 }); } catch {}

  const taskId = lobbyTaskId(id);
  const worker: LobbyWorkerEntry = {
    type: "lobby",
    lobbyId: id,
    name,
    cwd,
    proc,
    taskId,
    startedAt: Date.now(),
    assignedTaskId: null,
    coordination: config.coordination ?? "chatty",
    promptTmpDir,
    aliveFile,
  };

  registerWorker(worker);

  const progress = createProgress("crew-worker");

  let jsonlBuffer = "";
  proc.stdout?.on("data", (data) => {
    try {
      jsonlBuffer += data.toString();
      const lines = jsonlBuffer.split("\n");
      jsonlBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseJsonlLine(line);
        if (event) {
          updateProgress(progress, event, worker.startedAt);
          const displayId = worker.assignedTaskId ?? taskId;
          updateLiveWorker(cwd, displayId, {
            taskId: displayId,
            agent: "crew-worker",
            name,
            progress: { ...progress, recentTools: progress.recentTools.map(t => ({ ...t })) },
            startedAt: worker.startedAt,
          });
          if (!worker.assignedTaskId) {
            const currentConfig = loadCrewConfig(crewDir);
            const budget = LOBBY_TOKEN_BUDGETS[currentConfig.coordination ?? "chatty"] ?? LOBBY_TOKEN_BUDGETS.chatty;
            if (progress.tokens > budget) {
              proc.kill("SIGTERM");
            }
          }
        }
      }
    } catch {}
  });

  proc.on("close", (exitCode) => {
    const displayId = worker.assignedTaskId ?? taskId;
    removeLiveWorker(cwd, displayId);
    unregisterWorker(cwd, taskId);
    if (worker.promptTmpDir) {
      try { fs.rmSync(worker.promptTmpDir, { recursive: true, force: true }); } catch {}
    }
    if (worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
    if (worker.assignedTaskId) {
      const task = store.getTask(cwd, worker.assignedTaskId);
      if (task && task.status === "in_progress" && task.assigned_to === worker.name) {
        const config = loadCrewConfig(store.getCrewDir(cwd));
        if (task.attempt_count >= config.work.maxAttemptsPerTask) {
          store.updateTask(cwd, worker.assignedTaskId, {
            status: "blocked",
            blocked_reason: `Max attempts (${config.work.maxAttemptsPerTask}) reached`,
            assigned_to: undefined,
          });
          logFeedEvent(cwd, worker.name, "task.block", worker.assignedTaskId, `Max attempts reached`);
        } else {
          store.updateTask(cwd, worker.assignedTaskId, { status: "todo", assigned_to: undefined });
          store.appendTaskProgress(cwd, worker.assignedTaskId, "system",
            `Lobby worker ${worker.name} exited (code ${exitCode ?? "unknown"}), reset to todo`);
          logFeedEvent(cwd, worker.name, "task.reset", worker.assignedTaskId, "worker exited");
        }
      }
    } else {
      logFeedEvent(cwd, worker.name, "leave", undefined, `Lobby worker exited (code ${exitCode ?? "unknown"})`);
    }
  });

  updateLiveWorker(cwd, taskId, {
    taskId,
    agent: "crew-worker",
    name,
    progress: { ...progress, recentTools: [] },
    startedAt: worker.startedAt,
  });

  return worker;
}

export function getLobbyWorkerCount(cwd: string): number {
  return registryGetLobbyWorkerCount(cwd);
}

export function getAvailableLobbyWorkers(cwd: string): LobbyWorker[] {
  return registryGetAvailableLobbyWorkers(cwd);
}

export function assignTaskToLobbyWorker(
  worker: LobbyWorker,
  taskId: string,
  taskPrompt: string,
  inboxDir: string,
): boolean {
  if (worker.assignedTaskId) return false;
  if (worker.proc.exitCode !== null) return false;

  const targetInbox = path.join(inboxDir, worker.name);
  try { fs.mkdirSync(targetInbox, { recursive: true }); } catch {}

  const msg = {
    id: randomUUID(),
    from: "crew-orchestrator",
    to: worker.name,
    text: `# ⚡ TASK ASSIGNMENT — SWITCH TO WORK MODE

Drop your current activity and start working on this task immediately.

**IMPORTANT:** This task is already claimed and started for you — do NOT call \`task.start\`. Jump straight to reading the task spec, reserving files, implementing, testing, committing, and marking complete with \`task.done\`.

${taskPrompt}`,
    timestamp: new Date().toISOString(),
    replyTo: null,
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = path.join(targetInbox, `${Date.now()}-${random}.json`);
  const aliveFile = worker.aliveFile;
  if (aliveFile) {
    try { fs.unlinkSync(aliveFile); } catch {}
  }
  try {
    fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));
  } catch {
    if (aliveFile) {
      try { fs.writeFileSync(aliveFile, "", { mode: 0o600 }); } catch {}
    }
    return false;
  }

  removeLiveWorker(worker.cwd, lobbyTaskId(worker.lobbyId));
  worker.assignedTaskId = taskId;
  return true;
}

export function killLobbyWorkerForTask(cwd: string, taskId: string): boolean {
  const all = registryGetLobbyWorkers(cwd);
  for (const worker of all) {
    if (worker.assignedTaskId !== taskId) continue;
    if (worker.proc.exitCode === null) {
      worker.proc.kill("SIGTERM");
    }
    if (worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
    return true;
  }
  return false;
}

export function shutdownLobbyWorkers(cwd: string): void {
  const all = registryGetLobbyWorkers(cwd);
  for (const worker of all) {
    if (worker.proc.exitCode === null) {
      worker.proc.kill("SIGTERM");
    }
    const displayId = worker.assignedTaskId ?? worker.taskId;
    removeLiveWorker(cwd, displayId);
    unregisterWorker(cwd, worker.taskId);
    if (worker.promptTmpDir) {
      try { fs.rmSync(worker.promptTmpDir, { recursive: true, force: true }); } catch {}
    }
    if (worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
  }

  const crewDir = store.getCrewDir(cwd);
  try {
    for (const f of fs.readdirSync(crewDir)) {
      if (f.startsWith("lobby-") && f.endsWith(".alive")) {
        try { fs.unlinkSync(path.join(crewDir, f)); } catch {}
      }
    }
  } catch {}
}

export function cleanupUnassignedAliveFiles(cwd: string): void {
  const workers = registryGetLobbyWorkers(cwd);
  for (const worker of workers) {
    if (!worker.assignedTaskId && worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
  }
}

export function spawnWorkerForTask(
  cwd: string,
  taskId: string,
  taskPrompt: string,
): LobbyWorker | null {
  const task = store.getTask(cwd, taskId);
  if (!task || task.status !== "todo") return null;

  const worker = spawnLobbyWorker(cwd, taskPrompt);
  if (!worker) return null;

  removeLiveWorker(cwd, lobbyTaskId(worker.lobbyId));
  worker.assignedTaskId = taskId;
  if (worker.aliveFile) {
    try { fs.unlinkSync(worker.aliveFile); } catch {}
  }
  store.updateTask(cwd, taskId, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    base_commit: store.getBaseCommit(cwd),
    assigned_to: worker.name,
    attempt_count: task.attempt_count + 1,
  });
  store.appendTaskProgress(cwd, taskId, "system", `Assigned to worker ${worker.name} (attempt ${task.attempt_count + 1})`);
  logFeedEvent(cwd, worker.name, "task.start", taskId, task.title);

  return worker;
}

export function removeLobbyWorkerByIndex(cwd: string): boolean {
  const available = registryGetAvailableLobbyWorkers(cwd);
  if (available.length === 0) return false;
  const worker = available[0];
  if (worker.proc.exitCode === null) {
    worker.proc.kill("SIGTERM");
  }
  removeLiveWorker(cwd, worker.taskId);
  unregisterWorker(cwd, worker.taskId);
  if (worker.promptTmpDir) {
    try { fs.rmSync(worker.promptTmpDir, { recursive: true, force: true }); } catch {}
  }
  if (worker.aliveFile) {
    try { fs.unlinkSync(worker.aliveFile); } catch {}
  }
  return true;
}

function buildLobbyPrompt(cwd: string, config: CrewConfig): string {
  const plan = store.getPlan(cwd);
  const prdPath = plan?.prd;
  const level = config.coordination ?? "chatty";

  let prompt = `# Crew Lobby

You're a crew worker waiting for the team's plan to be finalized. There's no task for you yet — hang tight.

## Step 1: Join the Mesh

\`\`\`typescript
pi_messenger({ action: "join" })
\`\`\`

## Step 2: Get Familiar

`;

  if (level === "none") {
    prompt += `Skip this step — you'll get full context when your task arrives.

`;
  } else if (prdPath) {
    prompt += `Read the PRD to understand what the team is building:

\`\`\`typescript
read("${prdPath}")
\`\`\`

`;
  }

  if (level === "chatty" || level === "moderate") {
    prompt += `Briefly explore the project structure to get oriented. Don't go deep — save your budget for the actual task.

`;
  }

  if (level === "chatty") {
    prompt += `## Step 3: Share Your Findings

Post updates to the team feed while you wait — the user watches it live. Other workers will see your broadcasts when they receive their task assignment.

- **Introduce yourself** — broadcast a greeting when you join
- **Share observations** — broadcast anything interesting you notice about the PRD
- **Respond to DMs** — if someone messages you directly, reply briefly

**Hard limit: send at most 5 messages total (broadcasts + DMs combined).** After that, stop messaging and wait quietly. Save your context for the actual task.

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Hey team! Just joined. Reading the PRD now..." })
\`\`\`

After sending your messages, wait for a **TASK ASSIGNMENT** message.
`;
  } else if (level === "moderate") {
    prompt += `## Step 3: Brief Check-in

Announce yourself, then wait:

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Joined the lobby. Reading the PRD..." })
\`\`\`

**Hard limit: send at most 2 messages total.** You may reply once if someone DMs you. Then stop messaging and wait.

Wait for a **TASK ASSIGNMENT** message to begin work.
`;
  } else if (level === "minimal") {
    prompt += `## Step 3: Wait for Assignment

Announce your presence with one broadcast, then wait:

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Standing by for task assignment." })
\`\`\`

**Do NOT send any other messages.** Wait for a **TASK ASSIGNMENT** message to begin work.
`;
  } else {
    prompt += `## Step 3: Wait

**Do NOT send any messages, do NOT explore the codebase.** Wait for a **TASK ASSIGNMENT** message.
`;
  }

  prompt += `
## When You Receive a Task Assignment

You will receive a message with the header **⚡ TASK ASSIGNMENT**. When you get it:

1. Read the task details carefully — the assignment message has specific instructions
2. Reserve files you'll modify
3. Implement the feature following the spec
4. Run tests to verify
5. Commit your changes
6. Release reservations and mark complete

The task will already be claimed and started for you — do NOT call \`task.start\`. Switch to full work mode immediately — no more lobby chat.
`;

  return prompt;
}
