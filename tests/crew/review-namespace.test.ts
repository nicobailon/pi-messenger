import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

vi.mock("../../crew/agents.js", () => ({
  spawnAgents: vi.fn(),
}));

function writeReviewerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-reviewer.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-reviewer
description: Test reviewer
crewRole: reviewer
---
You are a reviewer.
`);
}

describe("crew/review namespacing", () => {
  let reviewHandler: typeof import("../../crew/handlers/review.js");
  let store: typeof import("../../crew/store.js");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let cwd: string;
  let taskId: string;

  beforeEach(async () => {
    vi.resetModules();
    reviewHandler = await import("../../crew/handlers/review.js");
    store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    writeReviewerAgent(cwd);
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "PRD.md"), "# PRD\nReview test");
    store.createPlan(cwd, "docs/PRD.md");
    taskId = store.createTask(cwd, "Task to review", "spec").id;
    store.updateTask(cwd, taskId, { status: "done", base_commit: "HEAD~1" });
  });

  it("uses namespaced reviewer task ID when namespace is provided", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: "## Verdict: SHIP\nLooks good.",
      error: null,
    }] as any);

    await reviewHandler.execute(
      { action: "review", target: taskId, crew: "alpha" } as any,
      createMockContext(cwd),
    );

    expect(spawnAgents.mock.calls[0][0][0].taskId).toBe("alpha::__reviewer__");
  });

  it("keeps shared reviewer task ID by default", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: "## Verdict: SHIP\nLooks good.",
      error: null,
    }] as any);

    await reviewHandler.execute(
      { action: "review", target: taskId } as any,
      createMockContext(cwd),
    );

    expect(spawnAgents.mock.calls[0][0][0].taskId).toBe("__reviewer__");
  });
});
