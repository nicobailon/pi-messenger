/**
 * task-13: task.progress structured API + task.escalate behavior
 *
 * Tests:
 *   - task.progress structured: percentage validation, feed event, progress-log append
 *   - task.progress legacy: backward compat
 *   - task.escalate: feed event, progress-log append, block on block/critical severity
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../crew/handlers/task.js";
import * as store from "../../crew/store.js";
import { readFeedEvents } from "../../feed.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

function makeState(agentName = "TestAgent") {
  return { agentName, config: {} } as any;
}

function makeCtx(cwd: string) {
  return { cwd, ui: { notify: () => {} } } as any;
}

// ─── task.progress ───────────────────────────────────────────────────────────

describe("task.progress structured API", () => {
  it("rejects percentage below 0", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    const result = await execute("progress", { id: task.id, percentage: -1, detail: "bad" }, makeState(), makeCtx(cwd));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Error");
    expect(text).toContain("percentage");
  });

  it("rejects percentage above 100", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    const result = await execute("progress", { id: task.id, percentage: 101, detail: "too high" }, makeState(), makeCtx(cwd));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Error");
    expect(text).toContain("percentage");
  });

  it("requires both percentage and detail (missing detail)", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");

    const result = await execute("progress", { id: task.id, percentage: 50 }, makeState(), makeCtx(cwd));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Error");
  });

  it("emits a task.progress feed event on valid structured call", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("progress", { id: task.id, percentage: 50, detail: "Halfway done" }, makeState(), makeCtx(cwd));

    const events = readFeedEvents(cwd, 10);
    const progressEvents = events.filter(e => e.type === "task.progress");
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].target).toBe(task.id);
    expect(progressEvents[0].progress?.percentage).toBe(50);
    expect(progressEvents[0].progress?.detail).toBe("Halfway done");
  });

  it("appends a progress-log entry on valid structured call", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("progress", { id: task.id, percentage: 75, detail: "Almost there", phase: "testing" }, makeState(), makeCtx(cwd));

    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).not.toBeNull();
    expect(progress).toContain("75%");
    expect(progress).toContain("Almost there");
  });

  it("includes phase in the progress-log entry when provided", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("progress", { id: task.id, percentage: 25, detail: "Starting work", phase: "impl" }, makeState("DevBot"), makeCtx(cwd));

    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).not.toBeNull();
    expect(progress).toContain("impl");
    expect(progress).toContain("25%");
  });

  it("returns success result with percentage, detail, and phase", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    const result = await execute("progress", { id: task.id, percentage: 50, detail: "Midway", phase: "review" }, makeState(), makeCtx(cwd));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("50%");
    expect(text).toContain("review");
    expect(text).toContain("Midway");
  });
});

describe("task.progress legacy message API (backward compat)", () => {
  it("logs a message to the progress file with legacy API", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("progress", { id: task.id, message: "Started implementing the thing" }, makeState(), makeCtx(cwd));

    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).not.toBeNull();
    expect(progress).toContain("Started implementing the thing");
  });

  it("does not require percentage or detail when using message", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    const result = await execute("progress", { id: task.id, message: "Legacy progress" }, makeState(), makeCtx(cwd));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Progress logged");
    expect(text).not.toContain("Error");
  });
});

// ─── task.escalate ───────────────────────────────────────────────────────────

describe("task.escalate", () => {
  it("emits a task.escalate feed event", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "API is down", severity: "warn" }, makeState(), makeCtx(cwd));

    const events = readFeedEvents(cwd, 10);
    const escalateEvents = events.filter(e => e.type === "task.escalate");
    expect(escalateEvents).toHaveLength(1);
    expect(escalateEvents[0].target).toBe(task.id);
    expect(escalateEvents[0].escalation?.severity).toBe("warn");
    expect(escalateEvents[0].escalation?.reason).toBe("API is down");
  });

  it("appends a progress-log entry when escalating", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Missing dependency", severity: "warn" }, makeState(), makeCtx(cwd));

    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).not.toBeNull();
    expect(progress).toContain("escalate");
    expect(progress).toContain("warn");
    expect(progress).toContain("Missing dependency");
  });

  it("does NOT block the task for severity=warn", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Minor issue", severity: "warn" }, makeState(), makeCtx(cwd));

    const updated = store.getTask(cwd, task.id);
    expect(updated?.status).toBe("in_progress");
  });

  it("marks the task as blocked for severity=block", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Build server is down", severity: "block" }, makeState(), makeCtx(cwd));

    const updated = store.getTask(cwd, task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blocked_reason).toBe("Build server is down");
  });

  it("marks the task as blocked for severity=critical", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Data corruption detected", severity: "critical" }, makeState(), makeCtx(cwd));

    const updated = store.getTask(cwd, task.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.blocked_reason).toBe("Data corruption detected");
  });

  it("appends escalation to progress-log for severity=block", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "DB unreachable", severity: "block", suggestion: "retry after 1h" }, makeState(), makeCtx(cwd));

    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).not.toBeNull();
    expect(progress).toContain("block");
    expect(progress).toContain("DB unreachable");
  });

  it("includes suggestion in the progress-log entry", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Needs human review", severity: "warn", suggestion: "ping the team" }, makeState(), makeCtx(cwd));

    const progress = store.getTaskProgress(cwd, task.id);
    expect(progress).toContain("ping the team");
  });

  it("pushes an inbox message to helios for severity=block", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Build server down", severity: "block", suggestion: "retry later" }, makeState(), makeCtx(cwd));

    const inboxDir = path.join(cwd, ".pi", "messenger", "inbox", "helios");
    expect(fs.existsSync(inboxDir)).toBe(true);

    const inboxFiles = fs.readdirSync(inboxDir).filter(f => f.includes("escalate-") && f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, inboxFiles[0]), "utf-8"));
    expect(msg.type).toBe("task.escalate");
    expect(msg.taskId).toBe(task.id);
    expect(msg.severity).toBe("block");
    expect(msg.reason).toBe("Build server down");
    expect(msg.suggestion).toBe("retry later");
  });

  it("pushes an inbox message to helios for severity=critical", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Data corruption", severity: "critical" }, makeState(), makeCtx(cwd));

    const inboxDir = path.join(cwd, ".pi", "messenger", "inbox", "helios");
    expect(fs.existsSync(inboxDir)).toBe(true);

    const inboxFiles = fs.readdirSync(inboxDir).filter(f => f.includes("escalate-") && f.endsWith(".json"));
    expect(inboxFiles.length).toBe(1);

    const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, inboxFiles[0]), "utf-8"));
    expect(msg.severity).toBe("critical");
  });

  it("does NOT push inbox message to helios for severity=warn", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");
    store.startTask(cwd, task.id, "TestAgent");

    await execute("escalate", { id: task.id, reason: "Minor warning", severity: "warn" }, makeState(), makeCtx(cwd));

    const inboxDir = path.join(cwd, ".pi", "messenger", "inbox", "helios");
    const inboxExists = fs.existsSync(inboxDir);
    if (inboxExists) {
      const inboxFiles = fs.readdirSync(inboxDir).filter(f => f.includes("escalate-") && f.endsWith(".json"));
      expect(inboxFiles.length).toBe(0);
    } else {
      expect(inboxExists).toBe(false);
    }
  });

  it("rejects invalid severity values", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "My Task");

    const result = await execute("escalate", { id: task.id, reason: "test", severity: "urgent" as any }, makeState(), makeCtx(cwd));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Error");
    expect(text).toContain("severity");
  });
});
