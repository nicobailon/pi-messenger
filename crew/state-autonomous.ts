/**
 * Crew - Autonomous Execution State
 *
 * Tracks autonomous mode, wave history, concurrency, and auto-work flag.
 */

import { normalizeCwd } from "./state.js";

export interface WaveResult {
  waveNumber: number;
  tasksAttempted: string[];
  succeeded: string[];
  failed: string[];
  blocked: string[];
  timestamp: string;
}

export interface AutonomousState {
  active: boolean;
  cwd: string | null;
  waveNumber: number;
  waveHistory: WaveResult[];
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: "completed" | "blocked" | "manual" | null;
  concurrency: number;
  autoOverlayPending: boolean;
}

export const autonomousState: AutonomousState = {
  active: false,
  cwd: null,
  waveNumber: 0,
  waveHistory: [],
  startedAt: null,
  stoppedAt: null,
  stopReason: null,
  concurrency: 2,
  autoOverlayPending: false,
};

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 10;

export function clampConcurrency(value: number, configMax?: number): number {
  if (!Number.isFinite(value)) return MIN_CONCURRENCY;
  const whole = Math.trunc(value);
  const effectiveMax = configMax != null && Number.isFinite(configMax)
    ? Math.min(configMax, MAX_CONCURRENCY)
    : MAX_CONCURRENCY;
  return Math.max(MIN_CONCURRENCY, Math.min(effectiveMax, whole));
}

let concurrencyResolve: (() => void) | null = null;

export function adjustConcurrency(delta: number, configMax?: number): number {
  autonomousState.concurrency = clampConcurrency(autonomousState.concurrency + delta, configMax);
  if (concurrencyResolve) {
    const resolve = concurrencyResolve;
    concurrencyResolve = null;
    resolve();
  }
  return autonomousState.concurrency;
}

export function waitForConcurrencyChange(): Promise<void> {
  return new Promise(resolve => {
    concurrencyResolve = resolve;
  });
}

export function startAutonomous(cwd: string, concurrency: number): void {
  autonomousState.active = true;
  autonomousState.cwd = normalizeCwd(cwd);
  autonomousState.waveNumber = 1;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = new Date().toISOString();
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
  autonomousState.concurrency = clampConcurrency(concurrency);
  autonomousState.autoOverlayPending = true;
}

export function stopAutonomous(reason: "completed" | "blocked" | "manual"): void {
  autonomousState.active = false;
  autonomousState.autoOverlayPending = false;
  autonomousState.stoppedAt = new Date().toISOString();
  autonomousState.stopReason = reason;
}

export function addWaveResult(result: WaveResult): void {
  autonomousState.waveHistory.push(result);
  autonomousState.waveNumber++;
}

export function restoreAutonomousState(data: Partial<AutonomousState>): void {
  if (data.active !== undefined) autonomousState.active = data.active;
  if (data.cwd !== undefined) {
    autonomousState.cwd = data.cwd ? normalizeCwd(data.cwd) : data.cwd;
  }
  if (data.waveNumber !== undefined) autonomousState.waveNumber = data.waveNumber;
  if (data.waveHistory !== undefined) autonomousState.waveHistory = data.waveHistory;
  if (data.startedAt !== undefined) autonomousState.startedAt = data.startedAt;
  if (data.stoppedAt !== undefined) autonomousState.stoppedAt = data.stoppedAt;
  if (data.stopReason !== undefined) autonomousState.stopReason = data.stopReason;
  if (data.concurrency !== undefined) {
    autonomousState.concurrency = clampConcurrency(Number(data.concurrency));
  }
}

export function isAutonomousForCwd(cwd: string): boolean {
  if (!autonomousState.active || !autonomousState.cwd) return false;
  return normalizeCwd(autonomousState.cwd) === normalizeCwd(cwd);
}

let pendingAutoWork = false;
let pendingAutoWorkCwd: string | null = null;

export function isPendingAutoWork(): boolean {
  return pendingAutoWork;
}

export function setPendingAutoWork(cwd: string): void {
  pendingAutoWork = true;
  pendingAutoWorkCwd = normalizeCwd(cwd);
}

export function consumePendingAutoWork(): { cwd: string } | null {
  if (!pendingAutoWork || !pendingAutoWorkCwd) return null;
  const consumed = { cwd: pendingAutoWorkCwd };
  pendingAutoWork = false;
  pendingAutoWorkCwd = null;
  return consumed;
}
