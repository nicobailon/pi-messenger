import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRegistration, Dirs, MessengerState } from "../lib.ts";
import {
  ARCHIVE_RETENTION_MS,
  findArchivedRegistrationBySessionId,
  getActiveAgents,
  invalidateAgentsCache,
  unregister,
} from "../store.ts";
import { executeWhois } from "../handlers.ts";

const roots = new Set<string>();

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-archive-test-"));
  roots.add(root);
  return root;
}

function createDirs(root: string): Dirs {
  const base = path.join(root, "messenger");
  const dirs: Dirs = {
    base,
    registry: path.join(base, "registry"),
    inbox: path.join(base, "inbox"),
  };
  fs.mkdirSync(dirs.registry, { recursive: true });
  fs.mkdirSync(dirs.inbox, { recursive: true });
  return dirs;
}

function archiveDir(dirs: Dirs): string {
  return path.join(dirs.base, "registry-archive");
}

// A pid no host will ever have: guaranteed dead for isProcessAlive().
const DEAD_PID = 999_999_999;

function writeRegistration(
  registryDir: string,
  name: string,
  cwd: string,
  opts: { pid?: number; sessionId?: string } = {}
): void {
  const registration: AgentRegistration = {
    name,
    pid: opts.pid ?? DEAD_PID,
    sessionId: opts.sessionId ?? `${name.toLowerCase()}-session`,
    cwd,
    model: "test-model",
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration, null, 2));
}

function whoisState(cwd: string): MessengerState {
  return {
    agentName: "Self",
    registered: true,
    cwd,
    scopeToFolder: false,
    reservations: [],
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    sessionStartedAt: new Date().toISOString(),
  } as unknown as MessengerState;
}

afterEach(() => {
  invalidateAgentsCache();
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("registry archive", () => {
  it("sweeps a stale live registration into the archive with endedAt and status ended", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const sessionId = "aaaaaaaa-1111-4111-8111-111111111111";
    writeRegistration(dirs.registry, "UltraTiger", root, { sessionId });

    const agents = getActiveAgents(whoisState(root), dirs);

    expect(agents.map(a => a.name)).toEqual([]);
    expect(fs.existsSync(path.join(dirs.registry, "UltraTiger.json"))).toBe(false);

    const archivedPath = path.join(archiveDir(dirs), "UltraTiger.json");
    expect(fs.existsSync(archivedPath)).toBe(true);
    const archived = JSON.parse(fs.readFileSync(archivedPath, "utf-8"));
    expect(archived.status).toBe("ended");
    expect(typeof archived.endedAt).toBe("number");
    expect(archived.sessionId).toBe(sessionId);
    expect(archived.name).toBe("UltraTiger");
  });

  it("getActiveAgents never reports archived agents while keeping live ones", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    writeRegistration(dirs.registry, "LivePeer", root, { pid: process.pid });
    writeRegistration(dirs.registry, "DeadPeer", root);

    const agents = getActiveAgents(whoisState(root), dirs);

    expect(agents.map(a => a.name)).toEqual(["LivePeer"]);
    expect(fs.existsSync(path.join(dirs.registry, "DeadPeer.json"))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir(dirs), "DeadPeer.json"))).toBe(true);
  });

  it("unregister archives the live registration instead of deleting it", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const state = whoisState(root);
    writeRegistration(dirs.registry, "Self", root, { pid: process.pid, sessionId: "self-session" });

    unregister(state, dirs);

    expect(state.registered).toBe(false);
    expect(fs.existsSync(path.join(dirs.registry, "Self.json"))).toBe(false);
    const archived = JSON.parse(fs.readFileSync(path.join(archiveDir(dirs), "Self.json"), "utf-8"));
    expect(archived.status).toBe("ended");
    expect(archived.endedAt).toBeGreaterThan(0);
    expect(archived.sessionId).toBe("self-session");
  });

  it("lazily sweeps archived registrations older than 14 days during registry reads", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const now = Date.now();
    fs.mkdirSync(archiveDir(dirs), { recursive: true });

    const expired = {
      name: "OldTimer",
      pid: DEAD_PID,
      sessionId: "old-session",
      cwd: root,
      startedAt: new Date(now - ARCHIVE_RETENTION_MS - 86_400_000).toISOString(),
      endedAt: now - ARCHIVE_RETENTION_MS - 1_000,
      status: "ended",
    };
    const fresh = {
      ...expired,
      name: "RecentTimer",
      sessionId: "recent-session",
      endedAt: now - 86_400_000,
    };
    fs.writeFileSync(path.join(archiveDir(dirs), "OldTimer.json"), JSON.stringify(expired));
    fs.writeFileSync(path.join(archiveDir(dirs), "RecentTimer.json"), JSON.stringify(fresh));

    getActiveAgents(whoisState(root), dirs);

    expect(fs.existsSync(path.join(archiveDir(dirs), "OldTimer.json"))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir(dirs), "RecentTimer.json"))).toBe(true);
  });
});

describe("whois by session UUID", () => {
  const LIVE_SESSION = "12345678-1234-4124-8124-123456789abc";
  const ENDED_SESSION = "87654321-4321-4143-8143-cba987654321";
  const UNKNOWN_SESSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  function setupAgents(dirs: Dirs, cwd: string): void {
    writeRegistration(dirs.registry, "LiveAgent", cwd, { pid: process.pid, sessionId: LIVE_SESSION });

    fs.mkdirSync(archiveDir(dirs), { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir(dirs), "EndedAgent.json"),
      JSON.stringify({
        name: "EndedAgent",
        pid: DEAD_PID,
        sessionId: ENDED_SESSION,
        cwd,
        model: "test-model",
        startedAt: new Date(Date.now() - 86_400_000).toISOString(),
        isHuman: false,
        session: { toolCalls: 3, tokens: 100, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
        endedAt: Date.now() - 43_200_000,
        status: "ended",
      }, null, 2)
    );
  }

  it("finds a live agent by sessionId", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    setupAgents(dirs, root);

    const outcome = executeWhois(whoisState(root), dirs, root, LIVE_SESSION);

    expect(outcome.details.error).toBeUndefined();
    expect(outcome.details.mode).toBe("whois");
    const agent = outcome.details.agent as AgentRegistration;
    expect(agent.name).toBe("LiveAgent");
    expect(agent.sessionId).toBe(LIVE_SESSION);
    expect(outcome.content[0]!.text).toContain("LiveAgent");
  });

  it("finds an ended agent in the archive and marks it ended", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    setupAgents(dirs, root);

    const outcome = executeWhois(whoisState(root), dirs, root, ENDED_SESSION);

    expect(outcome.details.error).toBeUndefined();
    const agent = outcome.details.agent as AgentRegistration & { status?: string; endedAt?: number };
    expect(agent.name).toBe("EndedAgent");
    expect(agent.status).toBe("ended");
    expect(typeof agent.endedAt).toBe("number");
    expect(agent.cwd).toBe(root);
    const text = outcome.content[0]!.text;
    expect(text).toContain("EndedAgent");
    expect(text).toContain("(ended)");
    expect(text).toContain("Session ID: " + ENDED_SESSION);
  });

  it("prefers the live registry over the archive", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    // Same sessionId in both live registry and archive: live wins.
    writeRegistration(dirs.registry, "Reborn", root, { pid: process.pid, sessionId: ENDED_SESSION });

    const outcome = executeWhois(whoisState(root), dirs, root, ENDED_SESSION);

    expect((outcome.details.agent as AgentRegistration).name).toBe("Reborn");
  });

  it("returns not_found only when live registry and archive both miss", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    setupAgents(dirs, root);

    const outcome = executeWhois(whoisState(root), dirs, root, UNKNOWN_SESSION);

    expect(outcome.details.error).toBe("not_found");
    expect(outcome.details.mode).toBe("whois");

    expect(findArchivedRegistrationBySessionId(dirs, ENDED_SESSION)?.name).toBe("EndedAgent");
  });

  it("still resolves plain names as before", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    setupAgents(dirs, root);

    const live = executeWhois(whoisState(root), dirs, root, "LiveAgent");
    expect((live.details.agent as AgentRegistration).name).toBe("LiveAgent");

    const missing = executeWhois(whoisState(root), dirs, root, "Nobody");
    expect(missing.details.error).toBe("not_found");
  });
});
