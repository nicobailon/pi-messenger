/**
 * Crew - Shared Reasoning Blackboard
 *
 * A shared memory space for agents to post and challenge reasoning.
 * Stored as {crewDir}/blackboard.json — a JSON object keyed by entry key.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getCrewDir } from "./store.js";

// =============================================================================
// Types
// =============================================================================

export interface BlackboardChallenge {
  challengedBy: string;
  challenge: string;
  timestamp: string;
  resolution?: string;
}

export interface BlackboardEntry {
  key: string;
  value: string;
  reasoning: string;
  postedBy: string;
  timestamp: string;
  challenges: BlackboardChallenge[];
}

// =============================================================================
// Internal Helpers
// =============================================================================

type BlackboardData = Record<string, BlackboardEntry>;

function getBlackboardPath(cwd: string): string {
  return path.join(getCrewDir(cwd), "blackboard.json");
}

function readBlackboard(cwd: string): BlackboardData {
  const filePath = getBlackboardPath(cwd);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeBlackboard(cwd: string, data: BlackboardData): void {
  const filePath = getBlackboardPath(cwd);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Post a new entry to the blackboard.
 * Overwrites any existing entry with the same key.
 */
export function postEntry(
  cwd: string,
  entry: Omit<BlackboardEntry, "challenges" | "timestamp">
): BlackboardEntry {
  const data = readBlackboard(cwd);

  const fullEntry: BlackboardEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
    challenges: [],
  };

  data[entry.key] = fullEntry;
  writeBlackboard(cwd, data);
  return fullEntry;
}

/**
 * Read a single entry by key.
 * Returns null if the key doesn't exist or the blackboard file doesn't exist.
 */
export function readEntry(cwd: string, key: string): BlackboardEntry | null {
  const data = readBlackboard(cwd);
  return data[key] ?? null;
}

/**
 * List all entries in the blackboard.
 * Returns an empty array if no entries or no blackboard file.
 */
export function listEntries(cwd: string): BlackboardEntry[] {
  const data = readBlackboard(cwd);
  return Object.values(data);
}

/**
 * Add a challenge to an existing entry.
 * Returns the updated entry, or null if the key doesn't exist.
 */
export function challengeEntry(
  cwd: string,
  key: string,
  challengedBy: string,
  challenge: string
): BlackboardEntry | null {
  const data = readBlackboard(cwd);
  const entry = data[key];
  if (!entry) return null;

  entry.challenges.push({
    challengedBy,
    challenge,
    timestamp: new Date().toISOString(),
  });

  data[key] = entry;
  writeBlackboard(cwd, data);
  return entry;
}

/**
 * Resolve a specific challenge on an entry.
 * Returns the updated entry, or null if key doesn't exist or challenge index is out of bounds.
 */
export function resolveChallenge(
  cwd: string,
  key: string,
  challengeIndex: number,
  resolution: string
): BlackboardEntry | null {
  const data = readBlackboard(cwd);
  const entry = data[key];
  if (!entry) return null;
  if (challengeIndex < 0 || challengeIndex >= entry.challenges.length) return null;

  entry.challenges[challengeIndex].resolution = resolution;

  data[key] = entry;
  writeBlackboard(cwd, data);
  return entry;
}
