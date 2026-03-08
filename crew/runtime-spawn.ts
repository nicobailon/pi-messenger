/**
 * Crew - Unified Runtime Spawn Engine
 *
 * Shared by both agents.ts (spawnAgents path) and lobby.ts (lobby worker path).
 * Validates runtime availability, builds args via adapter, and collects
 * feature-degradation warnings for R5 compliance.
 */

import { execFileSync } from "node:child_process";
import type { RuntimeAdapter, SpawnTask, AdapterConfig } from "./utils/adapters/types.js";
import { getAdapter } from "./utils/adapters/index.js";

export const RUNTIME_ALLOWLIST = new Set(["pi"]);

export interface RuntimeSpawnArgs {
  command: string;
  args: string[];
  env: Record<string, string>;
  adapter: RuntimeAdapter;
  /** R5 compliance: callers MUST log these to feed */
  warnings: string[];
}

/**
 * Build everything needed to spawn a worker for any supported runtime.
 * Both agents.ts and lobby.ts call this instead of hardcoding pi args.
 */
export function buildRuntimeSpawn(
  runtime: string,
  task: SpawnTask,
  config: AdapterConfig,
  baseEnv: Record<string, string>,
): RuntimeSpawnArgs {
  if (!RUNTIME_ALLOWLIST.has(runtime)) {
    throw new Error(`Unknown runtime "${runtime}". Allowed: ${[...RUNTIME_ALLOWLIST].join(", ")}`);
  }

  const adapter = getAdapter(runtime);
  const command = adapter.getCommand();
  validateCommandAvailable(command);

  // R5 compliance: build explicit warnings for unsupported features
  const warnings: string[] = [];
  if (config.thinking && !adapter.supportsFeature("thinking")) {
    warnings.push(`${runtime}: thinking flag not supported, skipping`);
  }
  if (config.tools?.length && !adapter.supportsFeature("tool-restriction")) {
    warnings.push(`${runtime}: tool restriction not supported, skipping`);
  }
  if (config.extensionDir && !adapter.supportsFeature("extension-loading")) {
    warnings.push(`${runtime}: extension loading not supported, custom tools unavailable`);
  }

  const args = adapter.buildArgs(task, config);
  const env = adapter.buildEnv(baseEnv);
  return { command, args, env, adapter, warnings };
}

function validateCommandAvailable(command: string): void {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
  } catch {
    throw new Error(`Runtime command "${command}" not found in PATH`);
  }
}
