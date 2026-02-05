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

    const proc = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let jsonlBuffer = "";
    const events: unknown[] = [];

    proc.stdout?.on("data", (data) => {
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

    let stderr = "";
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
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

      resolve({
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

    // Handle abort signal
    if (options.signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
      };
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", kill, { once: true });
    }
  });
}

