import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  loadRegistry,
  saveRegistry,
  classifyTask,
  recordTaskOutcome,
  getBestAgent,
  getRoutingSuggestions,
  type SpecializationRegistry,
  type TaskType,
  type AgentPerformance,
} from "../../crew/specialization.js";

// Override the store path for tests
const TEST_DIR = path.join(os.tmpdir(), `specialization-test-${Date.now()}`);
const TEST_FILE = path.join(TEST_DIR, "specialization-registry.json");

beforeEach(() => {
  process.env.PI_SPECIALIZATION_FILE = TEST_FILE;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.PI_SPECIALIZATION_FILE;
});

describe("crew/specialization", () => {
  describe("classifyTask", () => {
    it("classifies implementation tasks", () => {
      expect(classifyTask("Implement user auth")).toBe("implementation");
      expect(classifyTask("Create login form")).toBe("implementation");
      expect(classifyTask("Build the API gateway")).toBe("implementation");
      expect(classifyTask("Add caching layer")).toBe("implementation");
    });

    it("classifies review tasks", () => {
      expect(classifyTask("Review PR #42")).toBe("review");
      expect(classifyTask("Audit security headers")).toBe("review");
      expect(classifyTask("Check code quality")).toBe("review");
    });

    it("classifies testing tasks", () => {
      expect(classifyTask("Test login flow")).toBe("testing");
      expect(classifyTask("Validate input parsing")).toBe("testing");
    });

    it("classifies planning tasks", () => {
      expect(classifyTask("Plan sprint 5")).toBe("planning");
      expect(classifyTask("Design database schema")).toBe("planning");
      expect(classifyTask("Architecture review")).toBe("planning");
    });

    it("classifies research tasks", () => {
      expect(classifyTask("Research OAuth providers")).toBe("research");
      expect(classifyTask("Investigate memory leak")).toBe("research");
      expect(classifyTask("Explore caching strategies")).toBe("research");
    });

    it("classifies verification tasks", () => {
      expect(classifyTask("Verify deployment")).toBe("verification");
      expect(classifyTask("Trace data flow")).toBe("verification");
      expect(classifyTask("Confirm rollback works")).toBe("verification");
    });

    it("returns 'other' for unrecognized tasks", () => {
      expect(classifyTask("")).toBe("other");
      expect(classifyTask("Hello world")).toBe("other");
    });

    it("uses content for classification when title is ambiguous", () => {
      expect(classifyTask("Task 1", "implement the caching layer")).toBe("implementation");
      expect(classifyTask("Task 2", "review the pull request")).toBe("review");
    });

    it("is case-insensitive", () => {
      expect(classifyTask("IMPLEMENT auth")).toBe("implementation");
      expect(classifyTask("REVIEW code")).toBe("review");
    });
  });

  describe("loadRegistry / saveRegistry", () => {
    it("returns empty registry when file does not exist", () => {
      const registry = loadRegistry();
      expect(registry.taskTypes).toEqual({});
      expect(registry.lastUpdated).toBeDefined();
    });

    it("persists and loads registry", () => {
      const registry: SpecializationRegistry = {
        taskTypes: {
          implementation: {
            agents: {
              "claude-sonnet": {
                attempts: 5,
                successes: 4,
                failures: 1,
                avgDurationMs: 30000,
                score: 80,
              },
            },
          },
        },
        lastUpdated: new Date().toISOString(),
      };
      saveRegistry(registry);
      const loaded = loadRegistry();
      expect(loaded.taskTypes.implementation?.agents["claude-sonnet"].score).toBe(80);
    });

    it("creates directory if it doesn't exist", () => {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
      saveRegistry({ taskTypes: {}, lastUpdated: new Date().toISOString() });
      expect(fs.existsSync(TEST_FILE)).toBe(true);
    });
  });

  describe("recordTaskOutcome", () => {
    it("creates new agent record on first outcome", () => {
      recordTaskOutcome("claude-sonnet", "implementation", true, 30000);
      const registry = loadRegistry();
      const perf = registry.taskTypes.implementation?.agents["claude-sonnet"];
      expect(perf).toBeDefined();
      expect(perf!.attempts).toBe(1);
      expect(perf!.successes).toBe(1);
      expect(perf!.failures).toBe(0);
      expect(perf!.avgDurationMs).toBe(30000);
      expect(perf!.score).toBe(100);
    });

    it("records failure correctly", () => {
      recordTaskOutcome("gpt-4", "review", false, 10000);
      const registry = loadRegistry();
      const perf = registry.taskTypes.review?.agents["gpt-4"];
      expect(perf!.attempts).toBe(1);
      expect(perf!.successes).toBe(0);
      expect(perf!.failures).toBe(1);
      expect(perf!.score).toBe(0);
    });

    it("calculates score correctly over multiple outcomes", () => {
      recordTaskOutcome("agent-x", "testing", true, 10000);
      recordTaskOutcome("agent-x", "testing", true, 20000);
      recordTaskOutcome("agent-x", "testing", true, 30000);
      recordTaskOutcome("agent-x", "testing", false, 40000);
      const registry = loadRegistry();
      const perf = registry.taskTypes.testing?.agents["agent-x"];
      expect(perf!.attempts).toBe(4);
      expect(perf!.successes).toBe(3);
      expect(perf!.failures).toBe(1);
      expect(perf!.score).toBe(75);
    });

    it("calculates running average duration", () => {
      recordTaskOutcome("agent-y", "planning", true, 10000);
      recordTaskOutcome("agent-y", "planning", true, 30000);
      const registry = loadRegistry();
      const perf = registry.taskTypes.planning?.agents["agent-y"];
      expect(perf!.avgDurationMs).toBe(20000);
    });

    it("persists to disk after each call", () => {
      recordTaskOutcome("persist-agent", "research", true, 5000);
      // Load fresh
      const registry = loadRegistry();
      expect(registry.taskTypes.research?.agents["persist-agent"]).toBeDefined();
    });

    it("updates lastUpdated timestamp", () => {
      const before = new Date().toISOString();
      recordTaskOutcome("time-agent", "other", true, 1000);
      const after = new Date().toISOString();
      const registry = loadRegistry();
      expect(registry.lastUpdated >= before).toBe(true);
      expect(registry.lastUpdated <= after).toBe(true);
    });
  });

  describe("getBestAgent", () => {
    it("returns null when no agents recorded for task type", () => {
      expect(getBestAgent("implementation")).toBeNull();
    });

    it("returns highest-scoring agent", () => {
      recordTaskOutcome("agent-a", "implementation", true, 10000);
      recordTaskOutcome("agent-a", "implementation", true, 10000);
      recordTaskOutcome("agent-a", "implementation", false, 10000);
      // agent-a: 66.67%

      recordTaskOutcome("agent-b", "implementation", true, 10000);
      recordTaskOutcome("agent-b", "implementation", true, 10000);
      recordTaskOutcome("agent-b", "implementation", true, 10000);
      // agent-b: 100%

      const best = getBestAgent("implementation");
      expect(best).not.toBeNull();
      expect(best!.agent).toBe("agent-b");
      expect(best!.score).toBe(100);
    });

    it("returns null when task type has no entries", () => {
      recordTaskOutcome("agent-a", "implementation", true, 10000);
      expect(getBestAgent("review")).toBeNull();
    });
  });

  describe("getRoutingSuggestions", () => {
    it("returns empty array when no agents for task type", () => {
      expect(getRoutingSuggestions("verification")).toEqual([]);
    });

    it("filters agents with fewer than 3 attempts", () => {
      recordTaskOutcome("agent-a", "review", true, 10000);
      recordTaskOutcome("agent-a", "review", true, 10000);
      // Only 2 attempts — should be excluded
      expect(getRoutingSuggestions("review")).toEqual([]);
    });

    it("includes agents with 3+ attempts", () => {
      recordTaskOutcome("agent-a", "testing", true, 10000);
      recordTaskOutcome("agent-a", "testing", true, 10000);
      recordTaskOutcome("agent-a", "testing", true, 10000);
      const suggestions = getRoutingSuggestions("testing");
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].agent).toBe("agent-a");
      expect(suggestions[0].score).toBe(100);
      expect(suggestions[0].attempts).toBe(3);
    });

    it("sorts by score descending", () => {
      // agent-a: 2/3 successes = 66.67
      recordTaskOutcome("agent-a", "planning", true, 10000);
      recordTaskOutcome("agent-a", "planning", true, 10000);
      recordTaskOutcome("agent-a", "planning", false, 10000);

      // agent-b: 3/3 successes = 100
      recordTaskOutcome("agent-b", "planning", true, 10000);
      recordTaskOutcome("agent-b", "planning", true, 10000);
      recordTaskOutcome("agent-b", "planning", true, 10000);

      // agent-c: 1/3 successes = 33.33
      recordTaskOutcome("agent-c", "planning", true, 10000);
      recordTaskOutcome("agent-c", "planning", false, 10000);
      recordTaskOutcome("agent-c", "planning", false, 10000);

      const suggestions = getRoutingSuggestions("planning");
      expect(suggestions).toHaveLength(3);
      expect(suggestions[0].agent).toBe("agent-b");
      expect(suggestions[1].agent).toBe("agent-a");
      expect(suggestions[2].agent).toBe("agent-c");
    });
  });

  describe("persistence round-trip", () => {
    it("survives save/load cycle with multiple task types and agents", () => {
      recordTaskOutcome("agent-1", "implementation", true, 10000);
      recordTaskOutcome("agent-1", "review", false, 5000);
      recordTaskOutcome("agent-2", "implementation", true, 20000);

      const registry = loadRegistry();
      expect(registry.taskTypes.implementation?.agents["agent-1"]).toBeDefined();
      expect(registry.taskTypes.implementation?.agents["agent-2"]).toBeDefined();
      expect(registry.taskTypes.review?.agents["agent-1"]).toBeDefined();
    });
  });
});
