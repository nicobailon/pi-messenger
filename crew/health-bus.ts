/**
 * crew/health-bus.ts — Unified Agent Health Bus
 *
 * Bridges 3 disconnected health sources → unified agent.health FeedEvents in feed.jsonl
 * Sources:
 *   1. governance/events.jsonl (slow_subagent, heartbeat_streak_warning, consecutiveProviderErrors)
 *   2. heartbeat files from .pi/messenger/crew/heartbeats/
 *   3. Polling interval: 15s
 *
 * Both TUI (overlay-render.ts) and OmO (crew-panel.ts) consume feed.jsonl.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { logFeedEvent } from '../feed.js';

const GOV_EVENTS_PATH = path.join(homedir(), '.pi', 'agent', 'governance', 'events.jsonl');
const HEARTBEATS_DIR = path.join(homedir(), '.pi', 'messenger', 'crew', 'heartbeats');
const POLL_INTERVAL_MS = 15_000;

interface HealthBusState {
  lastGovOffset: number;
  agentStallCounts: Map<string, number>;
  lastHealthEmit: Map<string, number>;
  timer: ReturnType<typeof setInterval> | null;
}

const state: HealthBusState = {
  lastGovOffset: 0,
  agentStallCounts: new Map(),
  lastHealthEmit: new Map(),
  timer: null,
};

function pollGovernanceEvents(cwd: string): void {
  if (!fs.existsSync(GOV_EVENTS_PATH)) return;
  try {
    const content = fs.readFileSync(GOV_EVENTS_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const newLines = lines.slice(state.lastGovOffset);
    state.lastGovOffset = lines.length;
    for (const line of newLines) {
      try {
        const event = JSON.parse(line);
        const { type, data } = event;
        if (type === 'slow_subagent') {
          const agentId = data?.agent || data?.agentId || 'unknown';
          const count = (state.agentStallCounts.get(agentId) ?? 0) + 1;
          state.agentStallCounts.set(agentId, count);
          const severity: 'info' | 'warn' | 'critical' = count >= 3 ? 'critical' : count >= 2 ? 'warn' : 'info';
          emitHealthEvent(cwd, agentId, count >= 3 ? 'critical' : 'degraded', severity,
            `Slow subagent signal ${count}/3 — ${count >= 3 ? 'recommend termination' : 'monitoring'}`);
        } else if (type === 'heartbeat_streak_warning') {
          const agentId = data?.agent || 'unknown';
          const streak = data?.streak ?? 0;
          emitHealthEvent(cwd, agentId, 'suspicious', 'warn',
            `No heartbeat for ${streak} dispatches — worker may be silent`);
        } else if (type === 'review_chain_hard_blocked' || type === 'bash_streak_blocked') {
          const agentId = data?.agent || 'helios';
          emitHealthEvent(cwd, agentId, 'degraded', 'warn', `Governance block: ${type}`);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // governance file unavailable
  }
}

function pollHeartbeatFiles(cwd: string): void {
  if (!fs.existsSync(HEARTBEATS_DIR)) return;
  try {
    const files = fs.readdirSync(HEARTBEATS_DIR).filter(f => f.endsWith('.json'));
    const now = Date.now();
    for (const file of files) {
      try {
        const taskId = path.basename(file, '.json');
        const raw = JSON.parse(fs.readFileSync(path.join(HEARTBEATS_DIR, file), 'utf-8'));
        const lastTs = new Date(raw.timestamp || raw.ts || 0).getTime();
        const silenceMs = now - lastTs;
        const lastEmit = state.lastHealthEmit.get(taskId) ?? 0;
        if (silenceMs > 30_000 && now - lastEmit > 60_000) {
          const tier: 'critical' | 'degraded' | 'suspicious' =
            silenceMs > 300_000 ? 'critical' : silenceMs > 120_000 ? 'degraded' : 'suspicious';
          const severity: 'critical' | 'warn' | 'info' =
            tier === 'critical' ? 'critical' : tier === 'degraded' ? 'warn' : 'info';
          emitHealthEvent(cwd, raw.agentName || taskId, tier, severity,
            `No heartbeat for ${Math.round(silenceMs / 1000)}s — ${raw.subtask || raw.detail || 'unknown task'}`);
          state.lastHealthEmit.set(taskId, now);
        }
      } catch {
        // skip malformed heartbeat files
      }
    }
  } catch {
    // heartbeats dir unavailable
  }
}

function emitHealthEvent(
  cwd: string,
  agentId: string,
  tier: 'healthy' | 'suspicious' | 'degraded' | 'critical' | 'dead',
  severity: 'info' | 'warn' | 'error' | 'critical',
  detail: string
): void {
  if (tier === 'healthy') return;
  try {
    logFeedEvent(cwd, 'helios-health', 'agent.health', agentId, `${tier}: ${detail}`);
  } catch {
    // best-effort
  }
}

/**
 * Start the health bus. Call once when crew session begins.
 */
export function startHealthBus(cwd: string): void {
  if (state.timer) return;
  pollGovernanceEvents(cwd);
  pollHeartbeatFiles(cwd);
  state.timer = setInterval(() => {
    pollGovernanceEvents(cwd);
    pollHeartbeatFiles(cwd);
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the health bus. Call on session shutdown.
 */
export function stopHealthBus(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.agentStallCounts.clear();
  state.lastHealthEmit.clear();
  state.lastGovOffset = 0;
}
