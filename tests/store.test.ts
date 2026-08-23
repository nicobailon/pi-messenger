import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRegistration, Dirs, MessengerState } from "../lib.ts";
import { getActiveAgents, invalidateAgentsCache, processAllPendingMessages, register } from "../store.ts";

const roots = new Set<string>();
const initialCwd = process.cwd();

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-store-test-"));
  roots.add(root);
  return root;
}

function createDirs(root: string): Dirs {
  const base = path.join(root, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function createState(scopeToFolder: boolean, cwd: string = process.cwd()): MessengerState {
  return {
    agentName: "Self",
    cwd,
    scopeToFolder,
  } as MessengerState;
}

function createRegisterState(cwd: string): MessengerState {
  return {
    agentName: "Self",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "",
    cwd,
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

function writeRegistration(registryDir: string, name: string, cwd: string): void {
  const registration: AgentRegistration = {
    name,
    pid: process.pid,
    sessionId: "session-1",
    cwd,
    model: "test-model",
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration));
}

afterEach(() => {
  invalidateAgentsCache();
  process.chdir(initialCwd);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("store.getActiveAgents cwd scoping", () => {
  it("matches scoped agents using canonical cwd", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const actualProject = path.join(root, "project");
    const aliasProject = path.join(root, "project-alias");

    fs.mkdirSync(actualProject, { recursive: true });
    fs.symlinkSync(actualProject, aliasProject, "dir");

    writeRegistration(dirs.registry, "Peer", actualProject);

    process.chdir(aliasProject);
    const agents = getActiveAgents(createState(true, aliasProject), dirs);

    expect(agents.map(agent => agent.name)).toEqual(["Peer"]);
  });

  it("uses state.cwd instead of process.cwd for scoped agent matching", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    writeRegistration(dirs.registry, "PeerA", projectA);
    writeRegistration(dirs.registry, "PeerB", projectB);

    process.chdir(projectB);
    const agents = getActiveAgents(createState(true, projectA), dirs);

    expect(agents.map(agent => agent.name)).toEqual(["PeerA"]);
  });

  it("registers the session using ctx.cwd instead of process.cwd", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    process.chdir(projectB);
    const state = createRegisterState(projectA);
    const ctx = {
      cwd: projectA,
      hasUI: false,
      model: { id: "test-model" },
      sessionManager: { getSessionId: () => "session-1" },
    } as any;

    expect(register(state, dirs, ctx)).toBe(true);

    const expectedCwd = fs.realpathSync.native(projectA);
    const registration = JSON.parse(fs.readFileSync(path.join(dirs.registry, "Self.json"), "utf-8")) as AgentRegistration;
    expect(registration.cwd).toBe(expectedCwd);
    expect(state.cwd).toBe(expectedCwd);
  });
});

describe("store.processAllPendingMessages", () => {
  it("normalizes message and ts fields before delivery", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const inbox = path.join(dirs.inbox, "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const timestamp = "2026-08-23T12:00:00.000Z";
    fs.writeFileSync(path.join(inbox, "1.json"), JSON.stringify({
      from: "Peer",
      to: "Self",
      message: "Historical body",
      ts: timestamp,
      replyTo: 123,
    }));

    const delivered: Array<{ text: string; timestamp: string }> = [];

    processAllPendingMessages(
      { agentName: "Self", registered: true } as MessengerState,
      dirs,
      msg => delivered.push(msg),
    );

    expect(delivered).toEqual([
      {
        id: "1",
        from: "Peer",
        to: "Self",
        text: "Historical body",
        timestamp,
        replyTo: null,
      },
    ]);
    expect(fs.readdirSync(inbox)).toEqual([]);
  });
});
