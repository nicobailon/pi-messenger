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

export const RUNTIME_ALLOWLIST = new Set(["pi", "claude", "codex"]);

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
export interface BuildRuntimeSpawnOptions {
  /** Skip the `which` check for the runtime command (useful in tests) */
  skipCommandCheck?: boolean;
}

export function buildRuntimeSpawn(
  runtime: string,
  task: SpawnTask,
  config: AdapterConfig,
  baseEnv: Record<string, string>,
  options?: BuildRuntimeSpawnOptions,
): RuntimeSpawnArgs {
  if (!RUNTIME_ALLOWLIST.has(runtime)) {
    throw new Error(`Unknown runtime "${runtime}". Allowed: ${[...RUNTIME_ALLOWLIST].join(", ")}`);
  }

  const adapter = getAdapter(runtime);
  const command = adapter.getCommand();
  // Skip validation for "pi" — pi-messenger is always loaded from within pi.
  // Non-pi runtimes get validated to fail fast with install instructions.
  if (runtime !== "pi" && !options?.skipCommandCheck) {
    validateCommandAvailable(command);
  }

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

  // Validate pi-messenger-cli is reachable in the worker's constructed env.
  // Non-pi workers are instructed to use pi-messenger-cli for task lifecycle,
  // reservations, and messaging. Missing CLI = broken worker. Hard error.
  // Note: only the CLI check uses the constructed env. The runtime-command
  // check above remains parent-env-based (pre-existing behavior, out of scope).
  if (runtime !== "pi" && !options?.skipCommandCheck) {
    try {
      execFileSync("which", ["pi-messenger-cli"], { stdio: "ignore", env });
    } catch {
      throw new Error(
        `pi-messenger-cli not found in worker PATH (required for ${runtime} workers to communicate with the mesh). ` +
        `Run: npx pi-messenger`
      );
    }
  }

  return { command, args, env, adapter, warnings };
}

function validateCommandAvailable(command: string): void {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
  } catch {
    throw new Error(`Runtime command "${command}" not found in PATH`);
  }
}
