/**
 * Crew - Planning State & Observability
 *
 * Tracks planning runs, phases, overlay pending state, stale detection,
 * and cancellation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeCwd } from "./state.js";

export type PlanningPhase =
  | "idle"
  | "read-prd"
  | "scan-code"
  | "docs"
  | "refs"
  | "gap-analysis"
  | "build-steps"
  | "build-task-graph"
  | "review-pass"
  | "finalizing"
  | "completed"
  | "failed";

export interface PlanningState {
  active: boolean;
  cwd: string | null;
  runId: string | null;
  pass: number;
  maxPasses: number;
  phase: PlanningPhase;
  updatedAt: string | null;
  pid: number | null;
}

export const planningState: PlanningState = {
  active: false,
  cwd: null,
  runId: null,
  pass: 0,
  maxPasses: 0,
  phase: "idle",
  updatedAt: null,
  pid: null,
};

interface PlanningOverlayRuntime {
  pendingRunId: string | null;
  pendingCwd: string | null;
  dismissedRunIds: Set<string>;
}

const planningOverlayRuntime: PlanningOverlayRuntime = {
  pendingRunId: null,
  pendingCwd: null,
  dismissedRunIds: new Set<string>(),
};

export const PLANNING_STALE_TIMEOUT_MS = 5 * 60 * 1000;

export function isPlanningForCwd(cwd: string): boolean {
  if (!planningState.active || !planningState.cwd) return false;
  return normalizeCwd(planningState.cwd) === normalizeCwd(cwd);
}

function clearPlanningOverlayPending(): void {
  planningOverlayRuntime.pendingRunId = null;
  planningOverlayRuntime.pendingCwd = null;
}

export function markPlanningOverlayPending(cwd: string): void {
  if (!isPlanningForCwd(cwd)) return;
  const runId = planningState.runId;
  const planningCwd = planningState.cwd;
  if (!runId || !planningCwd) return;
  if (planningOverlayRuntime.dismissedRunIds.has(runId)) return;

  planningOverlayRuntime.pendingRunId = runId;
  planningOverlayRuntime.pendingCwd = planningCwd;
}

export function getPlanningOverlayPending(cwd: string): { runId: string; cwd: string } | null {
  if (!isPlanningForCwd(cwd)) return null;
  const runId = planningState.runId;
  const planningCwd = planningState.cwd;
  if (!runId || !planningCwd) return null;
  if (planningOverlayRuntime.pendingRunId !== runId) return null;
  if (planningOverlayRuntime.pendingCwd !== planningCwd) return null;
  return { runId, cwd: planningCwd };
}

export function consumePlanningOverlayPending(cwd: string): { runId: string; cwd: string } | null {
  const pending = getPlanningOverlayPending(cwd);
  if (!pending) return null;
  clearPlanningOverlayPending();
  return pending;
}

export function dismissPlanningOverlayRun(runId: string): void {
  planningOverlayRuntime.dismissedRunIds.add(runId);
  if (planningOverlayRuntime.pendingRunId === runId) {
    clearPlanningOverlayPending();
  }
}

export function resetPlanningOverlayRuntimeForTests(): void {
  planningOverlayRuntime.pendingRunId = null;
  planningOverlayRuntime.pendingCwd = null;
  planningOverlayRuntime.dismissedRunIds.clear();
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getPlanningUpdateAgeMs(cwd: string, nowMs: number = Date.now()): number | null {
  if (!isPlanningForCwd(cwd)) return null;
  const updatedMs = parseIsoMs(planningState.updatedAt);
  if (updatedMs === null) return null;
  return Math.max(0, nowMs - updatedMs);
}

export function isPlanningStalled(
  cwd: string,
  nowMs: number = Date.now(),
  staleAfterMs: number = PLANNING_STALE_TIMEOUT_MS,
): boolean {
  if (!isPlanningForCwd(cwd)) return false;
  const ageMs = getPlanningUpdateAgeMs(cwd, nowMs);
  if (ageMs === null) return true;
  return ageMs >= Math.max(1, staleAfterMs);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let planningCancelled = false;

export function cancelPlanningRun(cwd: string): void {
  planningCancelled = true;
  clearPlanningState(cwd);
}

export function isPlanningCancelled(): boolean {
  return planningCancelled;
}

export function resetPlanningCancellation(): void {
  planningCancelled = false;
}

function planningStatePath(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "crew", "planning-state.json");
}

function persistPlanningState(cwd: string): void {
  const filePath = planningStatePath(cwd);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(planningState, null, 2));
  } catch {}
}

export function startPlanningRun(cwd: string, maxPasses: number): void {
  planningCancelled = false;
  const normalizedCwd = normalizeCwd(cwd);
  planningState.active = true;
  planningState.cwd = normalizedCwd;
  planningState.pid = process.pid;
  planningState.runId = randomUUID();
  planningState.pass = 0;
  planningState.maxPasses = Math.max(1, maxPasses);
  planningState.phase = "read-prd";
  planningState.updatedAt = new Date().toISOString();
  persistPlanningState(normalizedCwd);
  markPlanningOverlayPending(normalizedCwd);
}

export function setPlanningPhase(cwd: string, phase: PlanningPhase, pass?: number): void {
  if (planningCancelled) return;
  const normalizedCwd = normalizeCwd(cwd);
  planningState.active = true;
  planningState.cwd = normalizedCwd;
  if (!planningState.runId) planningState.runId = randomUUID();
  planningState.phase = phase;
  if (pass !== undefined) planningState.pass = pass;
  planningState.updatedAt = new Date().toISOString();
  persistPlanningState(normalizedCwd);
}

export function finishPlanningRun(cwd: string, status: "completed" | "failed", pass?: number): void {
  if (planningCancelled) return;
  const normalizedCwd = normalizeCwd(cwd);
  clearPlanningOverlayPending();
  planningState.active = false;
  planningState.cwd = normalizedCwd;
  planningState.runId = null;
  planningState.phase = status;
  if (pass !== undefined) planningState.pass = pass;
  planningState.updatedAt = new Date().toISOString();
  persistPlanningState(normalizedCwd);
}

export function clearPlanningState(cwd: string): void {
  const normalizedCwd = normalizeCwd(cwd);
  clearPlanningOverlayPending();
  planningState.active = false;
  planningState.cwd = normalizedCwd;
  planningState.runId = null;
  planningState.pass = 0;
  planningState.maxPasses = 0;
  planningState.phase = "idle";
  planningState.updatedAt = new Date().toISOString();
  planningState.pid = null;
  persistPlanningState(normalizedCwd);
}

export function restorePlanningState(cwd: string): { staleCleared: boolean } {
  const normalizedCwd = normalizeCwd(cwd);
  const filePath = planningStatePath(normalizedCwd);
  if (!fs.existsSync(filePath)) return { staleCleared: false };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PlanningState>;

    if (parsed.active) {
      const storedPid = typeof parsed.pid === "number" ? parsed.pid : null;
      if (!storedPid || !isProcessAlive(storedPid)) {
        clearPlanningState(normalizedCwd);
        return { staleCleared: true };
      }
    }

    planningState.active = parsed.active ?? false;
    planningState.cwd = normalizeCwd(parsed.cwd ?? normalizedCwd);
    planningState.runId = typeof parsed.runId === "string" ? parsed.runId : null;
    planningState.pass = Number(parsed.pass ?? 0);
    planningState.maxPasses = Number(parsed.maxPasses ?? 0);
    planningState.phase = parsed.phase ?? "idle";
    planningState.updatedAt = parsed.updatedAt ?? null;
    planningState.pid = typeof parsed.pid === "number" ? parsed.pid : null;

    const planningCwd = planningState.cwd;
    if (planningState.active && planningCwd && !planningState.runId) {
      planningState.runId = randomUUID();
      persistPlanningState(planningCwd);
    }

    return { staleCleared: false };
  } catch {
    return { staleCleared: false };
  }
}
