/**
 * Crew - Agent Spawning
 * 
 * Spawns pi processes with progress tracking, truncation, and artifacts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCrewAgents, type CrewAgentConfig } from "./utils/discover.js";
import { truncateOutput, type MaxOutputConfig } from "./utils/truncate.js";
import {
  createProgress,
  parseJsonlLine,
  updateProgress,
  getFinalOutput,
  type AgentProgress
} from "./utils/progress.js";
import {
  getArtifactPaths,
  ensureArtifactsDir,
  writeArtifact,
  writeMetadata,
  appendJsonl
} from "./utils/artifacts.js";
import { loadCrewConfig, getTruncationForRole, type CrewConfig } from "./utils/config.js";
import type { AgentTask, AgentResult } from "./types.js";

// Extension directory (parent of crew/) - passed to subagents so they can use pi_messenger
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");

export interface SpawnOptions {
  onProgress?: (results: AgentResult[]) => void;
  crewDir?: string;
  signal?: AbortSignal;
}

/**
 * Spawn multiple agents in parallel with concurrency limit.
 */
export async function spawnAgents(
  tasks: AgentTask[],
  concurrency: number,
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
    while (running.length < concurrency && queue.length > 0) {
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
      await Promise.race(running);
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

  // Determine truncation limits
  const role = agentConfig?.crewRole ?? "worker";
  const maxOutput = task.maxOutput
    ?? agentConfig?.maxOutput
    ?? getTruncationForRole(config, role);

  // Setup artifact paths
  const artifactPaths = config.artifacts.enabled
    ? getArtifactPaths(artifactsDir, runId, task.agent, index)
    : undefined;

  // Write input artifact (best-effort)
  if (artifactPaths) {
    try {
      writeArtifact(artifactPaths.inputPath, `# Task for ${task.agent}\n\n${task.task}`);
    } catch {
      // Never fail the run due to debug artifact errors.
    }
  }

  return new Promise((resolve) => {
    // Build args for pi command
    const args = ["--mode", "json", "--agent", task.agent, "-p", task.task];
    if (agentConfig?.model) args.push("--model", agentConfig.model);
    
    // Pass extension so workers can use pi_messenger
    args.push("--extension", EXTENSION_DIR);

    let settled = false;
    const finish = (result: AgentResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let activeProc: ReturnType<typeof spawn> | null = null;
    let didFallback = false;

    let jsonlBuffer = "";
    const events: unknown[] = [];
    let stderr = "";

    const spawnProcess = (command: string, commandArgs: string[]) => {
      const proc = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      activeProc = proc;
      attach(proc);
      return proc;
    };

    const attach = (proc: ReturnType<typeof spawn>) => {
      proc.stdout?.on("data", (data) => {
        if (proc !== activeProc) return;
        jsonlBuffer += data.toString();
        const lines = jsonlBuffer.split("\n");
        jsonlBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseJsonlLine(line);
          if (event) {
            events.push(event);
            updateProgress(progress, event, startTime);
            if (artifactPaths) {
              try {
                appendJsonl(artifactPaths.jsonlPath, line);
              } catch {
                // Never fail the run due to debug artifact errors.
              }
            }
          }
        }
      });

      proc.stderr?.on("data", (data) => {
        if (proc !== activeProc) return;
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (proc !== activeProc) return;

        progress.status = code === 0 ? "completed" : "failed";
        progress.durationMs = Date.now() - startTime;
        if (stderr && code !== 0) progress.error = stderr;

        // Get final output from events
        const fullOutput = getFinalOutput(events as any[]);
        const truncation = truncateOutput(fullOutput, maxOutput, artifactPaths?.outputPath);

        // Write output artifacts (best-effort)
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
          } catch {
            // Never fail the run due to debug artifact errors.
          }
        }

        finish({
          agent: task.agent,
          exitCode: code ?? 1,
          output: truncation.text,
          truncated: truncation.truncated,
          progress,
          config: agentConfig,
          error: progress.error,
          artifactPaths: artifactPaths ? {
            input: artifactPaths.inputPath,
            output: artifactPaths.outputPath,
            jsonl: artifactPaths.jsonlPath,
            metadata: artifactPaths.metadataPath,
          } : undefined,
        });
      });

      proc.on("error", (err: any) => {
        if (proc !== activeProc) return;

        const errCode = err?.code;
        if (!didFallback && errCode === "ENOENT") {
          const cli = process.env.PI_MESSENGER_PI_CLI;
          if (cli) {
            didFallback = true;

            // Reset buffers for the fallback run.
            jsonlBuffer = "";
            events.length = 0;
            stderr = "";

            spawnProcess(process.execPath, [cli, ...args]);
            return;
          }
        }

        progress.status = "failed";
        progress.durationMs = Date.now() - startTime;
        progress.error = err?.message ?? String(err);

        finish({
          agent: task.agent,
          exitCode: 1,
          output: "",
          truncated: false,
          progress,
          config: agentConfig,
          error: progress.error,
          artifactPaths: artifactPaths ? {
            input: artifactPaths.inputPath,
            output: artifactPaths.outputPath,
            jsonl: artifactPaths.jsonlPath,
            metadata: artifactPaths.metadataPath,
          } : undefined,
        });
      });
    };

    // Primary: try `pi` from PATH.
    spawnProcess("pi", args);

    // Handle abort signal
    if (options.signal) {
      const kill = () => {
        const proc = activeProc;
        if (!proc) return;
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        const p = proc;
        setTimeout(() => {
          try {
            !p.killed && p.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 3000);
      };
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", kill, { once: true });
    }
  });
}

