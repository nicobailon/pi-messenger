/**
 * Crew - Configuration Loading
 * 
 * Loads and merges user-level and project-level configuration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MaxOutputConfig } from "./truncate.js";

export type CoordinationLevel = "none" | "minimal" | "moderate" | "chatty";

const USER_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "pi-messenger.json");
const PROJECT_CONFIG_FILE = "config.json";

const COORDINATION_LEVELS: CoordinationLevel[] = ["none", "minimal", "moderate", "chatty"];

let coordinationOverride: CoordinationLevel | null = null;

export function setCoordinationOverride(level: CoordinationLevel): void {
  coordinationOverride = level;
}

export function getCoordinationOverride(): CoordinationLevel | null {
  return coordinationOverride;
}

export function cycleCoordinationLevel(current: CoordinationLevel): CoordinationLevel {
  const idx = COORDINATION_LEVELS.indexOf(current);
  return COORDINATION_LEVELS[(idx + 1) % COORDINATION_LEVELS.length];
}

export interface CrewConfig {
  models?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
    analyst?: string;
  };
  thinking?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
    analyst?: string;
  };
  concurrency: {
    workers: number;
    max: number;
  };
  truncation: {
    planners: MaxOutputConfig;
    workers: MaxOutputConfig;
    reviewers: MaxOutputConfig;
    analysts: MaxOutputConfig;
  };
  artifacts: {
    enabled: boolean;
    cleanupDays: number;
  };
  memory: { enabled: boolean };
  planSync: { enabled: boolean };
  review: { enabled: boolean; maxIterations: number };
  planning: { maxPasses: number };
  work: {
    maxAttemptsPerTask: number;
    maxWaves: number;
    stopOnBlock: boolean;
    env?: Record<string, string>;
    shutdownGracePeriodMs?: number;
  };
  dependencies: "advisory" | "strict";
  coordination: CoordinationLevel;
  messageBudgets: Record<CoordinationLevel, number>;
}

const DEFAULT_CONFIG: CrewConfig = {
  concurrency: {
    workers: 2,
    max: 10,
  },
  truncation: {
    planners: { bytes: 204800, lines: 5000 },
    workers: { bytes: 204800, lines: 5000 },
    reviewers: { bytes: 102400, lines: 2000 },
    analysts: { bytes: 102400, lines: 2000 },
  },
  artifacts: { enabled: true, cleanupDays: 7 },
  memory: { enabled: false },
  planSync: { enabled: false },
  review: { enabled: true, maxIterations: 3 },
  planning: { maxPasses: 1 },
  work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false, shutdownGracePeriodMs: 30000 },
  dependencies: "advisory",
  coordination: "chatty",
  messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
};

function loadJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge<T extends object>(target: T, ...sources: Partial<T>[]): T {
  const result: Record<string, unknown> = target && typeof target === "object"
    ? { ...(target as Record<string, unknown>) }
    : {};
  for (const source of sources) {
    const src = source as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      const targetVal = result[key];
      const sourceVal = src[key];
      if (sourceVal && typeof sourceVal === "object" && !Array.isArray(sourceVal)) {
        const base = targetVal && typeof targetVal === "object" && !Array.isArray(targetVal)
          ? targetVal as object
          : {};
        result[key] = deepMerge(base, sourceVal as object);
      } else if (sourceVal !== undefined) {
        result[key] = sourceVal;
      }
    }
  }
  return result as T;
}

/**
 * Load crew configuration with priority: defaults <- user <- project
 */
export function loadCrewConfig(crewDir: string): CrewConfig {
  // User-level config (from ~/.pi/agent/pi-messenger.json -> crew section)
  const userConfig = loadJson(USER_CONFIG_PATH);
  const userCrewConfig = (userConfig.crew ?? {}) as Partial<CrewConfig>;

  // Project-level config (from .pi/messenger/crew/config.json)
  const projectConfig = loadJson(path.join(crewDir, PROJECT_CONFIG_FILE)) as Partial<CrewConfig>;

  // Merge: defaults <- user <- project <- runtime override
  const merged = deepMerge(DEFAULT_CONFIG, userCrewConfig, projectConfig);
  if (coordinationOverride !== null) {
    merged.coordination = coordinationOverride;
  }
  return merged;
}

export function getTruncationForRole(config: CrewConfig, role: string): MaxOutputConfig {
  switch (role) {
    case "planner": return config.truncation.planners;
    case "worker": return config.truncation.workers;
    case "reviewer": return config.truncation.reviewers;
    case "analyst": return config.truncation.analysts;
    default: return config.truncation.workers;
  }
}
