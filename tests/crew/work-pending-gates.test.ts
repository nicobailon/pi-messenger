import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

vi.mock("../../crew/agents.js", () => ({
  resolveModel: vi.fn(() => undefined),
  resolveModelForTaskRole: vi.fn(() => undefined),
  selectCrewAgentForRole: vi.fn((agents: any[]) => agents[0]),
  spawnAgents: vi.fn(() => Promise.resolve([])),
}));

describe("crew/work pending gate accounting", () => {
  let workHandler: typeof import("../../crew/handlers/work.js");
  let store: typeof import("../../crew/store.js");
  let stateMod: typeof import("../../crew/state.js");
  let cwd: string;

  beforeEach(async () => {
    vi.resetModules();
    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store = await import("../../crew/store.js");
    stateMod = await import("../../crew/state.js");
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Gate pending task", "Desc");
    store.updateTask(cwd, task.id, { status: "pending_review" as any });
    workHandler = await import("../../crew/handlers/work.js");
    stateMod.startAutonomous(cwd, 1);
  });

  it("does not stop autonomous as blocked when tasks are pending review/integration", async () => {
    const appendEntry = vi.fn();
    const response = await workHandler.execute({ action: "work", autonomous: true } as any, { registry: `${cwd}/.pi/messenger/registry`, inbox: `${cwd}/.pi/messenger/inbox` } as any, createMockContext(cwd), appendEntry);
    expect(response.details.reason).not.toContain("blocked");
    expect(stateMod.autonomousState.stopReason).toBeNull();
    expect(appendEntry).toHaveBeenCalledWith("crew_wave_continue", expect.objectContaining({ pendingGateTasks: ["task-1"] }));
  });
});
