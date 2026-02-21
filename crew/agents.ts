/**
 * Crew - Agent Spawning
 * 
 * Spawns pi processes with progress tracking, truncation, and artifacts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCrewAgents, type CrewAgentConfig } from "./utils/discover.js";
import { truncateOutput } from "./utils/truncate.js";
import {
  createProgress,
  parseJsonlLine,
  updateProgress,
  getFinalOutput,
  type PiEvent,
} from "./utils/progress.js";
import {
  getArtifactPaths,
  ensureArtifactsDir,
  writeArtifact,
  writeMetadata,
  appendJsonl
} from "./utils/artifacts.js";
import { loadCrewConfig, getTruncationForRole, type CrewConfig } from "./utils/config.js";
import { removeLiveWorker, updateLiveWorker } from "./live-progress.js";
import { autonomousState, waitForConcurrencyChange } from "./state.js";
import { registerWorker, unregisterWorker, killAll } from "./registry.js";
import type { AgentTask, AgentResult } from "./types.js";
import { generateMemorableName } from "../lib.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface SpawnOptions {
  onProgress?: (results: AgentResult[]) => void;
  crewDir?: string;
  signal?: AbortSignal;
  messengerDirs?: { registry: string; inbox: string };
}

export function shutdownAllWorkers(): void {
  killAll();
}

export function resolveModel(
  taskModel?: string,
  paramModel?: string,
  configModel?: string,
  agentModel?: string,
): string | undefined {
  return taskModel ?? paramModel ?? configModel ?? agentModel;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function resolveThinking(
  configThinking?: string,
  agentThinking?: string,
): string | undefined {
  const resolved = configThinking ?? agentThinking;
  if (!resolved || resolved === "off") return undefined;
  return resolved;
}

export function modelHasThinkingSuffix(model: string | undefined): boolean {
  if (!model) return false;
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return false;
  return THINKING_LEVELS.has(model.substring(colonIdx + 1));
}

export function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function discoverWorkerName(
  pid: number | undefined,
  registryDir: string | undefined
): string | null {
  if (!pid || !registryDir || !fs.existsSync(registryDir)) return null;
  try {
    for (const file of fs.readdirSync(registryDir)) {
      if (!file.endsWith(".json")) continue;
      const reg = JSON.parse(fs.readFileSync(path.join(registryDir, file), "utf-8"));
      if (reg.pid === pid) return reg.name;
    }
  } catch {}
  return null;
}

const SHUTDOWN_MESSAGE = `⚠️ SHUTDOWN REQUESTED: Please wrap up your current work.
1. Release any file reservations
2. If the task is not complete, leave it as in_progress (do NOT mark done)
3. Do NOT commit anything
4. Exit`;

/**
 * Spawn multiple agents in parallel with concurrency limit.
 */
export async function spawnAgents(
  tasks: AgentTask[],
  cwd: string,
  options: SpawnOptions = {}
): Promise<AgentResult[]> {
  const crewDir = options.crewDir ?? path.join(cwd, ".pi", "messenger", "crew");
  const config = loadCrewConfig(crewDir);
  const agents = discoverCrewAgents(cwd);
  const runId = randomUUID().slice(0, 8);

  // Setup artifacts directory if enabled
  const artifactsDir = path.join(crewDir, "artifacts");
  if (config.artifacts.enabled) {
    ensureArtifactsDir(artifactsDir);
  }

  const results: AgentResult[] = [];
  const queue = tasks.map((task, index) => ({ task, index }));
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    if (options.signal?.aborted && running.length === 0) break;

    while (running.length < autonomousState.concurrency && queue.length > 0) {
      if (options.signal?.aborted) break;
      const { task, index } = queue.shift()!;
      const promise = runAgent(task, index, cwd, agents, config, runId, artifactsDir, options)
        .then(result => {
          results.push(result);
          running.splice(running.indexOf(promise), 1);
          options.onProgress?.(results);
        });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race([...running, waitForConcurrencyChange()]);
      if (options.signal?.aborted) continue;
    }
  }

  return results;
}

async function runAgent(
  task: AgentTask,
  index: number,
  cwd: string,
  agents: CrewAgentConfig[],
  config: CrewConfig,
  runId: string,
  artifactsDir: string,
  options: SpawnOptions
): Promise<AgentResult> {
  const agentConfig = agents.find(a => a.name === task.agent);
  const progress = createProgress(task.agent);
  const startTime = Date.now();
  const workerName = generateMemorableName();

  const role = agentConfig?.crewRole ?? "worker";
  const maxOutput = task.maxOutput
    ?? agentConfig?.maxOutput
    ?? getTruncationForRole(config, role);

  let artifactPaths = config.artifacts.enabled
    ? getArtifactPaths(artifactsDir, runId, task.agent, index)
    : undefined;

  if (artifactPaths) {
    try {
      writeArtifact(artifactPaths.inputPath, `# Task for ${task.agent}\n\n${task.task}`);
    } catch {
      artifactPaths = undefined;
    }
  }

  return new Promise((resolve) => {
    // Build args for pi command
    const args = ["--mode", "json", "--no-session", "-p"];
    const model = task.modelOverride ?? agentConfig?.model;
    if (model) args.push("--model", model);

    const thinking = resolveThinking(
      config.thinking?.[role],
      agentConfig?.thinking,
    );
    if (thinking && !modelHasThinkingSuffix(model)) {
      args.push("--thinking", thinking);
    }

    if (agentConfig?.tools?.length) {
      const builtinTools: string[] = [];
      const extensionPaths: string[] = [];
      for (const tool of agentConfig.tools) {
        if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
          extensionPaths.push(tool);
        } else if (BUILTIN_TOOLS.has(tool)) {
          builtinTools.push(tool);
        }
      }

      if (builtinTools.length > 0) {
        args.push("--tools", builtinTools.join(","));
      }
      for (const extensionPath of extensionPaths) {
        args.push("--extension", extensionPath);
      }
    }

    // Pass extension so workers can use pi_messenger
    args.push("--extension", EXTENSION_DIR);

    let promptTmpDir: string | null = null;
    if (agentConfig?.systemPrompt) {
      promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-agent-"));
      const promptPath = path.join(promptTmpDir, `${task.agent.replace(/[^\w.-]/g, "_")}.md`);
      fs.writeFileSync(promptPath, agentConfig.systemPrompt, { mode: 0o600 });
      args.push("--append-system-prompt", promptPath);
    }

    args.push(task.task);

    const envOverrides = config.work.env ?? {};
    const workerFlag = role === "worker"
      ? { PI_CREW_WORKER: "1", PI_AGENT_NAME: workerName }
      : {};
    const env = Object.keys(envOverrides).length > 0 || role === "worker"
      ? { ...process.env, ...envOverrides, ...workerFlag }
      : undefined;

    const proc = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
    if (task.taskId) {
      registerWorker({ type: "worker", proc, name: workerName, cwd, taskId: task.taskId });
    }
    let gracefulShutdownRequested = false;
    let discoveredWorkerName: string | null = null;

    let jsonlBuffer = "";
    const events: PiEvent[] = [];

    proc.stdout?.on("data", (data) => {
      try {
        jsonlBuffer += data.toString();
        const lines = jsonlBuffer.split("\n");
        jsonlBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseJsonlLine(line);
          if (event) {
            events.push(event);
            updateProgress(progress, event, startTime);
            if (artifactPaths) {
              try { appendJsonl(artifactPaths.jsonlPath, line); }
              catch { artifactPaths = undefined; }
            }
            if (task.taskId) {
              updateLiveWorker(cwd, task.taskId, {
                taskId: task.taskId,
                agent: task.agent,
                name: workerName,
                progress: {
                  ...progress,
                  recentTools: progress.recentTools.map(tool => ({ ...tool })),
                },
                startedAt: startTime,
              });
            }
          }
        }
      } catch {}
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (task.taskId) {
        removeLiveWorker(cwd, task.taskId);
        unregisterWorker(cwd, task.taskId);
      }
      progress.status = code === 0 ? "completed" : "failed";
      progress.durationMs = Date.now() - startTime;
      if (stderr && code !== 0) progress.error = stderr;

      const fullOutput = getFinalOutput(events);
      const truncation = truncateOutput(fullOutput, maxOutput, artifactPaths?.outputPath);

      if (artifactPaths) {
        try {
          writeArtifact(artifactPaths.outputPath, fullOutput);
          writeMetadata(artifactPaths.metadataPath, {
            runId,
            agent: task.agent,
            index,
            exitCode: code ?? 1,
            durationMs: progress.durationMs,
            tokens: progress.tokens,
            truncated: truncation.truncated,
            error: progress.error,
          });
        } catch {}
      }

      if (promptTmpDir) {
        try { fs.rmSync(promptTmpDir, { recursive: true, force: true }); } catch {}
      }

      resolve({
        agent: task.agent,
        exitCode: code ?? 1,
        output: truncation.text,
        truncated: truncation.truncated,
        progress,
        config: agentConfig,
        taskId: task.taskId,
        wasGracefullyShutdown: gracefulShutdownRequested,
        error: progress.error,
        artifactPaths: artifactPaths ? {
          input: artifactPaths.inputPath,
          output: artifactPaths.outputPath,
          jsonl: artifactPaths.jsonlPath,
          metadata: artifactPaths.metadataPath,
        } : undefined,
      });

      if (gracefulShutdownRequested && discoveredWorkerName && options.messengerDirs?.registry) {
        try {
          fs.unlinkSync(path.join(options.messengerDirs.registry, `${discoveredWorkerName}.json`));
        } catch {}
      }
    });

    // Handle abort signal
    if (options.signal) {
      const gracefulShutdown = async () => {
        gracefulShutdownRequested = true;

        let messageSent = false;
        discoveredWorkerName = discoverWorkerName(proc.pid, options.messengerDirs?.registry);
        if (discoveredWorkerName && options.messengerDirs) {
          try {
            const inboxDir = path.join(options.messengerDirs.inbox, discoveredWorkerName);
            if (fs.existsSync(inboxDir)) {
              const msgFile = path.join(inboxDir, `${Date.now()}-shutdown.json`);
              fs.writeFileSync(msgFile, JSON.stringify({
                id: randomUUID(),
                from: "crew-orchestrator",
                to: discoveredWorkerName,
                text: SHUTDOWN_MESSAGE,
                timestamp: new Date().toISOString(),
                replyTo: null,
              }));
              messageSent = true;
            }
          } catch {}
        }

        if (messageSent) {
          const graceMs = config.work.shutdownGracePeriodMs ?? 30000;
          const exitPromise = new Promise<void>(r => proc.once("exit", () => r()));
          const exited = await raceTimeout(exitPromise, graceMs);
          if (exited) return;
        }

        if (!proc.killed && proc.exitCode === null) {
          proc.kill("SIGTERM");
          const termPromise = new Promise<void>(r => proc.once("exit", () => r()));
          const killed = await raceTimeout(termPromise, 5000);
          if (killed) return;
        } else {
          return;
        }

        if (proc.exitCode === null) {
          proc.kill("SIGKILL");
        }
      };
      if (options.signal.aborted) {
        gracefulShutdown().catch(() => {});
      } else {
        options.signal.addEventListener("abort", () => {
          gracefulShutdown().catch(() => {});
        }, { once: true });
      }
    }
  });
}
