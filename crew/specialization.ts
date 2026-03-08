/**
 * Agent Specialization Registry
 * 
 * Tracks which agent/model configurations perform best on which task types.
 * Persists scores to ~/.pi/agent/governance/specialization-registry.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type TaskType = 'implementation' | 'review' | 'testing' | 'planning' | 'research' | 'verification' | 'other';

export interface AgentPerformance {
  attempts: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  score: number;  // (successes / attempts) * 100
}

export interface SpecializationRegistry {
  taskTypes: {
    [type in TaskType]?: {
      agents: {
        [modelOrAgent: string]: AgentPerformance;
      };
    };
  };
  lastUpdated: string;
}

const DEFAULT_STORE_PATH = path.join(
  os.homedir(), ".pi", "agent", "governance", "specialization-registry.json"
);

function getStorePath(): string {
  return process.env.PI_SPECIALIZATION_FILE ?? DEFAULT_STORE_PATH;
}

/**
 * Load specialization registry from disk.
 * Returns empty registry if file doesn't exist or is invalid.
 */
export function loadRegistry(): SpecializationRegistry {
  const filePath = getStorePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SpecializationRegistry;
  } catch {
    return { taskTypes: {}, lastUpdated: new Date().toISOString() };
  }
}

/**
 * Save specialization registry to disk.
 * Creates the governance directory if it doesn't exist.
 */
export function saveRegistry(registry: SpecializationRegistry): void {
  const filePath = getStorePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
}

// Keyword-to-task-type mapping (order matters — first match wins)
const TASK_TYPE_KEYWORDS: Array<{ type: TaskType; keywords: string[] }> = [
  { type: "implementation", keywords: ["implement", "create", "build", "add"] },
  { type: "planning", keywords: ["plan", "design", "architecture"] },
  { type: "research", keywords: ["research", "investigate", "explore"] },
  { type: "verification", keywords: ["verify", "trace", "confirm"] },
  { type: "testing", keywords: ["test", "validate"] },
  { type: "review", keywords: ["review", "audit", "check"] },
];

/**
 * Classify a task by its title and optional content using keyword matching.
 */
export function classifyTask(title: string, content?: string): TaskType {
  const text = `${title} ${content ?? ""}`.toLowerCase();

  for (const { type, keywords } of TASK_TYPE_KEYWORDS) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return type;
      }
    }
  }

  return "other";
}

/**
 * Record a task outcome for an agent on a specific task type.
 * Updates performance stats and persists to disk.
 */
export function recordTaskOutcome(
  modelOrAgent: string,
  taskType: TaskType,
  succeeded: boolean,
  durationMs: number
): void {
  const registry = loadRegistry();

  if (!registry.taskTypes[taskType]) {
    registry.taskTypes[taskType] = { agents: {} };
  }

  const taskTypeEntry = registry.taskTypes[taskType]!;
  const existing = taskTypeEntry.agents[modelOrAgent] ?? {
    attempts: 0,
    successes: 0,
    failures: 0,
    avgDurationMs: 0,
    score: 0,
  };

  // Update running average duration
  const totalDuration = existing.avgDurationMs * existing.attempts + durationMs;
  existing.attempts += 1;

  if (succeeded) {
    existing.successes += 1;
  } else {
    existing.failures += 1;
  }

  existing.avgDurationMs = Math.round(totalDuration / existing.attempts);
  existing.score = Math.round((existing.successes / existing.attempts) * 10000) / 100;

  taskTypeEntry.agents[modelOrAgent] = existing;
  registry.lastUpdated = new Date().toISOString();

  saveRegistry(registry);
}

/**
 * Get best agent for a task type.
 * Returns the highest-scoring agent, or null if no agents recorded.
 */
export function getBestAgent(taskType: TaskType): { agent: string; score: number } | null {
  const registry = loadRegistry();
  const entry = registry.taskTypes[taskType];
  if (!entry) return null;

  const agents = Object.entries(entry.agents);
  if (agents.length === 0) return null;

  let best: { agent: string; score: number } | null = null;
  for (const [agent, perf] of agents) {
    if (!best || perf.score > best.score) {
      best = { agent, score: perf.score };
    }
  }

  return best;
}

/**
 * Get routing suggestions for a task type.
 * Returns all agents sorted by score (descending), minimum 3 attempts to be ranked.
 */
export function getRoutingSuggestions(taskType: TaskType): Array<{ agent: string; score: number; attempts: number }> {
  const registry = loadRegistry();
  const entry = registry.taskTypes[taskType];
  if (!entry) return [];

  return Object.entries(entry.agents)
    .filter(([_, perf]) => perf.attempts >= 3)
    .map(([agent, perf]) => ({ agent, score: perf.score, attempts: perf.attempts }))
    .sort((a, b) => b.score - a.score);
}
