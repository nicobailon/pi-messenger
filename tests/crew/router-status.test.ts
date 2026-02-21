import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MessengerState, Dirs } from "../../lib.js";
import { executeCrewAction } from "../../crew/index.js";
import { createTempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

function createTestState(agentName: string): MessengerState {
  return {
    agentName,
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test-model",
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };
}

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

describe("crew action router status behavior", () => {
  it("routes action=status to messenger status (not crew status)", async () => {
    const { cwd } = createTempCrewDirs();
    const state = createTestState("AgentOne");
    const dirs = createDirs(cwd);
    const ctx = createMockContext(cwd);

    const response = await executeCrewAction(
      "status",
      {},
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    const text = response.content[0].text;
    expect(text).toContain("You: AgentOne");
    expect(text).not.toContain("# Crew Status");
  });

  it("routes action=crew.status to crew status handler", async () => {
    const { cwd } = createTempCrewDirs();
    const state = createTestState("AgentOne");
    const dirs = createDirs(cwd);
    const ctx = createMockContext(cwd);

    const response = await executeCrewAction(
      "crew.status",
      {},
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    const text = response.content[0].text;
    expect(text).toContain("# Crew Status");
  });
});
