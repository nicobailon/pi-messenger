/**
 * Feed filter tests — executeFeed() with filter param
 *
 * FIX 4: Feed filter has zero test coverage
 */

import { describe, expect, it } from "vitest";
import { executeFeed } from "../../handlers.js";
import { appendFeedEvent } from "../../feed.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";

describe("executeFeed() filter param", () => {
  it("returns ONLY task.progress events when filter='task.progress'", () => {
    const { cwd } = createTempCrewDirs();

    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.progress", target: "task-1", progress: { percentage: 50, detail: "halfway" } });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.start", target: "task-1" });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.escalate", target: "task-1", escalation: { reason: "bad", severity: "warn" } });

    const result = executeFeed(cwd, 20, true, "task.progress");
    const events = (result.details as any).events as any[];

    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(e.type).toBe("task.progress");
    }
  });

  it("returns all events when filter is undefined", () => {
    const { cwd } = createTempCrewDirs();

    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.progress", target: "task-1", progress: { percentage: 25, detail: "started" } });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.start", target: "task-1" });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "helios", type: "join" });

    const result = executeFeed(cwd, 20, true, undefined);
    const events = (result.details as any).events as any[];

    expect(events).toHaveLength(3);
  });

  it("returns empty array when filter='task.escalate' and no escalate events exist", () => {
    const { cwd } = createTempCrewDirs();

    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.progress", target: "task-1", progress: { percentage: 50, detail: "halfway" } });
    appendFeedEvent(cwd, { ts: new Date().toISOString(), agent: "worker", type: "task.start", target: "task-1" });

    const result = executeFeed(cwd, 20, true, "task.escalate");
    const events = (result.details as any).events as any[];

    expect(events).toHaveLength(0);
  });
});
