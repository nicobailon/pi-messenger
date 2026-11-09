import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateMemorableName, sessionNameSuffix, type AgentRegistration, type Dirs, type MessengerState } from "../lib.ts";
import { findAvailableName, invalidateAgentsCache, register } from "../store.ts";
import { createMockContext } from "./helpers/mock-context.ts";

const roots = new Set<string>();
const children: ReturnType<typeof spawn>[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-name-test-"));
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

/** Independent FNV-1a implementation to pin the suffix algorithm. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

afterEach(() => {
  invalidateAgentsCache();
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch {}
  }
  children.length = 0;
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("hash-suffixed agent names", () => {
  it("formats default-theme names as WordWord-<4 base36 chars>", () => {
    const name = generateMemorableName({ theme: "default" }, randomUUID());
    expect(name).toMatch(/^[A-Z][a-zA-Z]+[A-Z][a-zA-Z]+-[0-9a-z]{4}$/);
  });

  it("formats minimal-theme names as Word-<4 base36 chars>", () => {
    const name = generateMemorableName({ theme: "minimal" }, randomUUID());
    expect(name).toMatch(/^[A-Za-z]+-[0-9a-z]{4}$/);
  });

  it("suffix equals the first 4 chars of lowercase base36 of FNV-1a(sessionId)", () => {
    const sessionId = "0f0e8e6e-6d5a-4f9f-9f0f-9a1b2c3d4e5f";
    const name = generateMemorableName(undefined, sessionId);
    const expectedSuffix = fnv1a(sessionId).toString(36).padStart(4, "0").slice(0, 4);
    expect(name.endsWith("-" + expectedSuffix)).toBe(true);
    expect(sessionNameSuffix(sessionId)).toBe(expectedSuffix);
    expect(expectedSuffix).toMatch(/^[0-9a-z]{4}$/);
  });

  it("is deterministic: same sessionId produces the same name", () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const first = generateMemorableName({ theme: "default" }, sessionId);
    const second = generateMemorableName({ theme: "default" }, sessionId);
    const third = generateMemorableName({ theme: "nature" }, sessionId);
    expect(first).toBe(second);
    // Different themes pick different words but share the session-derived suffix.
    expect(first.endsWith("-" + sessionNameSuffix(sessionId))).toBe(true);
    expect(third.endsWith("-" + sessionNameSuffix(sessionId))).toBe(true);
  });

  it("distinct sessionIds produce distinct names", () => {
    const names = new Set<string>();
    for (let i = 0; i < 60; i++) {
      names.add(generateMemorableName({ theme: "default" }, randomUUID()));
    }
    expect(names.size).toBe(60);
  });

  it("leaves customWords untouched apart from the suffix", () => {
    const name = generateMemorableName(
      { theme: "custom", customWords: { adjectives: ["Zeta"], nouns: ["Quark"] } },
      "abcdefab-cdef-4abc-8def-001122334455"
    );
    expect(name).toMatch(/^ZetaQuark-[0-9a-z]{4}$/);
  });

  it("still produces legacy random names when no sessionId is provided", () => {
    const name = generateMemorableName({ theme: "default" });
    expect(name).toMatch(/^[A-Z][a-zA-Z]+[A-Z][a-zA-Z]+$/);
  });

  it("collision retry resolves on top of the suffixed name", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const sessionId = "99999999-8888-4777-8666-555544443333";
    const baseName = generateMemorableName({ theme: "default" }, sessionId);

    // Simulate a live agent holding that exact name: findAvailableName must retry.
    const holder = spawn("sleep", ["30"]);
    children.push(holder);
    fs.writeFileSync(
      path.join(dirs.registry, `${baseName}.json`),
      JSON.stringify({ name: baseName, pid: holder.pid, sessionId: "someone-else" })
    );

    expect(findAvailableName(baseName, dirs)).toBe(`${baseName}2`);
  });

  it("register() derives the name from the session UUID and resolves collisions", () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const ctx = createMockContext(root);
    const sessionId = ctx.sessionManager.getSessionId();
    const predicted = generateMemorableName(undefined, sessionId);

    // Occupy the predicted name with a live process so the retry path kicks in.
    const holder = spawn("sleep", ["30"]);
    children.push(holder);
    fs.writeFileSync(
      path.join(dirs.registry, `${predicted}.json`),
      JSON.stringify({ name: predicted, pid: holder.pid, sessionId: "someone-else" })
    );

    const state: MessengerState = {
      agentName: "",
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
      cwd: root,
      scopeToFolder: false,
      isHuman: false,
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() },
      customStatus: false,
      registryFlushTimer: null,
      sessionStartedAt: new Date().toISOString(),
    };

    expect(register(state, dirs, ctx, { theme: "default" })).toBe(true);
    expect(state.agentName).toBe(`${predicted}2`);
    expect(state.agentName).toMatch(/^[A-Z][a-zA-Z]+[A-Z][a-zA-Z]+-[0-9a-z]{4}2$/);

    // The written registration keeps the full suffixed name and the session UUID.
    const written = JSON.parse(
      fs.readFileSync(path.join(dirs.registry, `${state.agentName}.json`), "utf-8")
    ) as AgentRegistration;
    expect(written.sessionId).toBe(sessionId);
    expect(written.name).toBe(`${predicted}2`);
  });
});
