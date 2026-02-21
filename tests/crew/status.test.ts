import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../crew/handlers/status.js";
import { createPlan, createTask, startTask } from "../../crew/store.js";
import { autonomousState, planningState, PLANNING_STALE_TIMEOUT_MS, startAutonomous, startPlanningRun, stopAutonomous } from "../../crew/state.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function resetPlanningState(): void {
  planningState.active = false;
  planningState.cwd = null;
  planningState.runId = null;
  planningState.pass = 0;
  planningState.maxPasses = 0;
  planningState.phase = "idle";
  planningState.updatedAt = null;
}

function resetAutonomousState(): void {
  autonomousState.active = false;
  autonomousState.cwd = null;
  autonomousState.waveNumber = 0;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = null;
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
  autonomousState.autoOverlayPending = false;
}

function writeCrewDependenciesConfig(cwd: string, dependencies: "advisory" | "strict"): void {
  const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ dependencies }, null, 2));
}

describe("crew.status planning health", () => {
  beforeEach(() => {
    resetPlanningState();
    resetAutonomousState();
  });

  it("shows planning next-step guidance instead of all-complete when no tasks exist", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");
    startPlanningRun(cwd, 2);

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("Planning is in progress.");
    expect(text).not.toContain("All tasks complete!");

    resetPlanningState();
  });

  it("shows stalled planning health when update age exceeds timeout", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");
    startPlanningRun(cwd, 3);
    planningState.pass = 2;
    planningState.phase = "scan-code";
    planningState.updatedAt = new Date(Date.now() - PLANNING_STALE_TIMEOUT_MS - 30_000).toISOString();

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("Planning health:** stalled");
    expect(text).toContain("timeout 5m");

    const planning = response.details.planning as { stale: boolean };
    expect(planning.stale).toBe(true);

    resetPlanningState();
  });

  it("shows active planning health when updates are recent", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");
    startPlanningRun(cwd, 2);
    planningState.pass = 1;
    planningState.phase = "scan-code";
    planningState.updatedAt = new Date(Date.now() - 30_000).toISOString();

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("Planning health:** active");

    const planning = response.details.planning as { stale: boolean };
    expect(planning.stale).toBe(false);
  });

  it("shows no-tasks guidance when no tasks exist and planning is inactive", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("No tasks yet. Run `pi_messenger({ action: \"plan\" })`");
    expect(text).not.toContain("All tasks complete!");
  });

  it("does not show autonomous status when autonomous is active for a different cwd", async () => {
    const primary = createTempCrewDirs();
    const secondary = createTempCrewDirs();

    createPlan(primary.cwd, "README.md");
    createPlan(secondary.cwd, "README.md");
    startAutonomous(primary.cwd, 2);

    const response = await execute({ cwd: secondary.cwd } as any);
    const text = response.content[0].text;

    expect(text).not.toContain("## Autonomous Mode");
    expect(response.details.autonomous).toBe(false);

    stopAutonomous("manual");
  });

  it("shows autonomous status when autonomous is active for current cwd", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");
    startAutonomous(cwd, 2);

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("## Autonomous Mode");
    expect(response.details.autonomous).toBe(true);

    stopAutonomous("manual");
  });

  it("in advisory mode shows Available tasks with inline dependency annotations and no Waiting section", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");
    writeCrewDependenciesConfig(cwd, "advisory");

    const dep = createTask(cwd, "Types and Config");
    const task = createTask(cwd, "Formatter", "Desc", [dep.id]);
    startTask(cwd, dep.id, "HappyWolf");

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("⬜ **Available**");
    expect(text).toContain(`${task.id}: Formatter (needs: ${dep.id} ⟳)`);
    expect(text).not.toContain("⏸️ **Waiting** (dependencies not met)");
  });

  it("in strict mode preserves Ready and Waiting sections", async () => {
    const { cwd } = createTempCrewDirs();
    createPlan(cwd, "README.md");
    writeCrewDependenciesConfig(cwd, "strict");

    const dep = createTask(cwd, "Types and Config");
    createTask(cwd, "Formatter", "Desc", [dep.id]);

    const response = await execute({ cwd } as any);
    const text = response.content[0].text;

    expect(text).toContain("⬜ **Ready**");
    expect(text).toContain("⏸️ **Waiting** (dependencies not met)");
  });
});
