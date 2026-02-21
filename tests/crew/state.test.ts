import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addWaveResult,
  adjustConcurrency,
  autonomousState,
  cancelPlanningRun,
  clearPlanningState,
  consumePendingAutoWork,
  consumePlanningOverlayPending,
  dismissPlanningOverlayRun,
  finishPlanningRun,
  getPlanningOverlayPending,
  getPlanningUpdateAgeMs,
  isAutonomousForCwd,
  isPendingAutoWork,
  isPlanningCancelled,
  isPlanningForCwd,
  isPlanningStalled,
  markPlanningOverlayPending,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  planningState,
  PLANNING_STALE_TIMEOUT_MS,
  resetPlanningCancellation,
  resetPlanningOverlayRuntimeForTests,
  restoreAutonomousState,
  restorePlanningState,
  setPendingAutoWork,
  setPlanningPhase,
  startAutonomous,
  startPlanningRun,
  stopAutonomous,
} from "../../crew/state.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function resetAutonomousState(): void {
  autonomousState.active = false;
  autonomousState.cwd = null;
  autonomousState.waveNumber = 0;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = null;
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
  autonomousState.concurrency = 2;
  autonomousState.autoOverlayPending = false;
}

function resetPlanningState(): void {
  planningState.active = false;
  planningState.cwd = null;
  planningState.runId = null;
  planningState.pass = 0;
  planningState.maxPasses = 0;
  planningState.phase = "idle";
  planningState.updatedAt = null;
  planningState.pid = null;
}

describe("crew/state", () => {
  beforeEach(() => {
    resetAutonomousState();
    resetPlanningState();
    resetPlanningCancellation();
    resetPlanningOverlayRuntimeForTests();
  });

  it("startAutonomous initializes state and marks active", () => {
    startAutonomous("/tmp/project-a", 2);

    expect(autonomousState.active).toBe(true);
    expect(autonomousState.cwd).toBe("/tmp/project-a");
    expect(autonomousState.waveNumber).toBe(1);
    expect(autonomousState.waveHistory).toEqual([]);
    expect(autonomousState.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(autonomousState.stoppedAt).toBeNull();
    expect(autonomousState.stopReason).toBeNull();
    expect(autonomousState.autoOverlayPending).toBe(true);
  });

  it("stopAutonomous marks inactive and records reason/timestamp", () => {
    startAutonomous("/tmp/project-a", 2);
    stopAutonomous("manual");

    expect(autonomousState.active).toBe(false);
    expect(autonomousState.stopReason).toBe("manual");
    expect(autonomousState.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(autonomousState.autoOverlayPending).toBe(false);
  });

  it("addWaveResult appends history and increments waveNumber", () => {
    startAutonomous("/tmp/project-a", 2);

    addWaveResult({
      waveNumber: 1,
      tasksAttempted: ["task-1"],
      succeeded: ["task-1"],
      failed: [],
      blocked: [],
      timestamp: new Date().toISOString(),
    });

    expect(autonomousState.waveHistory).toHaveLength(1);
    expect(autonomousState.waveHistory[0].waveNumber).toBe(1);
    expect(autonomousState.waveNumber).toBe(2);
  });

  it("restoreAutonomousState applies partial persisted fields", () => {
    restoreAutonomousState({
      active: true,
      cwd: "/tmp/project-b",
      waveNumber: 7,
      stopReason: "blocked",
    });

    expect(autonomousState.active).toBe(true);
    expect(autonomousState.cwd).toBe("/tmp/project-b");
    expect(autonomousState.waveNumber).toBe(7);
    expect(autonomousState.stopReason).toBe("blocked");
  });

  it("supports full transition sequence start -> waves -> stop -> restore", () => {
    startAutonomous("/tmp/project-c", 2);
    addWaveResult({
      waveNumber: 1,
      tasksAttempted: ["task-1", "task-2"],
      succeeded: ["task-1"],
      failed: ["task-2"],
      blocked: [],
      timestamp: new Date().toISOString(),
    });
    addWaveResult({
      waveNumber: 2,
      tasksAttempted: ["task-2"],
      succeeded: ["task-2"],
      failed: [],
      blocked: [],
      timestamp: new Date().toISOString(),
    });
    stopAutonomous("completed");

    const snapshot = {
      active: autonomousState.active,
      cwd: autonomousState.cwd,
      waveNumber: autonomousState.waveNumber,
      waveHistory: [...autonomousState.waveHistory],
      startedAt: autonomousState.startedAt,
      stoppedAt: autonomousState.stoppedAt,
      stopReason: autonomousState.stopReason,
    };

    resetAutonomousState();
    restoreAutonomousState(snapshot);

    expect(autonomousState.active).toBe(false);
    expect(autonomousState.cwd).toBe("/tmp/project-c");
    expect(autonomousState.waveNumber).toBe(3);
    expect(autonomousState.waveHistory).toHaveLength(2);
    expect(autonomousState.stopReason).toBe("completed");
    expect(autonomousState.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(autonomousState.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("adjustConcurrency increments/decrements and clamps to bounds", () => {
    autonomousState.concurrency = 2;
    expect(adjustConcurrency(2)).toBe(4);
    expect(adjustConcurrency(-1)).toBe(3);
    expect(adjustConcurrency(999)).toBe(MAX_CONCURRENCY);
    expect(adjustConcurrency(-999)).toBe(MIN_CONCURRENCY);
  });

  it("adjustConcurrency does not go below MIN_CONCURRENCY", () => {
    autonomousState.concurrency = MIN_CONCURRENCY;
    expect(adjustConcurrency(-1)).toBe(MIN_CONCURRENCY);
  });

  it("adjustConcurrency does not go above MAX_CONCURRENCY", () => {
    autonomousState.concurrency = MAX_CONCURRENCY;
    expect(adjustConcurrency(1)).toBe(MAX_CONCURRENCY);
  });

  it("waitForConcurrencyChange resolves when adjustConcurrency is called", async () => {
    const { waitForConcurrencyChange } = await import("../../crew/state.js");
    autonomousState.concurrency = 3;
    const promise = waitForConcurrencyChange();
    adjustConcurrency(1);
    await promise;
    expect(autonomousState.concurrency).toBe(4);
  });

  it("waitForConcurrencyChange second call replaces first (single-waiter)", async () => {
    const { waitForConcurrencyChange } = await import("../../crew/state.js");
    autonomousState.concurrency = 3;
    const first = waitForConcurrencyChange();
    const second = waitForConcurrencyChange();
    adjustConcurrency(1);
    await second;
    expect(autonomousState.concurrency).toBe(4);
    const raceResult = await Promise.race([
      first.then(() => "resolved"),
      new Promise(r => setTimeout(() => r("timeout"), 50)),
    ]);
    expect(raceResult).toBe("timeout");
  });

  it("startAutonomous sets concurrency", () => {
    startAutonomous("/tmp/project-d", 4);
    expect(autonomousState.concurrency).toBe(4);
  });

  it("restoreAutonomousState restores concurrency", () => {
    restoreAutonomousState({ concurrency: 7 });
    expect(autonomousState.concurrency).toBe(7);
  });

  it("adjustConcurrency with delta 0 returns current value unchanged", () => {
    autonomousState.concurrency = 5;
    expect(adjustConcurrency(0)).toBe(5);
    expect(autonomousState.concurrency).toBe(5);
  });

  it("adjustConcurrency respects configMax", () => {
    autonomousState.concurrency = 3;
    expect(adjustConcurrency(1, 4)).toBe(4);
    expect(adjustConcurrency(1, 4)).toBe(4);
  });

  it("configMax cannot exceed MAX_CONCURRENCY", () => {
    autonomousState.concurrency = 9;
    expect(adjustConcurrency(5, 20)).toBe(MAX_CONCURRENCY);
  });

  it("restoreAutonomousState clamps out-of-range concurrency", () => {
    restoreAutonomousState({ concurrency: 0 });
    expect(autonomousState.concurrency).toBe(MIN_CONCURRENCY);

    restoreAutonomousState({ concurrency: -5 });
    expect(autonomousState.concurrency).toBe(MIN_CONCURRENCY);

    restoreAutonomousState({ concurrency: 999 });
    expect(autonomousState.concurrency).toBe(MAX_CONCURRENCY);
  });

  it("restoreAutonomousState handles non-finite concurrency as MIN_CONCURRENCY", () => {
    restoreAutonomousState({ concurrency: NaN });
    expect(autonomousState.concurrency).toBe(MIN_CONCURRENCY);

    restoreAutonomousState({ concurrency: Infinity });
    expect(autonomousState.concurrency).toBe(MIN_CONCURRENCY);
  });

  it("normalizes fractional concurrency values to whole-number bounds", () => {
    startAutonomous("/tmp/project-e", 2.9);
    expect(autonomousState.concurrency).toBe(2);

    restoreAutonomousState({ concurrency: 3.7 });
    expect(autonomousState.concurrency).toBe(3);
  });

  it("restoreAutonomousState does not restore autoOverlayPending", () => {
    restoreAutonomousState({ autoOverlayPending: true });
    expect(autonomousState.autoOverlayPending).toBe(false);
  });

  it("matches autonomous cwd across symlink and real path", () => {
    const { cwd } = createTempCrewDirs();
    const alias = `${cwd}-auto-alias`;
    fs.symlinkSync(cwd, alias, "dir");

    try {
      startAutonomous(alias, 2);

      expect(isAutonomousForCwd(cwd)).toBe(true);
      expect(isAutonomousForCwd(alias)).toBe(true);
      expect(autonomousState.cwd).toBe(fs.realpathSync.native(cwd));
    } finally {
      fs.rmSync(alias, { force: true, recursive: true });
    }
  });

  it("startPlanningRun initializes planning state and persists file", () => {
    const cwd = createTempCrewDirs().cwd;

    startPlanningRun(cwd, 3);

    expect(planningState.active).toBe(true);
    expect(planningState.cwd).toBe(fs.realpathSync.native(cwd));
    expect(planningState.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(planningState.pass).toBe(0);
    expect(planningState.maxPasses).toBe(3);
    expect(planningState.phase).toBe("read-prd");
    expect(planningState.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const filePath = path.join(cwd, ".pi", "messenger", "crew", "planning-state.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("setPlanningPhase updates pass/phase and finishPlanningRun marks inactive", () => {
    const cwd = createTempCrewDirs().cwd;

    startPlanningRun(cwd, 2);
    setPlanningPhase(cwd, "scan-code", 1);
    expect(planningState.phase).toBe("scan-code");
    expect(planningState.pass).toBe(1);

    finishPlanningRun(cwd, "completed", 2);
    expect(planningState.active).toBe(false);
    expect(planningState.runId).toBeNull();
    expect(planningState.phase).toBe("completed");
    expect(planningState.pass).toBe(2);
  });

  it("restorePlanningState reloads persisted planning state", () => {
    const cwd = createTempCrewDirs().cwd;

    startPlanningRun(cwd, 4);
    setPlanningPhase(cwd, "review-pass", 2);

    resetPlanningState();
    restorePlanningState(cwd);

    expect(planningState.active).toBe(true);
    expect(planningState.cwd).toBe(fs.realpathSync.native(cwd));
    expect(planningState.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(planningState.maxPasses).toBe(4);
    expect(planningState.pass).toBe(2);
    expect(planningState.phase).toBe("review-pass");
  });

  it("isPlanningStalled returns false for recent updates and true after timeout", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);

    const now = Date.now();
    planningState.updatedAt = new Date(now - 2_000).toISOString();
    expect(isPlanningStalled(cwd, now)).toBe(false);

    planningState.updatedAt = new Date(now - PLANNING_STALE_TIMEOUT_MS - 1_000).toISOString();
    expect(isPlanningStalled(cwd, now)).toBe(true);
  });

  it("isPlanningStalled treats missing or invalid updatedAt as stalled", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);

    planningState.updatedAt = null;
    expect(getPlanningUpdateAgeMs(cwd)).toBeNull();
    expect(isPlanningStalled(cwd)).toBe(true);

    planningState.updatedAt = "not-an-iso-date";
    expect(getPlanningUpdateAgeMs(cwd)).toBeNull();
    expect(isPlanningStalled(cwd)).toBe(true);
  });

  it("matches planning cwd across symlink and real path", () => {
    const { cwd } = createTempCrewDirs();
    const alias = `${cwd}-alias`;
    fs.symlinkSync(cwd, alias, "dir");

    try {
      startPlanningRun(alias, 2);

      expect(isPlanningForCwd(cwd)).toBe(true);
      expect(isPlanningForCwd(alias)).toBe(true);
    } finally {
      fs.rmSync(alias, { force: true, recursive: true });
    }
  });

  it("queues and consumes planning overlay pending for active planning run", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);

    const pending = getPlanningOverlayPending(cwd);
    expect(pending?.runId).toBe(planningState.runId);

    const consumed = consumePlanningOverlayPending(cwd);
    expect(consumed?.runId).toBe(planningState.runId);
    expect(getPlanningOverlayPending(cwd)).toBeNull();
  });

  it("does not re-queue dismissed planning run", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);

    const runId = planningState.runId;
    expect(runId).toBeTruthy();

    consumePlanningOverlayPending(cwd);
    dismissPlanningOverlayRun(runId!);
    markPlanningOverlayPending(cwd);

    expect(getPlanningOverlayPending(cwd)).toBeNull();
  });

  it("restores active planning run and backfills missing runId", () => {
    const cwd = createTempCrewDirs().cwd;
    const filePath = path.join(cwd, ".pi", "messenger", "crew", "planning-state.json");

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      active: true,
      cwd,
      pid: process.pid,
      pass: 1,
      maxPasses: 3,
      phase: "scan-code",
      updatedAt: new Date().toISOString(),
    }, null, 2));

    restorePlanningState(cwd);

    expect(planningState.active).toBe(true);
    expect(planningState.runId).toMatch(/^[0-9a-f-]{36}$/);

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { runId?: string };
    expect(persisted.runId).toBe(planningState.runId);
  });

  it("clearPlanningState marks planning as idle and persists", () => {
    const cwd = createTempCrewDirs().cwd;

    startPlanningRun(cwd, 2);
    clearPlanningState(cwd);

    expect(planningState.active).toBe(false);
    expect(planningState.runId).toBeNull();
    expect(planningState.phase).toBe("idle");
    expect(planningState.maxPasses).toBe(0);
    expect(planningState.pid).toBeNull();

    const persisted = fs.readFileSync(path.join(cwd, ".pi", "messenger", "crew", "planning-state.json"), "utf-8");
    expect(persisted).toContain('"phase": "idle"');
  });

  it("startPlanningRun stamps process.pid", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);
    expect(planningState.pid).toBe(process.pid);
  });

  it("restorePlanningState clears stale state when stored PID is dead", () => {
    const cwd = createTempCrewDirs().cwd;
    const filePath = path.join(cwd, ".pi", "messenger", "crew", "planning-state.json");

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      active: true,
      cwd,
      pid: 99999999,
      pass: 1,
      maxPasses: 3,
      phase: "scan-code",
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const { staleCleared } = restorePlanningState(cwd);

    expect(staleCleared).toBe(true);
    expect(planningState.active).toBe(false);
    expect(planningState.phase).toBe("idle");
  });

  it("restorePlanningState preserves state when stored PID is alive", () => {
    const cwd = createTempCrewDirs().cwd;

    startPlanningRun(cwd, 4);
    setPlanningPhase(cwd, "review-pass", 2);

    resetPlanningState();
    const { staleCleared } = restorePlanningState(cwd);

    expect(staleCleared).toBe(false);
    expect(planningState.active).toBe(true);
    expect(planningState.pid).toBe(process.pid);
  });

  it("restorePlanningState clears stale state when PID is missing", () => {
    const cwd = createTempCrewDirs().cwd;
    const filePath = path.join(cwd, ".pi", "messenger", "crew", "planning-state.json");

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      active: true,
      cwd,
      pass: 1,
      maxPasses: 3,
      phase: "scan-code",
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const { staleCleared } = restorePlanningState(cwd);

    expect(staleCleared).toBe(true);
    expect(planningState.active).toBe(false);
  });

  it("cancelPlanningRun sets cancelled flag and clears state", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);

    cancelPlanningRun(cwd);

    expect(isPlanningCancelled()).toBe(true);
    expect(planningState.active).toBe(false);
    expect(planningState.pid).toBeNull();
  });

  it("setPlanningPhase no-ops after cancellation", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);
    cancelPlanningRun(cwd);

    setPlanningPhase(cwd, "scan-code", 1);

    expect(planningState.active).toBe(false);
    expect(planningState.phase).toBe("idle");
  });

  it("finishPlanningRun no-ops after cancellation", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);
    cancelPlanningRun(cwd);

    finishPlanningRun(cwd, "completed", 2);

    expect(planningState.active).toBe(false);
    expect(planningState.phase).toBe("idle");
  });

  it("resetPlanningCancellation clears the flag", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);
    cancelPlanningRun(cwd);

    expect(isPlanningCancelled()).toBe(true);
    resetPlanningCancellation();
    expect(isPlanningCancelled()).toBe(false);
  });

  it("startPlanningRun resets cancellation flag", () => {
    const cwd = createTempCrewDirs().cwd;
    startPlanningRun(cwd, 2);
    cancelPlanningRun(cwd);
    expect(isPlanningCancelled()).toBe(true);

    startPlanningRun(cwd, 3);
    expect(isPlanningCancelled()).toBe(false);
  });
});

describe("pendingAutoWork", () => {
  beforeEach(() => {
    consumePendingAutoWork();
  });

  it("consumePendingAutoWork returns cwd and clears flag", () => {
    const cwd = createTempCrewDirs().cwd;
    expect(isPendingAutoWork()).toBe(false);
    expect(consumePendingAutoWork()).toBeNull();

    setPendingAutoWork(cwd);
    expect(isPendingAutoWork()).toBe(true);

    const consumed = consumePendingAutoWork();
    expect(consumed).not.toBeNull();
    expect(consumed!.cwd).toBe(fs.realpathSync.native(cwd));

    expect(isPendingAutoWork()).toBe(false);
    expect(consumePendingAutoWork()).toBeNull();
  });
});
