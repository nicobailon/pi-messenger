import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";
import type { FeedEvent } from "../../feed.js";
import type { Task } from "../../crew/types.js";
import type { CrewConfig, CoordinationLevel } from "../../crew/utils/config.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock };
});

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeTask(tasksDir: string, task: Partial<Task> & { id: string }): void {
  const full: Task = {
    title: task.title ?? task.id,
    status: task.status ?? "done",
    depends_on: task.depends_on ?? [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attempt_count: 0,
    ...task,
  };
  writeJson(path.join(tasksDir, `${task.id}.json`), full);
}

function writeFeedEvents(cwd: string, events: FeedEvent[]): void {
  const feedPath = path.join(cwd, ".pi", "messenger", "feed.jsonl");
  fs.mkdirSync(path.dirname(feedPath), { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(feedPath, lines);
}

function makeEvent(ts: string, type: string, agent = "TestAgent", target?: string, preview?: string): FeedEvent {
  return { ts, agent, type: type as FeedEvent["type"], target, preview };
}

function makeConfig(level: CoordinationLevel, dependencies: CrewConfig["dependencies"] = "strict"): CrewConfig {
  return {
    concurrency: { workers: 2, max: 10 },
    truncation: {
      planners: { bytes: 204800, lines: 5000 },
      workers: { bytes: 204800, lines: 5000 },
      reviewers: { bytes: 102400, lines: 2000 },
      analysts: { bytes: 102400, lines: 2000 },
    },
    artifacts: { enabled: false, cleanupDays: 7 },
    memory: { enabled: false },
    planSync: { enabled: false },
    review: { enabled: true, maxIterations: 3 },
    planning: { maxPasses: 3 },
    work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false, shutdownGracePeriodMs: 30000 },
    dependencies,
    coordination: level,
    messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    depends_on: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attempt_count: 0,
    ...overrides,
  };
}

async function loadWorkModule() {
  vi.resetModules();
  return import("../../crew/handlers/work.js");
}

async function loadPromptModule() {
  vi.resetModules();
  return import("../../crew/prompt.js");
}

async function loadCoordinationModule() {
  vi.resetModules();
  return import("../../crew/handlers/coordination.js");
}

async function loadHandlersModule() {
  vi.resetModules();
  return import("../../handlers.js");
}

describe("buildDependencySection", () => {
  let dirs: TempCrewDirs;
  let buildDependencySection: typeof import("../../crew/handlers/coordination.js").buildDependencySection;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    const mod = await loadCoordinationModule();
    buildDependencySection = mod.buildDependencySection;
  });

  it("at minimal: shows dep IDs and titles, no summaries", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", summary: "Created types.ts" });
    writeTask(dirs.tasksDir, { id: "task-2", title: "Formatter", summary: "Created format.ts" });

    const task = makeTask("task-3", { depends_on: ["task-1", "task-2"] });
    const result = buildDependencySection(dirs.cwd, task, makeConfig("minimal"));

    expect(result).toContain("task-1: Types");
    expect(result).toContain("task-2: Formatter");
    expect(result).not.toContain("Created types.ts");
    expect(result).not.toContain("Created format.ts");
  });

  it("at moderate+: includes task.summary when available", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", summary: "Created types.ts with interfaces" });
    writeTask(dirs.tasksDir, { id: "task-2", title: "Formatter" });

    const task = makeTask("task-3", { depends_on: ["task-1", "task-2"] });
    const result = buildDependencySection(dirs.cwd, task, makeConfig("moderate"));

    expect(result).toContain("task-1 (Types): Created types.ts with interfaces");
    expect(result).toContain("task-2 (Formatter): (no summary)");
  });

  it("handles missing dep tasks gracefully", () => {
    const task = makeTask("task-3", { depends_on: ["task-1", "task-99"] });
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types" });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("minimal"));

    expect(result).toContain("task-1: Types");
    expect(result).toContain("- task-99");
  });

  it("in advisory mode renders done/in-progress/todo dependency states and non-blocking guidance", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types and Config", status: "done", summary: "Created types.ts with ObservationConfig" });
    writeTask(dirs.tasksDir, { id: "task-2", title: "Formatter", status: "in_progress", assigned_to: "HappyWolf" });
    writeTask(dirs.tasksDir, { id: "task-3", title: "Observer", status: "todo" });

    const task = makeTask("task-4", { depends_on: ["task-1", "task-2", "task-3"] });
    const result = buildDependencySection(dirs.cwd, task, makeConfig("moderate", "advisory"));

    expect(result).toContain("## Dependency Status");
    expect(result).toContain("✓ task-1 (Types and Config) — done. Created types.ts with ObservationConfig");
    expect(result).toContain("⟳ task-2 (Formatter) — in progress, worker: HappyWolf");
    expect(result).toContain("○ task-3 (Observer) — not yet started");
    expect(result).toContain("Do NOT block yourself because a dependency isn't done. Work around it.");
  });

  it("in advisory mode includes DM guidance when coordination is enabled", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", status: "in_progress", assigned_to: "OakBear" });
    const task = makeTask("task-2", { depends_on: ["task-1"] });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("minimal", "advisory"));
    expect(result).toContain("DM in-progress workers for API details they're building.");
  });

  it("in advisory mode excludes DM guidance when coordination is none", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", status: "in_progress", assigned_to: "OakBear" });
    const task = makeTask("task-2", { depends_on: ["task-1"] });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("none", "advisory"));
    expect(result).not.toContain("DM in-progress workers for API details they're building.");
  });

  it("in strict mode keeps existing completed-dependencies section", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", status: "done", summary: "Created types.ts" });
    const task = makeTask("task-2", { depends_on: ["task-1"] });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("moderate", "strict"));
    expect(result).toContain("## Dependencies");
    expect(result).toContain("Your task depends on these completed tasks:");
    expect(result).toContain("task-1 (Types): Created types.ts");
    expect(result).not.toContain("## Dependency Status");
    expect(result).not.toContain("Do NOT block yourself because a dependency isn't done.");
  });
});

describe("buildCoordinationContext", () => {
  let dirs: TempCrewDirs;
  let buildCoordinationContext: typeof import("../../crew/handlers/coordination.js").buildCoordinationContext;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    const mod = await loadCoordinationModule();
    buildCoordinationContext = mod.buildCoordinationContext;
  });

  it("with level none returns empty string", () => {
    const task = makeTask("task-1");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("none"), []);
    expect(result).toBe("");
  });

  it("with level minimal includes concurrent tasks but not recent activity or ready tasks", () => {
    const task = makeTask("task-1");
    const others = [makeTask("task-2", { title: "Formatter" }), makeTask("task-3", { title: "File Ops" })];

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-4", "Created observer.ts"),
    ]);

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("minimal"), others);

    expect(result).toContain("## Concurrent Tasks");
    expect(result).toContain("task-2: Formatter");
    expect(result).toContain("task-3: File Ops");
    expect(result).not.toContain("## Recent Activity");
    expect(result).not.toContain("## Ready Tasks");
  });

  it("with level moderate includes concurrent tasks and recent activity", () => {
    const task = makeTask("task-1");
    const others = [makeTask("task-2", { title: "Formatter" })];

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:12:00Z", "join", "OakBear"),
      makeEvent("2026-01-01T22:13:00Z", "task.start", "OakBear", "task-5", "Reflector"),
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-4", "Created observer.ts"),
    ]);

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), others);

    expect(result).toContain("## Concurrent Tasks");
    expect(result).toContain("## Recent Activity");
    expect(result).toContain("OakBear started task-5");
    expect(result).toContain("EpicGrove completed task-4");
    expect(result).not.toContain("OakBear" + " " + "join");
    expect(result).not.toContain("## Ready Tasks");
  });

  it("with level chatty includes concurrent tasks, recent activity, and ready tasks", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Formatter" });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "File Ops" });
    writeTask(dirs.tasksDir, { id: "task-6", status: "todo", title: "Entry Point", depends_on: ["task-1"] });

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-1", "Done"),
    ]);

    const task = makeTask("task-2", { title: "Formatter", depends_on: ["task-1"] });
    const others = [makeTask("task-3", { title: "File Ops" })];

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("chatty"), others);

    expect(result).toContain("## Concurrent Tasks");
    expect(result).toContain("## Recent Activity");
    expect(result).toContain("## Ready Tasks");
    expect(result).toContain("task-6: Entry Point");
  });

  it("omits concurrent tasks section when concurrentTasks is empty (solo task)", () => {
    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-1", "Done"),
    ]);

    const task = makeTask("task-2");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), []);

    expect(result).not.toContain("## Concurrent Tasks");
    expect(result).toContain("## Recent Activity");
  });

  it("chatty ready tasks excludes concurrent tasks", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Formatter", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "File Ops", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-4", status: "todo", title: "Observer", depends_on: ["task-1"] });

    const task = makeTask("task-2", { title: "Formatter", depends_on: ["task-1"] });
    const others = [makeTask("task-3", { title: "File Ops", depends_on: ["task-1"] })];

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("chatty"), others);

    expect(result).toContain("## Ready Tasks");
    expect(result).toContain("task-4: Observer");
    expect(result).not.toMatch(/Ready Tasks[\s\S]*task-2/);
    expect(result).not.toMatch(/Ready Tasks[\s\S]*task-3/);
  });

  it("filters out join/leave noise from recent activity", () => {
    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:10:00Z", "join", "Worker1"),
      makeEvent("2026-01-01T22:11:00Z", "task.start", "Worker1", "task-1", "Types"),
      makeEvent("2026-01-01T22:12:00Z", "leave", "Worker2"),
      makeEvent("2026-01-01T22:13:00Z", "task.done", "Worker1", "task-1", "Created types.ts"),
    ]);

    const task = makeTask("task-2");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), []);

    expect(result).toContain("Worker1 started task-1");
    expect(result).toContain("Worker1 completed task-1");
    expect(result).not.toContain("join");
    expect(result).not.toContain("leave");
  });

  it("formats message events in recent activity with direction indicators", () => {
    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:10:00Z", "task.start", "EpicGrove", "task-1", "Auth module"),
      { ...makeEvent("2026-01-01T22:11:00Z", "message", "EpicGrove"), target: "OakBear", preview: "Need User type from schema" },
      { ...makeEvent("2026-01-01T22:12:00Z", "message", "OakBear"), preview: "Completed task-2: schema.ts exports User, Session" },
    ]);

    const task = makeTask("task-3");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), []);

    expect(result).toContain("EpicGrove → OakBear: Need User type from schema");
    expect(result).toContain("OakBear ✦ Completed task-2");
    expect(result).not.toContain("said");
  });
});

describe("buildCoordinationInstructions", () => {
  let buildCoordinationInstructions: typeof import("../../crew/handlers/coordination.js").buildCoordinationInstructions;

  beforeEach(async () => {
    homedirMock.mockReturnValue("/tmp/pi-test-noop");
    const mod = await loadCoordinationModule();
    buildCoordinationInstructions = mod.buildCoordinationInstructions;
  });

  it("returns empty for none", () => {
    expect(buildCoordinationInstructions(makeConfig("none"))).toBe("");
  });

  it("minimal includes reservation checking and budget", () => {
    const result = buildCoordinationInstructions(makeConfig("minimal"));
    expect(result).toContain("## Coordination");
    expect(result).toContain("Message budget: 2 messages");
    expect(result).toContain('action: "list"');
    expect(result).toContain('action: "send"');
    expect(result).not.toContain("broadcast");
  });

  it("moderate uses action: broadcast for announcements", () => {
    const result = buildCoordinationInstructions(makeConfig("moderate"));
    expect(result).toContain("Message budget: 5 messages");
    expect(result).toContain('action: "broadcast"');
    expect(result).toContain("### Announce yourself");
    expect(result).toContain("### On completion");
    expect(result).toContain("### Reservations");
    expect(result).toContain("### Questions about dependencies");
    expect(result).not.toContain("### Claim next task");
    expect(result).not.toContain("### Coordinate with peers");
    expect(result).not.toContain("### Responding to messages");
  });

  it("includes the configured message budget in instructions", () => {
    const config = makeConfig("moderate");
    config.messageBudgets = { none: 0, minimal: 3, moderate: 8, chatty: 15 };
    const result = buildCoordinationInstructions(config);
    expect(result).toContain("Message budget: 8 messages");
  });

  it("chatty includes DM coordination, message responsiveness, and claim next task", () => {
    const result = buildCoordinationInstructions(makeConfig("chatty"));
    expect(result).toContain("### Coordinate with peers");
    expect(result).toContain("### Responding to messages");
    expect(result).toContain("### Claim next task");
    expect(result).toContain("Message budget:");
    expect(result).toContain('action: "send"');
    expect(result).toContain('action: "task.ready"');
    expect(result).toContain("task.start");
    expect(result).toContain("### Questions about dependencies");
  });
});

describe("config coordination", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("default config has coordination: chatty with message budgets", async () => {
    const { loadCrewConfig } = await (async () => { vi.resetModules(); return import("../../crew/utils/config.js"); })();
    const cfg = loadCrewConfig(dirs.crewDir);
    expect(cfg.coordination).toBe("chatty");
    expect(cfg.messageBudgets).toEqual({ none: 0, minimal: 2, moderate: 5, chatty: 10 });
  });

  it("respects coordination field from project config", async () => {
    writeJson(path.join(dirs.crewDir, "config.json"), { coordination: "minimal" });
    const { loadCrewConfig } = await (async () => { vi.resetModules(); return import("../../crew/utils/config.js"); })();
    const cfg = loadCrewConfig(dirs.crewDir);
    expect(cfg.coordination).toBe("minimal");
  });
});

describe("buildWorkerPrompt integration", () => {
  let dirs: TempCrewDirs;
  let buildWorkerPrompt: typeof import("../../crew/prompt.js").buildWorkerPrompt;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    const mod = await loadPromptModule();
    buildWorkerPrompt = mod.buildWorkerPrompt;
  });

  it("at chatty level: enriched deps, concurrent tasks, recent activity, ready tasks, coordination instructions in correct order", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done", title: "Types", summary: "Created types.ts" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Formatter", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "File Ops", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-6", status: "todo", title: "Entry Point", depends_on: ["task-1"] });

    fs.writeFileSync(path.join(dirs.tasksDir, "task-2.md"), "Build the formatter module");

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-1", "Done"),
    ]);

    const task = makeTask("task-2", { title: "Formatter", depends_on: ["task-1"] });
    const others = [makeTask("task-3", { title: "File Ops", depends_on: ["task-1"] })];
    const config = makeConfig("chatty");

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", dirs.cwd, config, others);

    // Check all sections present
    expect(prompt).toContain("# Task Assignment");
    expect(prompt).toContain("## Dependencies");
    expect(prompt).toContain("task-1 (Types): Created types.ts");
    expect(prompt).toContain("## Concurrent Tasks");
    expect(prompt).toContain("task-3: File Ops");
    expect(prompt).toContain("## Recent Activity");
    expect(prompt).toContain("## Ready Tasks");
    expect(prompt).toContain("task-6: Entry Point");
    expect(prompt).toContain("## Task Specification");
    expect(prompt).toContain("## Coordination");
    expect(prompt).toContain("### Announce yourself");
    expect(prompt).toContain("### Coordinate with peers");
    expect(prompt).toContain("### Responding to messages");
    expect(prompt).toContain("### Claim next task");

    // Verify ordering: Dependencies before Task Specification, Coordination at end
    const depsIdx = prompt.indexOf("## Dependencies");
    const concurrentIdx = prompt.indexOf("## Concurrent Tasks");
    const specIdx = prompt.indexOf("## Task Specification");
    const coordIdx = prompt.indexOf("## Coordination");

    expect(depsIdx).toBeLessThan(concurrentIdx);
    expect(concurrentIdx).toBeLessThan(specIdx);
    expect(specIdx).toBeLessThan(coordIdx);
  });
});

describe("executeSend broadcast filtering", () => {
  let dirs: TempCrewDirs;
  let executeSend: typeof import("../../handlers.js").executeSend;
  let storeModule: typeof import("../../store.js");
  let feedModule: typeof import("../../feed.js");
  let messageDirs: { base: string; registry: string; inbox: string };
  let state: { registered: boolean; agentName: string };

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);

    const handlers = await loadHandlersModule();
    storeModule = await import("../../store.js");
    feedModule = await import("../../feed.js");
    executeSend = handlers.executeSend;

    messageDirs = {
      base: path.join(dirs.cwd, ".pi", "messenger"),
      registry: path.join(dirs.cwd, ".pi", "messenger", "registry"),
      inbox: path.join(dirs.cwd, ".pi", "messenger", "inbox"),
    };
    fs.mkdirSync(messageDirs.registry, { recursive: true });
    fs.mkdirSync(messageDirs.inbox, { recursive: true });

    state = { registered: true, agentName: "EpicGrove" };

    vi.spyOn(storeModule, "getActiveAgents").mockReturnValue([
      { name: "OakBear" } as any,
      { name: "PineFox" } as any,
    ]);
    vi.spyOn(storeModule, "validateTargetAgent").mockReturnValue({ valid: true });
    vi.spyOn(storeModule, "sendMessageToAgent").mockImplementation(() => ({
      id: "msg-id",
      from: "EpicGrove",
      to: "OakBear",
      text: "placeholder",
      timestamp: new Date().toISOString(),
      replyTo: null,
    }));
    vi.spyOn(feedModule, "logFeedEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.PI_CREW_WORKER;
    vi.restoreAllMocks();
  });

  it("worker broadcast logs to feed only", () => {
    process.env.PI_CREW_WORKER = "1";

    const result = executeSend(
      state as any,
      messageDirs as any,
      dirs.cwd,
      undefined,
      true,
      "Worker update"
    );

    expect(result.content[0]?.text).toContain("Broadcast logged");
    expect(storeModule.sendMessageToAgent).not.toHaveBeenCalled();
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      dirs.cwd,
      "EpicGrove",
      "message",
      undefined,
      "Worker update",
    );
  });

  it("non-worker broadcast delivers to inbox recipients", () => {
    delete process.env.PI_CREW_WORKER;

    executeSend(
      state as any,
      messageDirs as any,
      dirs.cwd,
      undefined,
      true,
      "Team-wide update"
    );

    expect(storeModule.sendMessageToAgent).toHaveBeenCalledTimes(2);
    expect(storeModule.sendMessageToAgent).toHaveBeenCalledWith(
      state,
      messageDirs,
      "OakBear",
      "Team-wide update",
      undefined,
    );
    expect(storeModule.sendMessageToAgent).toHaveBeenCalledWith(
      state,
      messageDirs,
      "PineFox",
      "Team-wide update",
      undefined,
    );
  });

  it("worker direct message still delivers", () => {
    process.env.PI_CREW_WORKER = "1";

    executeSend(
      state as any,
      messageDirs as any,
      dirs.cwd,
      "OakBear",
      undefined,
      "Need your input"
    );

    expect(storeModule.sendMessageToAgent).toHaveBeenCalledTimes(1);
    expect(storeModule.sendMessageToAgent).toHaveBeenCalledWith(
      state,
      messageDirs,
      "OakBear",
      "Need your input",
      undefined,
    );
  });

  it("worker broadcast increments message budget usage", () => {
    process.env.PI_CREW_WORKER = "1";
    writeJson(path.join(dirs.crewDir, "config.json"), {
      coordination: "chatty",
      messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 1 },
    });

    const first = executeSend(
      state as any,
      messageDirs as any,
      dirs.cwd,
      undefined,
      true,
      "First broadcast"
    );
    const second = executeSend(
      state as any,
      messageDirs as any,
      dirs.cwd,
      undefined,
      true,
      "Second broadcast"
    );

    expect(first.content[0]?.text).toContain("Broadcast logged");
    expect(first.content[0]?.text).toContain("(0 messages remaining)");
    expect(second.content[0]?.text).toContain("Message budget reached (1/1");
  });
});
