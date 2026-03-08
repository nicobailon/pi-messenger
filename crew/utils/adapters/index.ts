/**
 * Crew - Runtime Adapter Factory
 *
 * Central registry for runtime adapters. Use getAdapter() to obtain
 * an adapter by name, and resolveRuntime() to read the configured
 * runtime for a given crew role.
 */

import type { RuntimeAdapter } from "./types.js";
import type { CrewConfig } from "../config.js";
import { PiAdapter } from "./pi.js";

const piAdapter = new PiAdapter();

/**
 * Get a RuntimeAdapter by name.
 * Throws if the runtime is unknown — call resolveRuntime() first
 * to get a validated name from config.
 */
export function getAdapter(runtime: string): RuntimeAdapter {
  switch (runtime) {
    case "pi":
      return piAdapter;
    default:
      throw new Error(`Unknown runtime "${runtime}". Known runtimes: pi`);
  }
}

/**
 * Read the configured runtime for a crew role.
 * Falls back to "pi" when not configured — backward compatible.
 */
export function resolveRuntime(config: CrewConfig, role: string): string {
  const runtimeConfig = config.runtime;
  if (!runtimeConfig) return "pi";
  return (runtimeConfig as Record<string, string | undefined>)[role] ?? "pi";
}
