/**
 * Collaborator heartbeat helpers — spec 009, A1/R3/R4
 *
 * Exported at module level (not inside the Pi extension factory) so they can be
 * directly unit-tested without the Pi extension event system or pi-tui dependencies.
 * The session_start/session_shutdown event handlers in index.ts delegate to these.
 */

import * as fs from "node:fs";
import { join } from "node:path";

/**
 * Start the collaborator heartbeat writer. Writes Date.now() to the heartbeat
 * file every heartbeatIntervalMs. Returns the timer handle and file path.
 * Caller stores the timer and passes it to stopCollabHeartbeat on shutdown.
 *
 * heartbeatIntervalMs formula (R4): max(1000, min(10000, stallThresholdMs/8))
 * Default stallThresholdMs=120s → 10s interval → ≥12 missed beats minimum.
 */
export function startCollabHeartbeat(opts: {
  registryDir: string;
  agentName: string;
  stallThresholdMs: number;
}): { timer: ReturnType<typeof setInterval>; heartbeatFile: string; heartbeatIntervalMs: number } {
  const { registryDir, agentName, stallThresholdMs } = opts;
  const heartbeatIntervalMs = Math.max(1000, Math.min(10000, stallThresholdMs / 8));
  const heartbeatFile = join(registryDir, `${agentName}.heartbeat`);
  const timer = setInterval(() => {
    try { fs.writeFileSync(heartbeatFile, Date.now().toString()); } catch {}
  }, heartbeatIntervalMs);
  return { timer, heartbeatFile, heartbeatIntervalMs };
}

/**
 * Stop the collaborator heartbeat and remove the heartbeat file.
 * Called from session_shutdown (index.ts). No-op if timer is null.
 */
export function stopCollabHeartbeat(opts: {
  timer: ReturnType<typeof setInterval> | null;
  heartbeatFile: string;
}): void {
  if (opts.timer) {
    clearInterval(opts.timer);
    try { fs.unlinkSync(opts.heartbeatFile); } catch {}
  }
}
