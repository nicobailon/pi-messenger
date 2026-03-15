/**
 * Crew - Agent Spawning
 * 
 * Spawns pi processes with progress tracking, truncation, and artifacts.
 */

import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCrewAgents, type CrewAgentConfig } from "./utils/discover.js";
import { truncateOutput } from "./utils/truncate.js";
import { createStuckTimer } from "./utils/stuck-timer.js";
import {
  createProgress,
  parseJsonlLine,
  updateProgressFromEvent,
  getFinalOutput,
  type PiEvent,
} from "./utils/progress.js";
import { buildRuntimeSpawn } from "./runtime-spawn.js";
import { resolveRuntime } from "./utils/adapters/index.js";
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
import {
  pushModelArgs,
  resolveModel,
  resolveThinking,
  modelHasThinkingSuffix,
} from "./utils/model.js";
import { getMessengerRegistryDir, registerSpawnedWorker } from "../store.js";
import * as store from "./store.js";
import { logFeedEvent } from "../feed.js";

// Re-export for backward compatibility (tests, lobby.ts, collab.ts import from here)
export { pushModelArgs, resolveModel, resolveThinking, modelHasThinkingSuffix };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");

export interface SpawnOptions {
  onProgress?: (results: AgentResult[]) => void;
  crewDir?: string;
  signal?: AbortSignal;
  messengerDirs?: { registry: string; inbox: string };
}

export function shutdownAllWorkers(): void {
  killAll();
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

export const SHUTDOWN_MESSAGE = `⚠️ SHUTDOWN REQUESTED: Please wrap up your current work.
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
    // Build spawn args via runtime adapter (V1.6 — unified spawn engine)
    const runtime = resolveRuntime(config, role);
    const resolved = resolveModel(
      task.taskModel ?? task.modelOverride,
      task.paramModel,
      config.models?.[role],
      config.defaultModel,
      agentConfig?.model,
    );
    const model = resolved.model;
    if (model) {
      logFeedEvent(cwd, workerName, "model.resolved", model, `source: ${resolved.source}`);
    }
    const thinking = resolveThinking(
      config.thinking?.[role],
      agentConfig?.thinking,
    );

    let promptTmpDir: string | null = null;
    let systemPromptPath: string | undefined;
    const systemPrompt = agentConfig?.systemPrompt;
    if (systemPrompt) {
      promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-agent-"));
      systemPromptPath = path.join(promptTmpDir, `${task.agent.replace(/[^\w.-]/g, "_")}.md`);
      fs.writeFileSync(systemPromptPath, systemPrompt, { mode: 0o600 });
    }

    const spawnResult = buildRuntimeSpawn(
      runtime,
      { prompt: task.task, systemPrompt, systemPromptPath },
      {
        model,
        thinking,
        tools: agentConfig?.tools,
        extensionDir: EXTENSION_DIR,
      },
      (() => {
        const envOverrides = config.work.env ?? {};
        const workerFlag = role === "worker"
          ? { PI_CREW_WORKER: "1", PI_AGENT_NAME: workerName }
          : {};
        return { ...process.env as Record<string, string>, ...envOverrides, ...workerFlag };
      })(),
    );

    // R5 compliance: log warnings for unsupported features
    for (const warning of spawnResult.warnings) {
      // Will be wired to logFeedEvent when feed is available in this context
      console.warn(`[crew] ${warning}`);
    }

    // Defense-in-depth nonce: prevents accidental cross-talk between crew sessions
    let workerNonce: string | undefined;
    if (runtime !== "pi") {
      workerNonce = randomUUID();
      spawnResult.env.PI_CREW_NONCE = workerNonce;
    }

    const proc = spawn(spawnResult.command, spawnResult.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnResult.env,
    });
    if (task.taskId) {
      registerWorker({ type: "worker", proc, name: workerName, cwd, taskId: task.taskId });
    }

    // Pre-register non-pi workers (they can't self-register via extension)
    if (runtime !== "pi" && proc.pid) {
      const registryDir = options.messengerDirs?.registry ?? getMessengerRegistryDir();
      const nonceHash = workerNonce
        ? createHash("sha256").update(workerNonce).digest("hex")
        : undefined;
      registerSpawnedWorker(registryDir, cwd, workerName, proc.pid, model ?? "unknown", `crew-${randomUUID().slice(0, 6)}`, nonceHash);
    }

    let gracefulShutdownRequested = false;
    let discoveredWorkerName: string | null = null;

    // Stuck detection via shared utility
    const stuckTimer = createStuckTimer({
      stuckTimeoutMs: config.work.stuckTimeoutMs,
      cwd,
      workerName,
      taskId: task.taskId ?? "",
    });

    let jsonlBuffer = "";
    const events: PiEvent[] = [];

    proc.stdout?.on("data", (data) => {
      stuckTimer.onOutput();
      try {
        jsonlBuffer += data.toString();
        const lines = jsonlBuffer.split("\n");
        jsonlBuffer = lines.pop() ?? "";

        for (const line of lines) {
          // Store raw events for getFinalOutput (pi-specific, needed for output extraction)
          const rawEvent = parseJsonlLine(line);
          if (rawEvent) events.push(rawEvent);

          // Use adapter for normalized progress tracking
          const progressEvent = spawnResult.adapter.parseProgressEvent(line);
          if (progressEvent) {
            updateProgressFromEvent(progress, progressEvent, startTime);
          }

          if (rawEvent && artifactPaths) {
            try { appendJsonl(artifactPaths.jsonlPath, line); }
            catch { artifactPaths = undefined; }
          }
          if ((rawEvent || progressEvent) && task.taskId) {
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
      } catch {}
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      stuckTimer.clear();
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
