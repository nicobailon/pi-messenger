/**
 * Credibility Scoring per Agent
 * 
 * Tracks agent accuracy based on adversarial review outcomes.
 * Persists scores to ~/.pi/agent/governance/credibility.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AgentCredibility {
  totalCompletions: number;
  survivedReviews: number;
  rejectedReviews: number;
  credibilityScore: number;  // 0-100
  lastUpdated: string;       // ISO-8601
}

export interface CredibilityStore {
  [agentName: string]: AgentCredibility;
}

const DEFAULT_STORE_PATH = path.join(
  os.homedir(), ".pi", "agent", "governance", "credibility.json"
);

function getStorePath(): string {
  return process.env.PI_CREDIBILITY_FILE ?? DEFAULT_STORE_PATH;
}

/**
 * Load credibility store from disk.
 * Returns empty object if file doesn't exist or is invalid.
 */
export function loadCredibility(): CredibilityStore {
  const filePath = getStorePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CredibilityStore;
  } catch {
    return {};
  }
}

/**
 * Save credibility store to disk.
 * Creates the governance directory if it doesn't exist.
 */
export function saveCredibility(store: CredibilityStore): void {
  const filePath = getStorePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

/**
 * Record an adversarial review outcome for an agent.
 * Updates the credibility score and persists to disk.
 */
export function recordReviewOutcome(agentName: string, survived: boolean): AgentCredibility {
  const store = loadCredibility();

  const existing = store[agentName] ?? {
    totalCompletions: 0,
    survivedReviews: 0,
    rejectedReviews: 0,
    credibilityScore: 0,
    lastUpdated: "",
  };

  existing.totalCompletions += 1;
  if (survived) {
    existing.survivedReviews += 1;
  } else {
    existing.rejectedReviews += 1;
  }

  // Score = (survived / total) * 100, rounded to 2 decimal places
  existing.credibilityScore =
    Math.round((existing.survivedReviews / existing.totalCompletions) * 10000) / 100;
  existing.lastUpdated = new Date().toISOString();

  store[agentName] = existing;
  saveCredibility(store);

  return existing;
}

/**
 * Get review intensity for an agent based on credibility score.
 * <50 = full, 50-80 = standard, >80 = light
 * Unknown agents default to 'standard'.
 */
export function getReviewIntensity(agentName: string): "full" | "standard" | "light" {
  const cred = getCredibility(agentName);
  if (!cred) return "standard";

  if (cred.credibilityScore < 50) return "full";
  if (cred.credibilityScore > 80) return "light";
  return "standard";
}

/**
 * Get an agent's current credibility record.
 * Returns null if the agent has no recorded history.
 */
export function getCredibility(agentName: string): AgentCredibility | null {
  const store = loadCredibility();
  return store[agentName] ?? null;
}
