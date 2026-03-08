/**
 * Crew - Heartbeat & Progress Protocol
 *
 * Tracks active worker heartbeats so the lobby/orchestrator can detect
 * stale (stuck) agents. Each active agent+task pair writes a single
 * JSON heartbeat file that is overwritten on every emit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getCrewDir } from "./store.js";

// =============================================================================
// Types
// =============================================================================

export interface Heartbeat {
  agentName: string;
  taskId: string;
  timestamp: string;       // ISO 8601
  subtask?: string;        // current subtask description
  progress?: number;       // 0-100 estimated %
  confidence?: number;     // 0-100
  blockers?: string[];     // current blockers
}

// =============================================================================
// Directory Helpers
// =============================================================================

function heartbeatsDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "heartbeats");
}

function heartbeatFile(cwd: string, agentName: string, taskId: string): string {
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTask = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(heartbeatsDir(cwd), `${safeName}-${safeTask}.json`);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Write (or overwrite) a heartbeat for the given agent+task pair.
 */
export function emitHeartbeat(cwd: string, heartbeat: Heartbeat): void {
  const dir = heartbeatsDir(cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory may already exist
  }
  const filePath = heartbeatFile(cwd, heartbeat.agentName, heartbeat.taskId);
  fs.writeFileSync(filePath, JSON.stringify(heartbeat, null, 2), { mode: 0o600 });
}

/**
 * Read all current heartbeat files and return parsed Heartbeat objects.
 */
export function getHeartbeats(cwd: string): Heartbeat[] {
  const dir = heartbeatsDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }

  const heartbeats: Heartbeat[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const hb = JSON.parse(raw) as Heartbeat;
      if (hb.agentName && hb.taskId && hb.timestamp) {
        heartbeats.push(hb);
      }
    } catch {
      // skip corrupt files
    }
  }
  return heartbeats;
}

/**
 * Return heartbeats that are older than thresholdMs (default: 2 minutes).
 */
export function getStaleAgents(cwd: string, thresholdMs: number = 120_000): Heartbeat[] {
  const now = Date.now();
  return getHeartbeats(cwd).filter(hb => {
    const age = now - new Date(hb.timestamp).getTime();
    return age > thresholdMs;
  });
}

/**
 * Remove the heartbeat file for a completed (or failed) task.
 */
export function clearHeartbeat(cwd: string, agentName: string, taskId: string): void {
  const filePath = heartbeatFile(cwd, agentName, taskId);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // file may not exist
  }
}
