import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessengerState } from "../../lib.js";
import * as store from "../../crew/store.js";
import * as taskHandler from "../../crew/handlers/task.js";
import { createMockContext } from "../helpers/mock-context.js";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";

function createState(agentName: string = "TestAgent"): MessengerState {
  return { agentName } as MessengerState;
}

function writeHandoffArtifact(cwd: string, taskId: string): void {
  const handoffPath = path.join(cwd, ".pi", "messenger", "crew", "artifacts", `${taskId}-handoff.md`);
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(handoffPath, `# Handoff for ${taskId}\n`);
}

describe("crew/task.done validation", () => {
  let dirs: TempCrewDirs;
  let cwd: string;
  let taskId: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Implement feature", "Desc");
    store.startTask(cwd, task.id, "WorkerA");
    taskId = task.id;
  });

  it("requires a non-empty summary", async () => {
    writeHandoffArtifact(cwd, taskId);

    const response = await taskHandler.execute(
      "done",
      {
        id: taskId,
        evidence: { commits: ["abc1234"], tests: ["npm test"] },
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.error).toBe("missing_summary");
    expect(response.content[0].text).toContain("summary required");
    expect(store.getTask(cwd, taskId)?.status).toBe("in_progress");
  });

  it("requires evidence.commits with at least one non-empty entry", async () => {
    writeHandoffArtifact(cwd, taskId);

    const response = await taskHandler.execute(
      "done",
      {
        id: taskId,
        summary: "Implemented feature",
        evidence: { commits: ["   "], tests: ["npm test"] },
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.error).toBe("missing_evidence_commits");
    expect(response.content[0].text).toContain("evidence.commits");
    expect(store.getTask(cwd, taskId)?.status).toBe("in_progress");
  });

  it("requires evidence.tests with at least one non-empty entry", async () => {
    writeHandoffArtifact(cwd, taskId);

    const response = await taskHandler.execute(
      "done",
      {
        id: taskId,
        summary: "Implemented feature",
        evidence: { commits: ["abc1234"], tests: ["   "] },
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.error).toBe("missing_evidence_tests");
    expect(response.content[0].text).toContain("evidence.tests");
    expect(store.getTask(cwd, taskId)?.status).toBe("in_progress");
  });

  it("requires the handoff artifact in crew artifacts", async () => {
    const response = await taskHandler.execute(
      "done",
      {
        id: taskId,
        summary: "Implemented feature",
        evidence: { commits: ["abc1234"], tests: ["npm test"] },
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.error).toBe("missing_handoff_artifact");
    expect(response.content[0].text).toContain(".pi/messenger/crew/artifacts");
    expect(store.getTask(cwd, taskId)?.status).toBe("in_progress");
  });

  it("completes task when summary, evidence, and handoff artifact are present", async () => {
    writeHandoffArtifact(cwd, taskId);

    const response = await taskHandler.execute(
      "done",
      {
        id: taskId,
        summary: "  Implemented feature end-to-end  ",
        evidence: { commits: ["abc1234"], tests: ["npm test"] },
      },
      createState("WorkerA"),
      createMockContext(cwd),
    );

    expect(response.details.mode).toBe("task.done");
    expect(response.details.task.status).toBe("pending_review");
    expect(response.details.task.summary).toBe("Implemented feature end-to-end");
    expect(store.getTask(cwd, taskId)?.status).toBe("pending_review");
  });
});

